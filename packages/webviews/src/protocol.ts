import type { WorkbenchViewRequest, WorkbenchViewResponse, WorkbenchViewState } from '@robotics-workbench/contracts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
const statuses = new Set(['queued', 'running', 'awaiting-input', 'succeeded', 'failed', 'cancelled', 'outcome-unknown']);
const capabilities = new Set(['resume', 'interrupt', 'steer', 'images', 'mcp', 'usage', 'approvals', 'structured-output']);
const facets = new Set(['available', 'pinned', 'supplied-this-turn', 'observed-retrieved', 'stale']);
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function keys(value: Record<string, unknown>, names: string[]): boolean { return Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name)); }
function text(value: unknown, max: number, min = 0): value is string { return typeof value === 'string' && value.length >= min && value.length <= max; }
function id(value: unknown): value is string { return typeof value === 'string' && uuid.test(value); }
function nullableId(value: unknown): boolean { return value === null || id(value); }
function revision(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) > 0; }
function array(value: unknown, limit: number, valid: (item: unknown) => boolean): boolean { return Array.isArray(value) && value.length <= limit && value.every(valid); }
function bounded(value: unknown, limit: number): boolean {
  const jsonValue = (item: unknown, depth = 0): boolean => depth <= 16 && (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)
    || Array.isArray(item) && item.every(child => jsonValue(child, depth + 1))
    || object(item) && Object.values(item).every(child => jsonValue(child, depth + 1)));
  try { return jsonValue(value) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= limit; } catch { return false; }
}
function provider(value: unknown): boolean { return value === 'codex' || value === 'opencode'; }
function session(value: unknown): boolean { return object(value) && keys(value, ['providerId', 'projectId', 'taskId', 'providerSessionId', 'workspaceUri']) && provider(value.providerId) && id(value.projectId) && id(value.taskId) && text(value.providerSessionId, 512, 1) && text(value.workspaceUri, 4096, 1); }
function turn(value: unknown): boolean { return object(value) && keys(value, ['clientTurnId', 'session', 'providerTurnId']) && id(value.clientTurnId) && session(value.session) && (value.providerTurnId === null || text(value.providerTurnId, 512, 1)); }
function approval(value: unknown): boolean {
  return object(value) && keys(value, ['approvalId', 'providerRequestId', 'turn', 'action', 'targetSummary', 'expectedProjectRevision', 'deviceId', 'artifactSha256', 'permittedScopes', 'expiresAt'])
    && id(value.approvalId) && text(value.providerRequestId, 512, 1) && turn(value.turn) && text(value.action, 128, 1) && text(value.targetSummary, 2048)
    && revision(value.expectedProjectRevision) && nullableId(value.deviceId) && (value.artifactSha256 === null || typeof value.artifactSha256 === 'string' && digest.test(value.artifactSha256))
    && array(value.permittedScopes, 2, scope => scope === 'once' || scope === 'task') && typeof value.expiresAt === 'string' && Number.isFinite(Date.parse(value.expiresAt));
}

export function isWorkbenchViewRequest(value: unknown, projectId?: string | null): value is WorkbenchViewRequest {
  if (!bounded(value, 65536) || !object(value) || !keys(value, ['schemaVersion', 'requestId', 'projectId', 'type', 'payload']) || value.schemaVersion !== 1 || !id(value.requestId) || !nullableId(value.projectId) || !object(value.payload)) return false;
  if (projectId !== undefined && value.projectId !== projectId && !(value.type === 'ready' && value.projectId === null)) return false;
  const payload = value.payload;
  if (value.type === 'ready' || value.type === 'refresh') return keys(payload, []);
  if (!id(value.projectId)) return false;
  switch (value.type) {
    case 'send': return keys(payload, ['providerId', 'modelId', 'permissionProfileId', 'userText']) && provider(payload.providerId) && text(payload.modelId, 256, 1) && (payload.permissionProfileId === 'read-only' || payload.permissionProfileId === 'workspace-write') && text(payload.userText, 8192, 1) && payload.userText.trim().length > 0;
    case 'selectTask': return keys(payload, ['taskId']) && id(payload.taskId);
    case 'stop': case 'reconcile': case 'handoff': case 'authorizeUpload': return keys(payload, []);
    case 'approval': return keys(payload, ['approvalId', 'decision']) && id(payload.approvalId) && (payload.decision === 'allow' || payload.decision === 'deny');
    case 'pin': return keys(payload, ['id', 'pinned']) && text(payload.id, 512, 1) && typeof payload.pinned === 'boolean';
    case 'openEvidence': return keys(payload, ['id']) && text(payload.id, 512, 1);
    case 'review': return keys(payload, ['id', 'action']) && text(payload.id, 512, 1) && ['diff', 'keep', 'revert', 'apply', 'dismiss'].includes(String(payload.action));
    default: return false;
  }
}

