import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentService } from '../src/agent-service';
import { ProjectService } from '../src/project-service';
import { DocumentService } from '../src/document-service';
import { TelemetryService } from '../src/telemetry-service';
import { createParserProfile, deriveTelemetry, type RawRecord } from '@robotics-workbench/serial';
import type { HardwareService } from '../src/hardware-service';
import type { AgentRecord, AgentCheckpoint } from '@robotics-workbench/agents';
import { validateContextPacket } from '@robotics-workbench/application';
import { WorkbenchError, type AgentEvent, type ProviderAdapter, type ProviderDescriptor, type ProviderId, type OpenSession, type SessionRef, type SessionSnapshot, type SubmitTurn, type TurnRef, type ProjectRequest, type ProjectResponse, type OperationReceipt } from '@robotics-workbench/contracts';

class FakeAdapter implements ProviderAdapter {
  submits = 0; opens = 0; session!: SessionRef; turn: TurnRef | null = null; status: SessionSnapshot['latestTurnStatus'] = null;
  closed = false; events: AgentEvent[] = []; waiters = new Set<() => void>();
  beforeInspect?: () => Promise<void>; onSubmit?: (input: SubmitTurn, context: string) => void;
  constructor(readonly providerId: ProviderId, readonly contextText: (packetId: string) => Promise<string>, readonly runtimeConfig: Record<string, unknown>) {}
  async inspect(): Promise<ProviderDescriptor> { await this.beforeInspect?.(); return { providerId: this.providerId, executableVersion: 'synthetic', adapterVersion: '1', protocolFingerprint: 'a'.repeat(64), capabilities: ['resume', 'interrupt', 'approvals'], readiness: 'ready', problems: [] }; }
  async open(input: OpenSession): Promise<SessionRef> { this.opens++; this.closed = false; return this.session = input.resume ?? { providerId: this.providerId, projectId: input.projectId, taskId: input.taskId, providerSessionId: randomUUID(), workspaceUri: input.workspaceUri }; }
  async submit(input: SubmitTurn): Promise<TurnRef> {
    this.submits++; this.onSubmit?.(input, await this.contextText(input.contextPacketId));
    this.turn = { clientTurnId: input.clientTurnId, session: input.session, providerTurnId: randomUUID() }; this.status = 'running';
    this.emit({ type: 'agent.turn.started', payload: { turn: this.turn } }); return this.turn;
  }
  async *observe(): AsyncIterable<AgentEvent> {
    let cursor = 0;
    while (!this.closed || cursor < this.events.length) {
      while (cursor < this.events.length) yield structuredClone(this.events[cursor++]);
      if (!this.closed) await new Promise<void>(resolve => this.waiters.add(resolve));
    }
  }
  emit(input: Pick<AgentEvent, 'type' | 'payload'>): void {
    this.events.push({ schemaVersion: 1, eventId: randomUUID(), sequence: this.events.length + 1, projectId: this.session.projectId, projectRevision: 1, occurredAt: new Date().toISOString(), ...input } as AgentEvent);
    for (const wake of this.waiters) wake(); this.waiters.clear();
  }
  finish(): void { const turn = this.turn!; this.status = 'succeeded'; this.turn = null; this.emit({ type: 'agent.turn.finished', payload: { turn, outcome: 'succeeded', usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, source: 'unavailable' }, problem: null } }); }
  async answerApproval(): Promise<void> {}
  async interrupt(): Promise<void> { const turn = this.turn!; this.status = 'cancelled'; this.turn = null; this.emit({ type: 'agent.turn.finished', payload: { turn, outcome: 'cancelled', usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, source: 'unavailable' }, problem: null } }); }
  async reconcile(): Promise<SessionSnapshot> { return { session: this.session, descriptor: await this.inspect(), connection: this.closed ? 'disconnected' : 'connected', activeTurn: this.turn, latestTurnStatus: this.status, pendingApprovals: [], messages: [], nextCursor: null, observedAt: new Date().toISOString() }; }
  async close(): Promise<void> {
    if (this.closed) return;
    if (this.session) this.emit({ type: 'agent.connection.changed', payload: { session: this.session, connection: 'disconnected', problem: null } });
    this.closed = true; for (const wake of this.waiters) wake(); this.waiters.clear();
  }
  bridge(): { endpoint: string; token: string } {
    const section = this.runtimeConfig[this.providerId === 'codex' ? 'mcp_servers' : 'mcp'] as Record<string, Record<string, unknown>>;
    const server = Object.values(section)[0]; const env = server[this.providerId === 'codex' ? 'env' : 'environment'] as Record<string, string>;
    return { endpoint: env.ROBOTICS_TOOL_ENDPOINT, token: env.ROBOTICS_TOOL_TOKEN };
  }
}
async function fixture(t: TestContext) {
  const temp = mkdtempSync(join(tmpdir(), 'workbench-agents-')), root = join(temp, 'Probe'); mkdirSync(root);
  const manifest = JSON.parse(readFileSync('examples/workbench.valid.json', 'utf8')); manifest.sketches[0].path = '.';
  writeFileSync(join(root, 'workbench.json'), JSON.stringify(manifest));
  const source = join(root, 'Probe.ino'); writeFileSync(source, 'void setup() {}\nvoid loop() {}\n');
  const project = new ProjectService(root, join(temp, 'data'));
  const sourceSnapshotId = randomUUID();
  const snapshot = project.files.snapshotSource({ paths: ['.'], host: () => ({ dirtyPaths: [] }) });
  project.store.putRecord('source_snapshots', sourceSnapshotId, project.projectId, { sha256: snapshot.sha256, sketchRelativePath: '.', files: snapshot.files.map(({ path, sha256 }) => ({ path, sha256 })) });
  let compileFails = false;
  const hardware = {
    inputHashesAsync: async () => new Map<string, string>(),
    supports: (method: string) => method === 'build.compile',
    handle: async (request: ProjectRequest): Promise<ProjectResponse> => {
      const receipt: OperationReceipt = { schemaVersion: 1, operationId: randomUUID(), requestId: request.requestId, projectId: project.projectId, kind: 'compile', status: 'queued', expectedProjectRevision: 1, createdAt: new Date().toISOString(), tool: { name: 'synthetic compiler', version: '1' }, artifacts: [] };
      const result = project.jobs.submit({ receipt, payload: request, execute: async () => { if (compileFails) throw new WorkbenchError('COMPILE_FAILED', 'Synthetic compile failed.'); return { result: { synthetic: true } }; } });
      return { schemaVersion: 1, requestId: request.requestId, result };
    }
  } as unknown as HardwareService;
  const adapters = new Map<ProviderId, FakeAdapter>();
  let configure: ((adapter: FakeAdapter) => void) | undefined;
  const config = { codexPath: process.execPath, opencodePath: process.execPath, nodePath: process.execPath, mcpScript: join(temp, 'unused-mcp.cjs') };
  const create = async (providerId: ProviderId, contextText: (packetId: string) => Promise<string>, runtimeConfig: Record<string, unknown>) => { const adapter = new FakeAdapter(providerId, contextText, runtimeConfig); adapters.set(providerId, adapter); configure?.(adapter); return adapter; };
  const service = new AgentService(project, hardware, config, create);
  const services = [service];
  t.after(async () => { for (const item of services) await item.close(); await project.shutdown(); rmSync(temp, { recursive: true, force: true }); });
  const request = (method: ProjectRequest['method'], params: Record<string, unknown>, revision?: number): ProjectRequest => ({ schemaVersion: 1, requestId: randomUUID(), projectId: project.projectId, method, params, ...(revision ? { expectedProjectRevision: revision } : {}) });
  const start = (providerId: ProviderId = 'codex') => request('agent.start', { taskId: randomUUID(), clientTurnId: randomUUID(), providerId, modelId: 'synthetic-model', permissionProfileId: 'read-only', userText: 'Explain this synthetic project. Do not upload.', sourceSnapshotId }, 1);
  const call = async <T>(value: ProjectRequest, current = service): Promise<T> => { const response = await current.handle(value); if (response.error) throw new WorkbenchError(response.error.code, response.error.message); return response.result as T; };
  const get = (taskId: string) => call<AgentRecord>(request('agent.get', { taskId }));
  const waitStatus = async (taskId: string, expected: string) => {
    for (let attempt = 0; attempt < 100; attempt++) { const record = await get(taskId); if (record.task.status === expected) return record; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.fail(`Task never reached ${expected}; last status ${(await get(taskId)).task.status}`);
  };
  const tool = async (adapter: FakeAdapter, name: string, args: unknown, token?: string) => { const binding = adapter.bridge(); return fetch(binding.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token ?? binding.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, arguments: args }) }); };
  return { project, service, source, sourceSnapshotId, adapters, request, start, call, get, waitStatus, tool, manifest, configure: (value: typeof configure) => { configure = value; }, failCompile: () => { compileFails = true; }, restart: () => { const replacement = new AgentService(project, hardware, config, create); services.push(replacement); return replacement; } };
}
test('frozen document context retains pinned source and missing-pin omissions', async t => {
  const f = await fixture(t), documents = new DocumentService(f.project), documentId = randomUUID(), missing = randomUUID();
  const version = await documents.repository.ingest({ projectId: f.project.projectId, documentId, filename: 'retained.txt', bytes: Buffer.from('Quoted engineering source, not authorization.'), mediaType: 'text/plain' });
  const citation = documents.repository.cite(f.project.projectId, { documentId, artifactSha256: version.artifactSha256, extractorVersion: version.extractorVersion, page: 1 });
  const request = f.start(); request.params.selection = { kind: 'document-page', documentId, artifactSha256: citation.artifactSha256, extractorVersion: citation.extractorVersion, page: citation.page, textRange: citation.textRange, projectRevision: 1 }; request.params.pinnedIds = [f.sourceSnapshotId, missing];
  const record = await f.call<AgentRecord>(request);
  assert.ok(record.packet.evidenceRefs.some(item => item.sha256 === version.artifactSha256 && item.location.kind === 'page'));
  assert.ok(record.packet.evidenceRefs.some(item => item.evidenceId === f.sourceSnapshotId), 'Pinned source remains supplied with document selection.');
  assert.ok(record.packet.omitted.some(item => item.ref === missing && item.reason === 'excluded'), 'Unavailable pin remains visible as an omission.');
  f.adapters.get('codex')!.finish(); await f.waitStatus(record.task.taskId, 'succeeded');
});

