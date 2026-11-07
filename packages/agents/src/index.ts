import { randomUUID, createHash } from 'node:crypto';
import { isRequestId, isProjectEvent, WorkbenchError, type ProviderAdapter, type ProviderId, type OpenSession, type SessionRef, type TurnRef, type AgentEvent, type ApprovalAnswer, type ApprovalRequest, type AttachmentRef, type DisplayMessage, type OperationStatus, type SessionSnapshot } from '@robotics-workbench/contracts';
import { assertSafeAgentText, validateContextPacket, type ContextPacket } from '@robotics-workbench/application';

export interface AgentTask {
  schemaVersion: 1; taskId: string; projectId: string; projectRevision: number; sourceSnapshotId: string | null;
  providerId: ProviderId; providerSessionId: string | null; status: OperationStatus; contextPacketId: string;
  operationIds: string[]; changeSetIds: string[]; unresolvedQuestions: string[];
}
export interface AgentRecord {
  kind: 'agent-task'; schemaVersion: 1; task: AgentTask; open: OpenSession; turn: TurnRef | null;
  requestDigest: string; packet: ContextPacket; userText: string; messages: DisplayMessage[];
  requiredChecks: string[]; checks: Record<string, 'passed' | 'failed' | 'not-run'>;
  pendingApprovals: ApprovalRequest[]; events: AgentEvent[]; seenEventIds: string[]; deltaKeys: string[];
  providerOutcome: OperationStatus | null; lastProblem: string | null; createdAt: string; updatedAt: string;
  reconciliations: { reconciliationId: string; observedAt: string; snapshot: SessionSnapshot }[];
}
export interface AgentCheckpoint {
  kind: 'agent-checkpoint'; schemaVersion: 1; checkpointId: string; taskId: string; projectId: string;
  projectRevision: number; sourceSnapshotId: string | null; createdAt: string;
  goal: string; decisions: string[]; completed: { summary: string; evidenceRefs: string[] }[];
  remaining: string[]; unknowns: string[]; activeOperationIds: string[]; providerSessionRef: SessionRef | null;
}
export interface AgentStore {
  get(taskId: string, projectId: string): AgentRecord | undefined;
  list(projectId: string): AgentRecord[];
  put(record: AgentRecord): void;
  putCheckpoint(checkpoint: AgentCheckpoint): void;
}
export interface CurrentAgentProject { projectRevision: number; sourceSnapshotId: string | null; workspaceUri: string }
export interface StartAgentTask {
  providerId: ProviderId; taskId: string; clientTurnId: string; open: OpenSession; packet: ContextPacket; userText: string;
  attachments: AttachmentRef[]; requiredChecks?: string[];
}
const terminal = new Set<OperationStatus>(['succeeded', 'failed', 'cancelled', 'outcome-unknown']);
const clone = <T>(value: T): T => structuredClone(value);
const now = () => new Date().toISOString();
function invalid(message: string, code = 'INVALID_REQUEST'): never { throw new WorkbenchError(code, message); }
function id(value: unknown): asserts value is string { if (!isRequestId(value)) invalid('Expected a UUID.'); }
function text(value: unknown, max: number): asserts value is string { if (typeof value !== 'string' || !value.length || value.length > max) invalid('Invalid bounded text.'); }
function sessionMatches(a: SessionRef, b: SessionRef): boolean {
  return a.providerId === b.providerId && a.projectId === b.projectId && a.taskId === b.taskId && a.providerSessionId === b.providerSessionId && a.workspaceUri === b.workspaceUri;
}
function turnMatches(a: TurnRef, b: TurnRef): boolean { return a.clientTurnId === b.clientTurnId && sessionMatches(a.session, b.session) && (!a.providerTurnId || !b.providerTurnId || a.providerTurnId === b.providerTurnId); }
function assertSession(value: SessionRef, open: OpenSession, providerId: ProviderId): void {
  if (!value || value.providerId !== providerId || value.projectId !== open.projectId || value.taskId !== open.taskId || value.workspaceUri !== open.workspaceUri) invalid('Provider session belongs to another project or workspace.', 'WORKSPACE_MISMATCH');
  text(value.providerSessionId, 512);
}
function checkStart(input: StartAgentTask): void {
  id(input.taskId); id(input.clientTurnId); id(input.open?.projectId); id(input.open?.taskId); id(input.open?.routeId);
  if (input.open.taskId !== input.taskId || !Number.isSafeInteger(input.open.projectRevision) || input.open.projectRevision < 1) invalid('Invalid task admission.');
  text(input.userText, 32768); assertSafeAgentText(input.userText);
  if (Buffer.byteLength(input.userText) > 65536) invalid('User message exceeds the presentation byte limit; use an artifact attachment.');
  text(input.open.model?.modelId, 256); text(input.open.permissionProfileId, 256);
  let workspace: URL;
  try { workspace = new URL(input.open.workspaceUri); } catch { invalid('Expected a canonical file URI.'); }
  if (workspace.protocol !== 'file:' || workspace.search || workspace.hash || workspace.username || workspace.password) invalid('Expected a canonical file URI.');
  const packet = validateContextPacket(input.packet);
  if (packet.projectId !== input.open.projectId || packet.projectRevision !== input.open.projectRevision) invalid('Context belongs to another project revision.', 'REVISION_CONFLICT');
  if (!Array.isArray(input.attachments) || input.attachments.length > 16) invalid('Too many attachments.');
  for (const attachment of input.attachments) {
    id(attachment.artifactId); text(attachment.displayName, 256); text(attachment.mediaType, 128);
    if (!/^[a-f0-9]{64}$/.test(attachment.sha256) || !Number.isSafeInteger(attachment.byteLength) || attachment.byteLength < 0) invalid('Invalid attachment.');
  }
  if (input.requiredChecks && (input.requiredChecks.length > 32 || new Set(input.requiredChecks).size !== input.requiredChecks.length)) invalid('Invalid acceptance checks.');
  for (const check of input.requiredChecks ?? []) text(check, 128);
}
/** Persists admission before transport; adapter acknowledgement never proves hardware success. */
export class AgentRuntime {
  private readonly admitting = new Set<string>();
  constructor(private readonly adapters: Partial<Record<ProviderId, ProviderAdapter>>, private readonly store: AgentStore, private readonly current: (projectId: string) => CurrentAgentProject) {}
  private adapter(providerId: ProviderId): ProviderAdapter {
    const adapter = this.adapters[providerId];
    if (!adapter) invalid('This persisted task reader has no provider connection.', 'PROVIDER_UNSUPPORTED');
    return adapter;
  }
  get(taskId: string, projectId: string): AgentRecord {
    id(taskId); id(projectId);
    const record = this.store.get(taskId, projectId);
    if (!record || record.kind !== 'agent-task' || record.task.projectId !== projectId || record.task.taskId !== taskId) invalid('Task is unavailable in this project.', 'UNAUTHORIZED_SCOPE');
    return clone(record);
  }
  private save(record: AgentRecord): AgentRecord {
    record.updatedAt = now();
    if (Buffer.byteLength(JSON.stringify(record)) > 768 * 1024) invalid('Agent presentation record exceeds its storage budget; retain evidence and start a bounded continuation.');
    this.store.put(clone(record)); return clone(record);
  }
  private assertCurrent(record: Pick<AgentRecord, 'task' | 'open'>): void {
    const current = this.current(record.task.projectId);
    if (current.workspaceUri !== record.open.workspaceUri) invalid('Workspace moved; reconcile before mutation.', 'WORKSPACE_MISMATCH');
    if (current.projectRevision !== record.task.projectRevision || current.sourceSnapshotId !== record.task.sourceSnapshotId) invalid('Project or source changed; prepare current context.', 'REVISION_CONFLICT');
  }
  async start(input: StartAgentTask): Promise<AgentRecord> {
    checkStart(input);
    const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const prior = this.store.get(input.taskId, input.open.projectId);
    if (prior) {
      if (prior.requestDigest !== digest) invalid('Task ID is already bound to another request.');
      return clone(prior);
    }
    if (this.admitting.has(input.open.projectId) || this.store.list(input.open.projectId).some(record => !terminal.has(record.task.status) || record.task.status === 'outcome-unknown' && !record.reconciliations.some(item => !item.snapshot.activeTurn && item.snapshot.connection === 'connected' && item.snapshot.pendingApprovals.length === 0 && item.snapshot.latestTurnStatus !== null && terminal.has(item.snapshot.latestTurnStatus)))) invalid('Another writer requires completion or reconciliation.', 'PROJECT_BUSY');
    const record: AgentRecord = { kind: 'agent-task', schemaVersion: 1,
      task: { schemaVersion: 1, taskId: input.taskId, projectId: input.open.projectId, projectRevision: input.open.projectRevision, sourceSnapshotId: input.packet.sourceSnapshotId, providerId: 'codex', providerSessionId: null, status: 'queued', contextPacketId: input.packet.packetId, operationIds: [], changeSetIds: [], unresolvedQuestions: [...input.packet.unknowns] },
      open: clone(input.open), turn: null, requestDigest: digest, packet: validateContextPacket(input.packet), userText: input.userText, messages: [], requiredChecks: input.requiredChecks ?? [], checks: {}, pendingApprovals: [], events: [], seenEventIds: [], deltaKeys: [], providerOutcome: null, lastProblem: null, createdAt: now(), updatedAt: now(), reconciliations: [] };
    // The selected adapter is explicit; no authentication/rate-limit fallback is attempted.
    const providerId = input.providerId;
    if (providerId !== 'codex' && providerId !== 'opencode') invalid('Select a provider explicitly.');
    if (input.open.resume && input.open.resume.providerId !== providerId) invalid('Resume belongs to another provider.', 'WORKSPACE_MISMATCH');
    record.task.providerId = providerId;
    this.assertCurrent(record);
    this.admitting.add(record.task.projectId);
    try {
      const adapter = this.adapter(providerId);
      const descriptor = await adapter.inspect();
      if (descriptor.providerId !== providerId || descriptor.readiness !== 'ready') invalid('Selected provider is not ready.', 'PROVIDER_UNSUPPORTED');
      if (input.attachments.some(item => item.mediaType.startsWith('image/')) && !descriptor.capabilities.includes('images')) invalid('Selected provider cannot accept image attachments.', 'CAPABILITY_UNSUPPORTED');
      if (input.open.resume && !descriptor.capabilities.includes('resume')) invalid('Selected provider cannot resume sessions.', 'CAPABILITY_UNSUPPORTED');
      this.save(record);
      try {
        const session = await adapter.open(clone(input.open));
        assertSession(session, record.open, providerId);
        record.task.providerSessionId = session.providerSessionId;
        record.turn = { clientTurnId: input.clientTurnId, session, providerTurnId: null };
        this.assertCurrent(record);
        record.task.status = 'running'; this.save(record);
        const turn = await adapter.submit({ clientTurnId: input.clientTurnId, session, projectRevision: record.task.projectRevision, sourceSnapshotId: record.task.sourceSnapshotId, userText: input.userText, contextPacketId: record.packet.packetId, attachments: clone(input.attachments), model: clone(input.open.model) });
        if (!turnMatches(record.turn, turn)) invalid('Provider returned an unrelated turn.', 'PROTOCOL_ERROR');
        record.turn = clone(turn);
        record.messages.push({ messageId: input.clientTurnId, role: 'user', text: input.userText, artifactRef: null, complete: true });
        return this.save(record);
      } catch (error) {
        record.task.status = record.task.status === 'running' ? 'outcome-unknown' : 'failed';
        record.lastProblem = error instanceof WorkbenchError ? error.code : 'TRANSPORT_LOST';
        this.save(record); throw error;
      }
    } finally { this.admitting.delete(record.task.projectId); }
  }
  ingest(taskId: string, projectId: string, value: AgentEvent): AgentRecord {
    const record = this.get(taskId, projectId);
    if (!isProjectEvent(value) || !value.type.startsWith('agent.') || value.projectId !== projectId || value.projectRevision !== record.task.projectRevision) invalid('Agent event has an invalid scope or envelope.', 'PROTOCOL_ERROR');
    const event = clone(value);
    assertSafeAgentText(JSON.stringify(event));
    if (record.seenEventIds.includes(event.eventId)) return record;
    if (record.seenEventIds.length >= 4096) invalid('Turn event limit reached; reconcile presentation.', 'PROTOCOL_ERROR');
    const payload = event.payload;
    const session = 'session' in payload ? payload.session : 'approval' in payload ? payload.approval?.turn?.session : 'turn' in payload ? payload.turn?.session : null;
    if (!session || !record.turn || !sessionMatches(session, record.turn.session)) invalid('Event belongs to an unrelated session.', 'WORKSPACE_MISMATCH');
    if ('turn' in payload && !turnMatches(record.turn, payload.turn)) invalid('Event belongs to an unrelated turn.', 'PROTOCOL_ERROR');
    if (terminal.has(record.task.status)) return record;
    switch (event.type) {
      case 'agent.text.delta': {
        const delta = event.payload;
        text(delta.messageId, 512);
        if (typeof delta.text !== 'string' || !Number.isSafeInteger(delta.deltaIndex) || delta.deltaIndex < 0) invalid('Malformed text delta.', 'PROTOCOL_ERROR');
        const key = `${delta.messageId}:${delta.deltaIndex}`;
        if (record.deltaKeys.includes(key)) return record;
        if (delta.deltaIndex !== record.deltaKeys.filter(item => item.startsWith(`${delta.messageId}:`)).length) invalid('Text delta order is ambiguous; reconcile authoritative presentation.', 'PROTOCOL_ERROR');
        let message = record.messages.find(item => item.messageId === delta.messageId);
        if (!message) {
          if (record.messages.length >= 100) invalid('Message window is full; reconcile presentation.', 'PROTOCOL_ERROR');
          message = { messageId: delta.messageId, role: 'assistant', text: '', artifactRef: null, complete: false }; record.messages.push(message);
        }
        if (Buffer.byteLength(message.text + delta.text) > 65536 || record.messages.reduce((bytes, item) => bytes + Buffer.byteLength(item.text), Buffer.byteLength(delta.text)) > 128 * 1024) invalid('Message exceeds presentation bound; retrieve the provider artifact.', 'PROTOCOL_ERROR');
        message.text += delta.text; record.deltaKeys.push(key); break;
      }
      case 'agent.approval.requested': {
        const approval = event.payload.approval;
        id(approval.approvalId); text(approval.providerRequestId, 512); text(approval.action, 128); text(approval.targetSummary, 2048);
        if (!turnMatches(record.turn, approval.turn) || approval.expectedProjectRevision !== record.task.projectRevision || !Number.isFinite(Date.parse(approval.expiresAt)) || !Array.isArray(approval.permittedScopes) || !approval.permittedScopes.length || approval.permittedScopes.some(scope => scope !== 'once' && scope !== 'task') || record.pendingApprovals.length >= 32) invalid('Invalid approval correlation.', 'PROTOCOL_ERROR');
        if (approval.deviceId !== null) id(approval.deviceId);
        if (approval.artifactSha256 !== null && !/^[a-f0-9]{64}$/.test(approval.artifactSha256)) invalid('Invalid approval artifact.', 'PROTOCOL_ERROR');
        if (!record.pendingApprovals.some(item => item.approvalId === approval.approvalId)) record.pendingApprovals.push(clone(approval));
        record.task.status = 'awaiting-input'; break;
      }
      case 'agent.turn.finished':
        if (!['succeeded', 'failed', 'cancelled', 'outcome-unknown'].includes(event.payload.outcome)) invalid('Invalid provider terminal outcome.', 'PROTOCOL_ERROR');
        if (!event.payload.usage || !['provider-reported', 'unavailable'].includes(event.payload.usage.source)
          || [event.payload.usage.inputTokens, event.payload.usage.outputTokens, event.payload.usage.cachedInputTokens].some(count => count !== null && (!Number.isSafeInteger(count) || count < 0))
          || event.payload.usage.source === 'unavailable' && [event.payload.usage.inputTokens, event.payload.usage.outputTokens, event.payload.usage.cachedInputTokens].some(count => count !== null)) invalid('Usage must be attributable or explicitly unknown.', 'PROTOCOL_ERROR');
        record.providerOutcome = event.payload.outcome;
        record.pendingApprovals = [];
        for (const message of record.messages) message.complete = true;
        record.task.status = event.payload.outcome === 'succeeded' && record.requiredChecks.length ? 'awaiting-input' : event.payload.outcome;
        break;
      case 'agent.connection.changed':
        if (!['connected', 'disconnected', 'reconciling'].includes(event.payload.connection)) invalid('Invalid connection state.', 'PROTOCOL_ERROR');
        if (event.payload.connection === 'disconnected') { record.task.status = 'outcome-unknown'; record.lastProblem = 'TRANSPORT_LOST'; }
        break;
      case 'agent.turn.started': break;
      case 'agent.session.opened': break;
      case 'agent.tool.started': text(event.payload.toolCallId, 512); text(event.payload.displayName, 256); break;
      case 'agent.tool.finished': text(event.payload.toolCallId, 512); break;
      default: invalid('Unknown agent event.', 'PROTOCOL_ERROR');
    }
    if (event.sequence <= (record.events.at(-1)?.sequence ?? 0)) invalid('Agent event sequence must advance at the coordinator.', 'PROTOCOL_ERROR');
    record.seenEventIds.push(event.eventId); record.events.push(event);
    while (record.events.length > 64 || Buffer.byteLength(JSON.stringify(record.events)) > 128 * 1024) record.events.shift();
    return this.save(record);
  }
  complete(taskId: string, projectId: string, checks: Record<string, 'passed' | 'failed' | 'not-run'>): AgentRecord {
    const record = this.get(taskId, projectId);
    if (terminal.has(record.task.status) || record.providerOutcome !== 'succeeded') invalid('Task cannot be completed without attributable provider success.');
    if (Object.keys(checks).some(key => !record.requiredChecks.includes(key)) || Object.values(checks).some(value => !['passed', 'failed', 'not-run'].includes(value))) invalid('Unknown verification check.');
    record.checks = clone(checks);
    if (record.requiredChecks.some(check => checks[check] === 'failed')) record.task.status = 'failed';
    else if (record.requiredChecks.every(check => checks[check] === 'passed')) record.task.status = 'succeeded';
    return this.save(record);
  }
  async answerApproval(taskId: string, projectId: string, answer: ApprovalAnswer): Promise<AgentRecord> {
    const record = this.get(taskId, projectId); this.assertCurrent(record);
    const approval = record.pendingApprovals.find(item => item.approvalId === answer.approvalId);
    if (!approval || record.task.status !== 'awaiting-input' || Date.parse(approval.expiresAt) <= Date.now() || !turnMatches(approval.turn, answer.turn)
      || answer.providerRequestId !== approval.providerRequestId || answer.expectedProjectRevision !== approval.expectedProjectRevision
      || answer.deviceId !== approval.deviceId || answer.artifactSha256 !== approval.artifactSha256 || !approval.permittedScopes.includes(answer.scope)
      || !['allow', 'deny'].includes(answer.decision)) invalid('Approval is expired, resolved or does not match current targets.', 'APPROVAL_EXPIRED');
    const adapter = this.adapter(record.task.providerId);
    record.pendingApprovals = record.pendingApprovals.filter(item => item.approvalId !== answer.approvalId);
    record.task.status = record.pendingApprovals.length ? 'awaiting-input' : 'running';
    this.save(record);
    try { await adapter.answerApproval(clone(answer)); }
    catch (error) { record.task.status = 'outcome-unknown'; record.lastProblem = 'TRANSPORT_LOST'; this.save(record); throw error; }
    return record;
  }
  async interrupt(taskId: string, projectId: string): Promise<AgentRecord> {
    const record = this.get(taskId, projectId);
    if (!record.turn || terminal.has(record.task.status)) return record;
    await this.adapter(record.task.providerId).interrupt(record.turn);
    return record;
  }
  async reconcile(taskId: string, projectId: string): Promise<AgentRecord> {
    const record = this.get(taskId, projectId);
    if (!record.turn) invalid('Session was not acknowledged; create a separate task after reviewing provider state.', 'TRANSPORT_LOST');
    const snapshot = await this.adapter(record.task.providerId).reconcile(record.turn.session);
    if (!sessionMatches(snapshot.session, record.turn.session) || snapshot.messages.length > 100 || snapshot.pendingApprovals.length > 32) invalid('Invalid reconciliation snapshot.', 'PROTOCOL_ERROR');
    assertSafeAgentText(JSON.stringify(snapshot));
    if (record.reconciliations.length >= 16) invalid('Reconciliation history is full.');
    record.reconciliations.push({ reconciliationId: randomUUID(), observedAt: now(), snapshot: clone(snapshot) });
    if (!terminal.has(record.task.status)) {
      record.messages = clone(snapshot.messages); record.pendingApprovals = clone(snapshot.pendingApprovals);
      if (snapshot.connection === 'disconnected') record.task.status = 'outcome-unknown';
    }
    return this.save(record);
  }
  checkpoint(taskId: string, projectId: string, details: Pick<AgentCheckpoint, 'decisions' | 'completed' | 'remaining' | 'unknowns' | 'activeOperationIds'>, evidenceExists: (id: string) => boolean): AgentCheckpoint {
    const record = this.get(taskId, projectId);
    for (const values of [details.decisions, details.remaining, details.unknowns, details.activeOperationIds, details.completed]) if (!Array.isArray(values) || values.length > 32) invalid('Checkpoint exceeds supported bounds.');
    for (const item of [...details.decisions, ...details.remaining, ...details.unknowns]) text(item, 1024);
    for (const operationId of details.activeOperationIds) { id(operationId); if (!evidenceExists(operationId)) invalid('Checkpoint references a missing operation.'); }
    for (const completed of details.completed) {
      text(completed.summary, 2048);
      if (!Array.isArray(completed.evidenceRefs) || completed.evidenceRefs.length > 100) invalid('Invalid checkpoint evidence.');
      for (const evidence of completed.evidenceRefs) { id(evidence); if (!evidenceExists(evidence)) invalid('Checkpoint references missing evidence.'); }
    }
    const checkpoint: AgentCheckpoint = { kind: 'agent-checkpoint', schemaVersion: 1, checkpointId: randomUUID(), taskId, projectId, projectRevision: record.task.projectRevision, sourceSnapshotId: record.task.sourceSnapshotId, createdAt: now(), goal: record.packet.task, ...clone(details), providerSessionRef: record.turn?.session ?? null };
    assertSafeAgentText(JSON.stringify(checkpoint)); this.store.putCheckpoint(clone(checkpoint)); return checkpoint;
  }
  handoff(checkpoint: AgentCheckpoint, current: ContextPacket): { schemaVersion: 1; checkpointId: string; goal: string; decisions: string[]; completed: AgentCheckpoint['completed']; remaining: string[]; unknowns: string[]; activeOperationIds: string[]; context: ContextPacket } {
    const packet = validateContextPacket(current);
    if (packet.projectId !== checkpoint.projectId) invalid('Cannot hand off another project.', 'WORKSPACE_MISMATCH');
    const unknowns = [...checkpoint.unknowns];
    if (packet.projectRevision !== checkpoint.projectRevision) unknowns.push('Design changed since checkpoint; prior physical confirmations require review.');
    if (packet.sourceSnapshotId !== checkpoint.sourceSnapshotId) unknowns.push('Source changed since checkpoint; prior build applicability requires review.');
    return { schemaVersion: 1, checkpointId: checkpoint.checkpointId, goal: checkpoint.goal, decisions: clone(checkpoint.decisions), completed: clone(checkpoint.completed), remaining: clone(checkpoint.remaining), unknowns, activeOperationIds: clone(checkpoint.activeOperationIds), context: packet };
  }
}