export function isWorkbenchViewState(value: unknown): value is WorkbenchViewState {
  if (!bounded(value, 1024 * 1024) || !object(value) || !keys(value, ['schemaVersion', 'project', 'loading', 'error', 'trusted', 'providers', 'tasks', 'task', 'context', 'changes', 'operations']) || value.schemaVersion !== 1 || typeof value.loading !== 'boolean' || typeof value.trusted !== 'boolean' || !(value.error === null || text(value.error, 4096))) return false;
  if (value.project !== null && !(object(value.project) && keys(value.project, ['projectId', 'projectRevision', 'name']) && id(value.project.projectId) && revision(value.project.projectRevision) && text(value.project.name, 1024, 1))) return false;
  if (!array(value.providers, 2, item => object(item) && keys(item, ['providerId', 'readiness', 'capabilities', 'detail']) && provider(item.providerId) && text(item.readiness, 128, 1) && array(item.capabilities, 8, capability => typeof capability === 'string' && capabilities.has(capability)) && text(item.detail, 4096))) return false;
  if (!array(value.tasks, 100, item => object(item) && keys(item, ['taskId', 'providerId', 'status', 'summary']) && id(item.taskId) && provider(item.providerId) && statuses.has(String(item.status)) && text(item.summary, 8192))) return false;
  if (value.task !== null) {
    const task = value.task;
    if (!object(task) || !keys(task, ['taskId', 'providerId', 'modelId', 'status', 'providerOutcome', 'contextPacketId', 'sourceSnapshotId', 'messages', 'pendingApprovals', 'activities', 'problem']) || !id(task.taskId) || !provider(task.providerId) || !text(task.modelId, 256, 1) || !statuses.has(String(task.status)) || !(task.providerOutcome === null || statuses.has(String(task.providerOutcome))) || !id(task.contextPacketId) || !nullableId(task.sourceSnapshotId) || !(task.problem === null || text(task.problem, 4096))) return false;
    if (!array(task.messages, 100, item => object(item) && keys(item, ['messageId', 'role', 'text', 'artifactRef', 'complete']) && text(item.messageId, 512, 1) && (item.role === 'user' || item.role === 'assistant') && text(item.text, 65536) && new TextEncoder().encode(item.text).byteLength <= 65536 && nullableId(item.artifactRef) && typeof item.complete === 'boolean')) return false;
    if (!array(task.pendingApprovals, 32, approval) || !array(task.activities, 64, item => object(item) && keys(item, ['id', 'title', 'summary']) && text(item.id, 512, 1) && text(item.title, 256, 1) && text(item.summary, 4096))) return false;
    if (!object(value.project)) return false;
    const projectId = value.project.projectId;
    if ((task.pendingApprovals as unknown[]).some(item => object(item) && object(item.turn) && object(item.turn.session) && (item.turn.session.projectId !== projectId || item.turn.session.taskId !== task.taskId || item.turn.session.providerId !== task.providerId))) return false;
  }
  return array(value.context, 200, item => object(item) && keys(item, ['id', 'title', 'sourceUri', 'revision', 'location', 'facets', 'summary', 'reason', 'sha256']) && text(item.id, 512, 1) && text(item.title, 1024, 1) && text(item.sourceUri, 4096) && revision(item.revision) && text(item.location, 1024) && array(item.facets, 5, facet => typeof facet === 'string' && facets.has(facet)) && text(item.summary, 4096) && text(item.reason, 2048) && (item.sha256 === null || typeof item.sha256 === 'string' && digest.test(item.sha256)))
    && array(value.changes, 200, item => object(item) && keys(item, ['id', 'path', 'effect', 'baselineSha256', 'currentSha256', 'summary']) && text(item.id, 512, 1) && text(item.path, 4096, 1) && ['proposed', 'written', 'conflicted', 'kept', 'reverted'].includes(String(item.effect)) && (item.baselineSha256 === null || typeof item.baselineSha256 === 'string' && digest.test(item.baselineSha256)) && (item.currentSha256 === null || typeof item.currentSha256 === 'string' && digest.test(item.currentSha256)) && text(item.summary, 4096))
    && array(value.operations, 100, item => object(item) && keys(item, ['operationId', 'kind', 'status']) && id(item.operationId) && text(item.kind, 128, 1) && statuses.has(String(item.status)));
}
export function isWorkbenchViewResponse(value: unknown): value is WorkbenchViewResponse { return object(value) && keys(value, ['schemaVersion', 'type', 'state']) && value.schemaVersion === 1 && value.type === 'state' && isWorkbenchViewState(value.state); }