test('agent numeric context freezes the exact derivation across later recordings', async t => {
  const f = await fixture(t), telemetry = new TelemetryService(f.project, { setCaptureObserver() {}, liveRecordings: () => [] } as unknown as HardwareService);
  const profile = createParserProfile({ schemaVersion: 1, id: randomUUID(), parserVersion: 'telemetry-v1', mode: 'labeled-numeric', channels: [{ channelId: 'count', label: 'Synthetic software count', unit: 'count', source: 'count' }] });
  const retain = () => {
    const recordingId = randomUUID(), connectionSessionId = randomUUID();
    const records: RawRecord[] = [1, 2].map((value, sequence) => ({ schemaVersion: 1, recordingId, connectionSessionId, sequence, hostElapsedNs: String(sequence * 1_000_000), hostReceivedAt: new Date().toISOString(), bytesBase64: Buffer.from(`count:${value}\n`).toString('base64'), quality: 'received' }));
    const raw = Buffer.from(records.map(record => JSON.stringify(record) + '\n').join('')), artifact = f.project.store.storeArtifact(f.project.projectId, raw, 'application/x-ndjson');
    const rawSha256 = createHash('sha256').update(Buffer.concat(records.map(record => Buffer.from(record.bytesBase64, 'base64')))).digest('hex');
    const recording = { schemaVersion: 1, recordingId, projectId: f.project.projectId, projectRevision: 1, deviceId: randomUUID(), startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), status: 'completed', serial: { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, encoding: 'utf8' }, uploadReceiptId: null, firmwareSha256: null, parserVersion: 'raw-v1', rawBytes: 16, rawSha256, segments: [{ path: artifact.relativePath, artifactId: artifact.artifactId, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes, complete: true, connectionSessionId }], gaps: [] };
    f.project.store.putRecord('recordings', recordingId, f.project.projectId, recording);
    const derivation = deriveTelemetry(records, [], profile, { recordingId, rawSha256, segmentSha256s: [artifact.sha256] });
    telemetry.repository.retainDerivation(f.project.projectId, derivation, [artifact]); return derivation;
  };
  const original = retain(), request = f.start();
  request.params.selection = { kind: 'recording-range', recordingId: original.recordingId, derivationId: original.derivationId, configurationSha256: original.configurationSha256, parserVersion: original.parserVersion, channelIds: ['count'], startMs: 0, endMs: 1, timeBasis: 'host-receive', projectRevision: 1, recordingProjectRevision: 1 };
  request.params.pinnedIds = [f.sourceSnapshotId];
  const record = await f.call<AgentRecord>(request), supplied = record.packet.evidenceRefs.find(item => item.evidenceId === original.derivationId)!;
  assert.ok(record.packet.evidenceRefs.some(item => item.evidenceId === f.sourceSnapshotId));
  assert.equal(createHash('sha256').update(f.project.store.readArtifact(f.project.projectId, supplied.artifactId!)).digest('hex'), supplied.sha256);
  const summary = JSON.parse(supplied.summary); assert.equal(summary.selection.derivationId, original.derivationId); assert.equal(summary.statistics[0].mean, 1.5);
  retain(); assert.deepEqual((await f.get(record.task.taskId)).packet, record.packet, 'Later acquisition cannot move an already supplied interval.');
  f.adapters.get('codex')!.finish(); await f.waitStatus(record.task.taskId, 'succeeded');
});

