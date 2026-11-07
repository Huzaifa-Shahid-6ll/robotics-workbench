import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AgentRuntime, type AgentRecord, type AgentStore, type StartAgentTask } from '@robotics-workbench/agents';
import { WorkbenchError, type ApprovalRequest, type OpenSession, type ProjectRequest, type ProviderId, type SubmitTurn } from '@robotics-workbench/contracts';
import { JourneyProvider } from '../../../packages/test-fixtures/recovery/provider';
import { AgentService } from '../src/agent-service';
import { ProjectService } from '../src/project-service';
import type { HardwareService } from '../src/hardware-service';

class TrackedProvider extends JourneyProvider {
  closes = 0;
  failClose = false;
  failSubmit = false;
  resumed: OpenSession[] = [];
  beforeClose?: () => void;
  constructor(providerId: ProviderId, readonly binding: { endpoint: string; token: string }) { super(providerId); }
  override async open(input: OpenSession) { this.resumed.push(input); return super.open(input); }
  override async submit(input: SubmitTurn) { const turn = await super.submit(input); if (this.failSubmit) throw new Error('Synthetic lost submit acknowledgement'); return turn; }
  override async close() { this.closes++; this.beforeClose?.(); if (this.failClose) throw new Error('Synthetic owned-process termination failure'); await super.close(); }
}
async function fixture(t: TestContext) {
  const temp = mkdtempSync(join(tmpdir(), 'workbench-agent-lifecycle-')), root = join(temp, 'Probe'); mkdirSync(root);
  const manifest = JSON.parse(readFileSync('examples/workbench.valid.json', 'utf8')); manifest.sketches[0].path = '.';
  writeFileSync(join(root, 'workbench.json'), JSON.stringify(manifest)); writeFileSync(join(root, 'Probe.ino'), 'void setup() {}\nvoid loop() {}\n');
  const project = new ProjectService(root, join(temp, 'data')), providers: TrackedProvider[] = [];
  let configure: ((provider: TrackedProvider) => void) | undefined;
  const service = new AgentService(project, { supports: () => false } as unknown as HardwareService,
    { codexPath: process.execPath, opencodePath: process.execPath, nodePath: process.execPath, mcpScript: join(temp, 'unused.cjs') },
    async (id, _context, config) => {
      const server = Object.values(config[id === 'codex' ? 'mcp_servers' : 'mcp'] as Record<string, Record<string, unknown>>)[0], env = server[id === 'codex' ? 'env' : 'environment'] as Record<string, string>;
      const provider = new TrackedProvider(id, { endpoint: env.ROBOTICS_TOOL_ENDPOINT, token: env.ROBOTICS_TOOL_TOKEN }); providers.push(provider); configure?.(provider); return provider;
    });
  t.after(async () => { for (const provider of providers) provider.failClose = false; await service.close(); await project.shutdown(); rmSync(temp, { recursive: true, force: true }); });
  const request = (method: ProjectRequest['method'], params: Record<string, unknown> = {}, revision?: number): ProjectRequest => ({ schemaVersion: 1, requestId: randomUUID(), projectId: project.projectId, method, params, ...(revision === undefined ? {} : { expectedProjectRevision: revision }) });
  const call = async <T>(input: ProjectRequest) => { const response = await service.handle(input); if (response.error) throw new WorkbenchError(response.error.code, response.error.message); return response.result as T; };
  const start = (providerId: ProviderId = 'codex') => request('agent.start', { taskId: randomUUID(), clientTurnId: randomUUID(), providerId, modelId: 'synthetic', permissionProfileId: 'read-only', userText: 'Explain retained source only.', sourceSnapshotId: null }, 1);
  const get = (taskId: string) => call<AgentRecord>(request('agent.get', { taskId }));
  const wait = async (taskId: string, status = 'succeeded') => { for (let i = 0; i < 100; i++) { const record = await get(taskId); if (record.task.status === status) return record; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('Task did not reach its expected state.'); };
  const entryCount = () => (service as unknown as { entries: Map<string, unknown> }).entries.size;
  const closedBridge = (provider: TrackedProvider) => assert.rejects(fetch(provider.binding.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${provider.binding.token}` }, body: '{}' }), /fetch failed/);
  return { project, service, providers, request, call, start, get, wait, entryCount, closedBridge, configure: (callback: typeof configure) => { configure = callback; } };
}

test('six sequential completed tasks release task providers and TCP listeners after durable checkpoints', async t => {
  const f = await fixture(t);
  f.configure(provider => { provider.beforeClose = () => assert.ok(f.project.store.listRecords<{ kind: string; taskId?: string }>('sessions', f.project.projectId).some(item => item.kind === 'agent-checkpoint' && item.taskId === provider.session.taskId)); });
  for (let index = 0; index < 6; index++) {
    const record = await f.call<AgentRecord>(f.start(index % 2 ? 'opencode' : 'codex')), provider = f.providers.at(-1)!;
    provider.finish(); await f.wait(record.task.taskId); assert.equal(provider.closes, 1); assert.equal(f.entryCount(), 0); await f.closedBridge(provider);
  }
  assert.equal(f.providers.length, 6); assert.ok(f.providers.every(provider => provider.closes === 1 && provider.submits === 1));
});

test('three rejected admissions close their providers and bridges without touching the active writer', async t => {
  const f = await fixture(t), active = await f.call<AgentRecord>(f.start()), writer = f.providers[0];
  for (let index = 0; index < 3; index++) {
    await assert.rejects(f.call(f.start('opencode')), { code: 'PROJECT_BUSY' });
    const rejected = f.providers.at(-1)!; assert.equal(rejected.submits, 0); assert.equal(rejected.closes, 1); await f.closedBridge(rejected); assert.equal(f.entryCount(), 1);
    assert.equal(writer.closes, 0); assert.equal((await f.get(active.task.taskId)).task.status, 'running');
  }
  writer.finish(); await f.wait(active.task.taskId);
});

test('historical get, handoff, repeated start and explicit completed reconciliation never revive a provider', async t => {
  const f = await fixture(t), input = f.start(), record = await f.call<AgentRecord>(input), provider = f.providers[0]; provider.finish(); const { sourceCurrent: _sourceCurrent, ...terminal } = await f.wait(record.task.taskId) as AgentRecord & { sourceCurrent: boolean };
  assert.equal(f.entryCount(), 0);
  assert.equal((await f.get(record.task.taskId)).task.status, 'succeeded');
  const handoff = await f.call<{ goal: string; context: { projectId: string } }>(f.request('agent.handoff', { taskId: record.task.taskId })); assert.equal(handoff.goal, terminal.packet.task); assert.equal(handoff.context.projectId, f.project.projectId);
  assert.deepEqual(await f.call(f.request('agent.reconcile', { taskId: record.task.taskId })), terminal);
  assert.deepEqual(await f.call(input), terminal); assert.equal(f.providers.length, 1); assert.equal(provider.submits, 1); assert.equal(provider.resumed.length, 1); assert.equal(f.entryCount(), 0);
});

test('awaiting-input and pending approvals retain the active connection and keep a second writer refused', async t => {
  const f = await fixture(t), initial = await f.call<AgentRecord>(f.start()), provider = f.providers[0], store = (f.service as unknown as { store: AgentStore }).store;
  const approval: ApprovalRequest = { approvalId: randomUUID(), providerRequestId: 'pending-read', turn: initial.turn!, action: 'read', targetSummary: 'source only', expectedProjectRevision: 1, deviceId: null, artifactSha256: null, permittedScopes: ['once'], expiresAt: new Date(Date.now() + 60000).toISOString() };
  store.put({ ...initial, task: { ...initial.task, status: 'awaiting-input' }, pendingApprovals: [approval] });
  const waiting = await f.get(initial.task.taskId); assert.equal(waiting.task.status, 'awaiting-input'); assert.equal(waiting.pendingApprovals.length, 1); assert.equal(provider.closes, 0);
  await assert.rejects(f.call(f.start('opencode')), { code: 'PROJECT_BUSY' }); assert.equal(provider.closes, 0); assert.equal(f.entryCount(), 1);
  store.put(initial); provider.finish(); await f.wait(initial.task.taskId); assert.equal(provider.closes, 1);
});

test('unknown delivery retains its provider until explicit reconciliation confirms no active turn and never resubmits', async t => {
  const f = await fixture(t); f.configure(provider => { provider.failSubmit = true; }); const input = f.start(); await assert.rejects(f.call(input));
  const taskId = String(input.params.taskId), provider = f.providers[0]; assert.equal((await f.get(taskId)).task.status, 'outcome-unknown'); assert.equal(provider.closes, 0);
  await assert.rejects(f.call(f.start('opencode')), { code: 'PROJECT_BUSY' }); assert.equal(provider.closes, 0);
  const active = await f.call<AgentRecord>(f.request('agent.reconcile', { taskId })); assert.ok(active.reconciliations.at(-1)?.snapshot.activeTurn); assert.equal(provider.closes, 0);
  provider.finish(); const reconciled = await f.call<AgentRecord>(f.request('agent.reconcile', { taskId })); assert.equal(reconciled.task.status, 'outcome-unknown'); assert.equal(provider.closes, 1); assert.equal(provider.submits, 1); assert.equal(f.entryCount(), 0);
  f.configure(undefined); const next = await f.call<AgentRecord>(f.start('opencode')); assert.equal(provider.submits, 1); f.providers.at(-1)!.finish(); await f.wait(next.task.taskId);
});

test('failed resource termination retains the successful receipt, closes its bridge and blocks new provider launches until retry', async t => {
  const f = await fixture(t), input = f.start(), record = await f.call<AgentRecord>(input), provider = f.providers[0]; provider.failClose = true; provider.finish();
  await assert.rejects(f.wait(record.task.taskId), { code: 'OUTCOME_UNKNOWN' }); await f.closedBridge(provider); const count = f.providers.length;
  const rows = f.project.store.listRecords<{ kind: string; record?: AgentRecord; taskId?: string; code?: string }>('sessions', f.project.projectId), terminal = rows.filter(row => row.kind === 'agent-record').at(-1)!.record!;
  assert.equal(terminal.task.status, 'succeeded'); assert.ok(rows.some(row => row.kind === 'agent-resource-release' && row.taskId === record.task.taskId && row.code === 'OUTCOME_UNKNOWN'));
  const failedAttempts = provider.closes; await assert.rejects(f.get(record.task.taskId), { code: 'OUTCOME_UNKNOWN' }); assert.equal(provider.closes, failedAttempts, 'Historical reads cannot silently retry failed process termination.');
  await assert.rejects(f.call(f.start('opencode')), { code: 'OUTCOME_UNKNOWN' }); assert.equal(f.providers.length, count); assert.equal(f.entryCount(), 1);
  provider.failClose = false; assert.deepEqual(await f.call(f.request('agent.reconcile', { taskId: record.task.taskId })), terminal); assert.equal(f.entryCount(), 0); assert.equal(provider.submits, 1);
  const next = await f.call<AgentRecord>(f.start()); f.providers.at(-1)!.finish(); await f.wait(next.task.taskId);
});

test('persisted-only runtime reads and checkpoints safely but refuses provider actions before changing records', async t => {
  const f = await fixture(t), initial = await f.call<AgentRecord>(f.start()), store = (f.service as unknown as { store: AgentStore }).store;
  const runtime = new AgentRuntime({}, store, () => ({ projectRevision: 1, sourceSnapshotId: null, workspaceUri: pathToFileURL(f.project.files.root).href }));
  const checkpoint = runtime.checkpoint(initial.task.taskId, f.project.projectId, { decisions: [], completed: [], remaining: [], unknowns: [], activeOperationIds: [] }, () => false);
  assert.equal(runtime.handoff(checkpoint, initial.packet).goal, initial.packet.task);
  await assert.rejects(runtime.interrupt(initial.task.taskId, f.project.projectId), { code: 'PROVIDER_UNSUPPORTED' }); await assert.rejects(runtime.reconcile(initial.task.taskId, f.project.projectId), { code: 'PROVIDER_UNSUPPORTED' });
  const approval: ApprovalRequest = { approvalId: randomUUID(), providerRequestId: 'synthetic-approval', turn: initial.turn!, action: 'read', targetSummary: 'source only', expectedProjectRevision: 1, deviceId: null, artifactSha256: null, permittedScopes: ['once'], expiresAt: new Date(Date.now() + 60000).toISOString() };
  const pending = { ...initial, task: { ...initial.task, status: 'awaiting-input' as const }, pendingApprovals: [approval] }; store.put(pending);
  await assert.rejects(runtime.answerApproval(initial.task.taskId, f.project.projectId, { ...approval, decision: 'deny', scope: 'once' }), { code: 'PROVIDER_UNSUPPORTED' }); assert.deepEqual(runtime.get(initial.task.taskId, f.project.projectId), pending);
  f.providers[0].finish(); await f.wait(initial.task.taskId);
  const taskId = randomUUID(), input: StartAgentTask = { providerId: 'codex', taskId, clientTurnId: randomUUID(), packet: initial.packet, userText: initial.userText, attachments: [], open: { ...initial.open, taskId, routeId: randomUUID(), resume: null } };
  await assert.rejects(runtime.start(input), { code: 'PROVIDER_UNSUPPORTED' }); assert.equal(store.get(taskId, f.project.projectId), undefined); assert.equal(f.providers[0].submits, 1);
});