test('agent service persists context before submit and identical start is not replayed', async t => {
  const f = await fixture(t); let observed = false;
  f.configure(adapter => { adapter.onSubmit = (input, context) => {
    const records = f.project.store.listRecords<{ kind: string; record?: AgentRecord }>('sessions', f.project.projectId);
    assert.ok(records.some(row => row.kind === 'agent-record' && row.record?.task.status === 'running' && row.record.packet.packetId === input.contextPacketId));
    const packet = JSON.parse(context); assert.equal(packet.projectId, f.project.projectId); assert.equal(packet.sourceSnapshotId, f.sourceSnapshotId); assert.ok(Buffer.byteLength(context) <= 24576); observed = true;
  }; });
  const start = f.start(); const record = await f.call<AgentRecord>(start);
  assert.ok(observed); assert.equal(record.task.status, 'running');
  await f.call(start); assert.equal(f.adapters.get('codex')!.submits, 1);
  await assert.rejects(f.call({ ...start, params: { ...start.params, userText: 'Different task text' } }), { code: 'INVALID_REQUEST' });
  f.adapters.get('codex')!.finish(); const done = await f.waitStatus(String(start.params.taskId), 'succeeded');
  assert.equal(done.providerOutcome, 'succeeded'); assert.ok(done.events.every((event, index) => index === 0 || event.sequence > done.events[index - 1].sequence));
  assert.ok(f.project.store.listRecords<{ kind: string }>('sessions', f.project.projectId).some(row => row.kind === 'agent-checkpoint'));
});
test('concurrent cross-provider admission has one project writer', async t => {
  const f = await fixture(t); let release!: () => void, inspected!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { inspected = resolve; });
  f.configure(adapter => { adapter.beforeInspect = async () => { inspected(); await gate; }; });
  const first = f.call<AgentRecord>(f.start()); await ready;
  await assert.rejects(f.call(f.start('opencode')), { code: 'PROJECT_BUSY' });
  release(); await first;
  assert.equal(f.adapters.get('codex')!.submits, 1); assert.equal(f.adapters.has('opencode'), false);
});
test('source mismatch and cross-project request fail without submitting a provider turn', async t => {
  const f = await fixture(t); writeFileSync(f.source, '// concurrent saved edit\n');
  await assert.rejects(f.call(f.start()), { code: 'REVISION_CONFLICT' });
  assert.equal(f.adapters.get('codex')!.submits, 0);
  await assert.rejects(f.service.handle({ ...f.start(), projectId: randomUUID() }), { code: 'UNAUTHORIZED_SCOPE' });
  assert.equal(readFileSync(f.source, 'utf8'), '// concurrent saved edit\n');
});
test('authenticated bridge fixes project scope and refuses unrelated cancellation and firmware writes', async t => {
  const f = await fixture(t), start = f.start(); await f.call(start); const adapter = f.adapters.get('codex')!;
  assert.equal((await f.tool(adapter, 'project_snapshot', { requestId: randomUUID(), params: {} }, 'incorrect')).status, 403);
  const scoped = await f.tool(adapter, 'project_snapshot', { requestId: randomUUID(), params: {}, projectId: randomUUID() }); assert.equal(scoped.status, 400);
  const cancel = await f.tool(adapter, 'operation_cancel', { requestId: randomUUID(), params: { operationId: randomUUID() } }); assert.equal(cancel.status, 400);
  const upload = await f.tool(adapter, 'firmware_upload', { requestId: randomUUID(), expectedProjectRevision: 1, params: { buildId: randomUUID(), artifactId: randomUUID(), artifactSha256: 'a'.repeat(64), deviceId: randomUUID(), expectedDeviceObservationId: randomUUID(), fqbn: 'arduino:avr:uno', resumeMonitoring: true } }); assert.equal(upload.status, 400);
  assert.equal(f.project.store.listOperations(f.project.projectId).length, 0);
});
test('failed linked compile cannot become a successful agent task when provider says done', async t => {
  const f = await fixture(t); f.failCompile(); const start = f.start(); await f.call(start); const adapter = f.adapters.get('codex')!;
  const response = await f.tool(adapter, 'build_compile', { requestId: randomUUID(), expectedProjectRevision: 1, params: { targetId: f.manifest.targets[0].targetId, sourceSnapshotId: f.sourceSnapshotId } });
  assert.equal(response.status, 200);
  const payload = await response.json() as { content: { text: string }[] };
  const operation = JSON.parse(payload.content[0].text).result as OperationReceipt;
  assert.equal((await f.project.jobs.wait(operation.operationId)).status, 'failed');
  adapter.finish(); const record = await f.waitStatus(String(start.params.taskId), 'failed');
  assert.equal(record.providerOutcome, 'succeeded'); assert.deepEqual(record.task.operationIds, [operation.operationId]);
});
test('restart retains unknown outcome and identical start does not replay a prompt', async t => {
  const f = await fixture(t), start = f.start(); await f.call(start); const original = f.adapters.get('codex')!;
  await f.service.close(); const replacement = f.restart();
  const record = await f.call<AgentRecord>(f.request('agent.get', { taskId: start.params.taskId }), replacement);
  assert.equal(record.task.status, 'outcome-unknown');
  const replay = await f.call<AgentRecord>(start, replacement); assert.equal(replay.task.status, 'outcome-unknown');
  assert.equal(original.submits, 1); assert.equal(f.adapters.get('codex'), original, 'Replay does not create another provider adapter.'); assert.equal(original.closed, true);
});
test('buffered provider characters leave ordinary reads and cancellation responsive without dropping durable text', { timeout: 600000 }, async t => {
  const f = await fixture(t);
  for (let index = 0; index < 128; index++) f.project.store.putRecord('sessions', randomUUID(), f.project.projectId, { kind: 'synthetic-previous-history', index, text: 'h'.repeat(16 * 1024) });
  const start = f.start(); start.params.sourceSnapshotId = null;
  const initial = await f.call<AgentRecord>(start), adapter = f.adapters.get('codex')!;
  await f.get(initial.task.taskId);
  let finalized!: (record: AgentRecord) => void;
  const terminalWritten = new Promise<AgentRecord>(resolve => { finalized = resolve; });
  const persist = f.project.store.putRecord.bind(f.project.store);
  t.mock.method(f.project.store, 'putRecord', (table: Parameters<typeof persist>[0], id: string, projectId: string, body: unknown) => {
    const result = persist(table, id, projectId, body);
    const journal = body as { kind?: string; record?: AgentRecord };
    if (journal.kind === 'agent-record' && journal.record?.task.taskId === initial.task.taskId && journal.record.task.status === 'cancelled') finalized(structuredClone(journal.record));
    return result;
  });
  const text = 'a'.repeat(128);
  for (let index = 0; index < text.length; index++) adapter.emit({ type: 'agent.text.delta', payload: { turn: adapter.turn!, messageId: 'burst-message', deltaIndex: index, text: text[index] } });
  const observedBeforeDrain = await new Promise<number>((resolve, reject) => setImmediate(() => {
    void (async () => {
      const record = await f.get(initial.task.taskId), count = record.messages.find(message => message.messageId === 'burst-message')?.text.length ?? 0;
      const acknowledgement = await f.call<AgentRecord>(f.request('agent.interrupt', { taskId: initial.task.taskId }));
      assert.equal(acknowledgement.task.status, 'running', 'An interruption acknowledgement cannot invent a terminal result before its queued event.');
      resolve(count);
    })().catch(reject);
  }));
  const terminal = await terminalWritten;
  assert.ok(observedBeforeDrain < text.length, 'Buffered provider events starved the I/O callback until every character was persisted.');
  assert.equal(terminal.messages.find(message => message.messageId === 'burst-message')?.text, text);
  assert.equal(terminal.deltaKeys.length, text.length); assert.equal(new Set(terminal.seenEventIds).size, terminal.seenEventIds.length);
  assert.equal(adapter.submits, 1); assert.deepEqual(terminal.task.operationIds, []);
  const durable = f.project.store.listRecords<{ kind: string; record?: AgentRecord }>('sessions', f.project.projectId).filter(item => item.kind === 'agent-record').at(-1)!.record!;
  assert.equal(durable.task.status, 'cancelled'); assert.equal(durable.messages.find(message => message.messageId === 'burst-message')?.text, text);
});
test('handoff refreshes changed manifest and preserves stale physical applicability', async t => {
  const f = await fixture(t), start = f.start(); await f.call(start); f.adapters.get('codex')!.finish(); await f.waitStatus(String(start.params.taskId), 'succeeded');
  const manifestPath = join(f.project.files.root, 'workbench.json'); const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); manifest.projectRevision = 2; manifest.name = 'Updated design'; writeFileSync(manifestPath, JSON.stringify(manifest));
  const handoff = await f.call<{ context: { projectRevision: number }; unknowns: string[] }>(f.request('agent.handoff', { taskId: start.params.taskId }));
  assert.equal(handoff.context.projectRevision, 2); assert.ok(handoff.unknowns.some(item => item.includes('Design changed')));
  assert.equal('providerSessionRef' in handoff, false);
});
test('handoff cannot label an edited source file as the old saved snapshot', async t => {
  const f = await fixture(t), start = f.start(); await f.call(start); f.adapters.get('codex')!.finish(); await f.waitStatus(String(start.params.taskId), 'succeeded');
  writeFileSync(f.source, '// source changed after checkpoint\n');
  const handoff = await f.call<{ context: { sourceSnapshotId: string | null }; unknowns: string[] }>(f.request('agent.handoff', { taskId: start.params.taskId }));
  assert.equal(handoff.context.sourceSnapshotId, null);
  assert.ok(handoff.unknowns.some(item => item.includes('Source changed')));
  assert.equal(readFileSync(f.source, 'utf8'), '// source changed after checkpoint\n');
});
test('retired session tool binding cannot act for a later task', async t => {
  const f = await fixture(t), first = f.start(); await f.call(first); const retired = f.adapters.get('codex')!;
  retired.finish(); await f.waitStatus(String(first.params.taskId), 'succeeded');
  const second = f.start(); await f.call(second);
  await assert.rejects(f.tool(retired, 'project_snapshot', { requestId: randomUUID(), params: {} }), /fetch failed/);
  assert.deepEqual((await f.get(String(second.params.taskId))).task.operationIds, []);
});
test('reading an unrelated receipt never grants cancellation ownership', async t => {
  const f = await fixture(t), start = f.start(); await f.call(start); const adapter = f.adapters.get('codex')!;
  const operationId = randomUUID();
  const receipt: OperationReceipt = { schemaVersion: 1, operationId, requestId: randomUUID(), projectId: f.project.projectId, kind: 'compile', status: 'queued', expectedProjectRevision: 1, createdAt: new Date().toISOString(), tool: { name: 'synthetic', version: '1' }, artifacts: [] };
  f.project.store.createOperation(receipt, { synthetic: true });
  assert.equal((await f.tool(adapter, 'operation_get', { requestId: randomUUID(), params: { operationId } })).status, 200);
  assert.deepEqual((await f.get(String(start.params.taskId))).task.operationIds, []);
  assert.equal((await f.tool(adapter, 'operation_cancel', { requestId: randomUUID(), params: { operationId } })).status, 400);
  assert.equal(f.project.store.getOperation(f.project.projectId, operationId).status, 'queued');
});
test('added source input invalidates agent compile admission and handoff', async t => {
  const f = await fixture(t), start = f.start(); await f.call(start); const adapter = f.adapters.get('codex')!;
  writeFileSync(join(f.project.files.root, 'new-input.h'), 'int added = 1;');
  assert.equal((await f.tool(adapter, 'build_compile', { requestId: randomUUID(), expectedProjectRevision: 1, params: { targetId: f.manifest.targets[0].targetId, sourceSnapshotId: f.sourceSnapshotId } })).status, 400);
  assert.equal(f.project.store.listOperations(f.project.projectId).length, 0);
});
test('manifest credential fields cannot leak through a small MCP snapshot response', async t => {
  const f = await fixture(t), start = f.start(); await f.call(start); const adapter = f.adapters.get('codex')!;
  const path = join(f.project.files.root, 'workbench.json'); const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.projectRevision++; manifest.extensions.synthetic = { password: 'planted-test-value' }; writeFileSync(path, JSON.stringify(manifest));
  const response = await f.tool(adapter, 'project_snapshot', { requestId: randomUUID(), params: {} });
  assert.equal(response.status, 400); assert.equal((await response.text()).includes('planted-test-value'), false);
});
test('host upload grant authorizes only its exact task target and artifact parameters', async t => {
  const f = await fixture(t), start = f.start(); await f.call(start); const adapter = f.adapters.get('codex')!;
  const upload = { buildId: randomUUID(), artifactId: randomUUID(), artifactSha256: 'a'.repeat(64), deviceId: randomUUID(), expectedDeviceObservationId: randomUUID(), fqbn: 'arduino:avr:uno', resumeMonitoring: true };
  await f.call(f.request('agent.authorizeUpload', { taskId: start.params.taskId, upload }, 1));
  const admitted = await f.tool(adapter, 'firmware_upload', { requestId: randomUUID(), expectedProjectRevision: 1, params: upload });
  assert.equal(admitted.status, 200);
  const result = await admitted.json() as { content: { text: string }[] };
  assert.equal(JSON.parse(result.content[0].text).error.code, 'UNKNOWN_METHOD', 'Synthetic hardware has no uploader; authorization reaches dispatch only.');
  assert.equal((await f.tool(adapter, 'firmware_upload', { requestId: randomUUID(), expectedProjectRevision: 1, params: { ...upload, artifactSha256: 'b'.repeat(64) } })).status, 400);
  assert.equal(f.project.store.listOperations(f.project.projectId).length, 0);
});
test('three identical rejected tool actions pause effects for replanning', async t => {
  const f = await fixture(t), start = f.start(); await f.call(start); const adapter = f.adapters.get('codex')!, operationId = randomUUID();
  for (let attempt = 0; attempt < 3; attempt++) assert.equal((await f.tool(adapter, 'operation_cancel', { requestId: randomUUID(), params: { operationId } })).status, 400);
  const record = await f.get(String(start.params.taskId)); assert.equal(record.task.status, 'awaiting-input'); assert.equal(record.lastProblem, 'REPLAN_REQUIRED');
  assert.equal((await f.tool(adapter, 'build_compile', { requestId: randomUUID(), expectedProjectRevision: 1, params: { targetId: f.manifest.targets[0].targetId, sourceSnapshotId: f.sourceSnapshotId } })).status, 400);
  assert.equal(f.project.store.listOperations(f.project.projectId).length, 0);
});
test('source applicability remains stale after provider completion when saved bytes changed', async t => {
  const f = await fixture(t), start = f.start(); await f.call(start);
  assert.equal((await f.get(String(start.params.taskId)) as AgentRecord & { sourceCurrent: boolean }).sourceCurrent, true);
  writeFileSync(f.source, 'void setup() { /* accepted edit */ }\nvoid loop() {}\n');
  f.adapters.get('codex')!.finish(); await f.waitStatus(String(start.params.taskId), 'succeeded');
  assert.equal((await f.get(String(start.params.taskId)) as AgentRecord & { sourceCurrent: boolean }).sourceCurrent, false);
});
test('pin policy supplies retained source identity and preserves its historical applicability', async t => {
  const f = await fixture(t), first = f.start(); first.params.pinnedIds = [f.sourceSnapshotId];
  const current = await f.call<AgentRecord>(first);
  assert.equal(current.packet.evidenceRefs.find(item => item.evidenceId === f.sourceSnapshotId)?.applicability, 'current');
  f.adapters.get('codex')!.finish(); await f.waitStatus(String(first.params.taskId), 'succeeded');
  writeFileSync(f.source, '// source changed before handoff\n');
  const next = f.start(); next.params.sourceSnapshotId = null; next.params.pinnedIds = [f.sourceSnapshotId]; next.params.handoffTaskId = first.params.taskId;
  const historical = await f.call<AgentRecord>(next);
  assert.equal(historical.packet.evidenceRefs.find(item => item.evidenceId === f.sourceSnapshotId)?.applicability, 'historical');
  assert.ok(historical.packet.constraints.includes(`Handoff task: ${first.params.taskId}`));
  assert.equal(current.packet.evidenceRefs.find(item => item.evidenceId === f.sourceSnapshotId)?.applicability, 'current');
});

test('Codex to OpenCode handoff budgets historical facts before admission and retains exact document and pin IDs', async t => {
  const f = await fixture(t), documents = new DocumentService(f.project), documentId = randomUUID();
  const version = await documents.repository.ingest({ projectId: f.project.projectId, documentId, filename: 'handoff.txt', bytes: Buffer.from('Historical engineering reference; physical voltage remains unknown.'), mediaType: 'text/plain' });
  const citation = documents.repository.cite(f.project.projectId, { documentId, artifactSha256: version.artifactSha256, extractorVersion: version.extractorVersion, page: 1 });
  const selection = { kind: 'document-page' as const, documentId, artifactSha256: citation.artifactSha256, extractorVersion: citation.extractorVersion, page: 1, projectRevision: 1 };
  const first = f.start(); first.params.userText = 'x'.repeat(899) + '😀' + 'Preserve exact evidence and unknown physical behavior. '.repeat(120); first.params.selection = selection; first.params.pinnedIds = [f.sourceSnapshotId];
  const initial = await f.call<AgentRecord>(first), adapter = f.adapters.get('codex')!;
  adapter.emit({ type: 'agent.text.delta', payload: { turn: adapter.turn!, messageId: 'private-history', deltaIndex: 0, text: 'PROVIDER_PRIVATE_HISTORY_CANARY' } });
  adapter.finish(); const finished = await f.waitStatus(initial.task.taskId, 'succeeded');
  const checkpoint: AgentCheckpoint = { kind: 'agent-checkpoint', schemaVersion: 1, checkpointId: randomUUID(), taskId: initial.task.taskId, projectId: f.project.projectId, projectRevision: 1,
    sourceSnapshotId: f.sourceSnapshotId, createdAt: new Date().toISOString(), goal: initial.packet.task, decisions: Array.from({ length: 32 }, (_, index) => `Historical decision ${index}: ${'evidence remains historical; '.repeat(28)}`),
    completed: [{ summary: 'Inspected saved source only; no physical measurement.', evidenceRefs: [f.sourceSnapshotId] }], remaining: ['Measure voltage through an authorized physical observation.'], unknowns: ['Supply voltage is unknown.'], activeOperationIds: [], providerSessionRef: finished.turn!.session };
  f.project.store.putRecord('sessions', checkpoint.checkpointId, f.project.projectId, checkpoint);
  writeFileSync(f.source, '// changed after historical checkpoint\n');
  const next = f.start('opencode'); next.params.userText = initial.packet.task; next.params.sourceSnapshotId = null; next.params.handoffTaskId = initial.task.taskId; next.params.selection = selection; next.params.pinnedIds = [f.sourceSnapshotId];
  const record = await f.call<AgentRecord>(next), packet = validateContextPacket(record.packet), serialized = JSON.stringify(packet);
  assert.ok(Buffer.byteLength(serialized) <= 24576); assert.ok(Buffer.byteLength(serialized) > 22 * 1024, 'Fixture exercises near-budget assembly.');
  assert.equal(packet.task, initial.packet.task); assert.deepEqual(packet.selection, selection);
  assert.equal(packet.constraints.filter(item => item.startsWith('Historical handoff goal (')).map(item => item.slice(item.indexOf(': ') + 2)).join(''), checkpoint.goal);
  for (const item of packet.constraints) assert.equal(Buffer.from(item).toString('utf8'), item, 'Chunk boundaries cannot split the emoji surrogate pair.');
  assert.ok(packet.constraints.every(item => Array.from(item).length <= 1024));
  assert.ok(packet.constraints.includes(`Handoff task: ${initial.task.taskId}`)); assert.ok(packet.unknowns.some(item => item.startsWith('Provider-private history did not transfer.')));
  assert.equal(packet.evidenceRefs.find(item => item.evidenceId === f.sourceSnapshotId)?.applicability, 'historical');
  assert.ok(packet.evidenceRefs.some(item => item.sha256 === version.artifactSha256 && item.location.kind === 'page'));
  const retained = packet.evidenceRefs.find(item => item.sourceUri.startsWith('artifact://'))!;
  assert.ok(retained); assert.equal(retained.applicability, 'historical');
  assert.ok(packet.omitted.some(item => item.ref === retained.artifactId && item.reason === 'budget' && item.expansionHandle === `artifact:${retained.artifactId}`));
  const full = f.project.store.readArtifact(f.project.projectId, retained.artifactId!).toString('utf8'), history = JSON.parse(full.replaceAll('\n', ''));
  assert.deepEqual(history.decisions, checkpoint.decisions); assert.deepEqual(history.completed, checkpoint.completed); assert.deepEqual(history.unknowns, checkpoint.unknowns); assert.equal(history.goal, checkpoint.goal);
  assert.equal(full.includes('PROVIDER_PRIVATE_HISTORY_CANARY'), false); assert.equal(full.includes(finished.turn!.session.providerSessionId), false);
  assert.equal(serialized.includes('PROVIDER_PRIVATE_HISTORY_CANARY'), false); assert.equal(f.adapters.get('opencode')!.submits, 1); assert.deepEqual(record.task.operationIds, []);
  t.mock.method(f.project.store, 'storeArtifact', () => { assert.fail('Replaying or rejecting an admitted task must not create another handoff artifact.'); });
  const repeated = await f.call<AgentRecord>(next); assert.equal(repeated.packet.packetId, packet.packetId); assert.equal(f.adapters.get('opencode')!.submits, 1);
  await assert.rejects(f.call({ ...next, params: { ...next.params, handoffTaskId: randomUUID() } }), { code: 'INVALID_REQUEST' });
  await assert.rejects(f.call({ ...next, params: { ...next.params, pinnedIds: [] } }), { code: 'INVALID_REQUEST' });
  f.adapters.get('opencode')!.finish(); await f.waitStatus(record.task.taskId, 'succeeded');
});
