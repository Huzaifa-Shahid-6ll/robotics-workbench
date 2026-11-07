import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ApprovalAnswer, OpenSession, SubmitTurn } from '@robotics-workbench/contracts';
import { CodexAdapter, StdioCodexTransport, type CodexTransport, type RpcMessage } from '../src/index.js';
import { providerContract } from '../../../test-fixtures/agents/shared/provider-contract.js';

class FakeTransport implements CodexTransport {
  calls: { method: string; params: unknown }[] = [];
  responses: { id: string | number; result: unknown }[] = [];
  onMessage: (value: RpcMessage) => void = () => {};
  onDisconnect: () => void = () => {};
  turns: unknown[] = [];
  cwd = process.cwd();
  failInitialize = false;
  failSubmit = false;
  async request(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === 'initialize') { if (this.failInitialize) throw Error('init failed'); return { userAgent: 'test', platformOs: 'windows', platformFamily: 'windows' }; }
    if (method === 'account/read') return { account: { type: 'chatgpt' }, requiresOpenaiAuth: true };
    if (method === 'model/list') return { data: [{ id: 'm', model: 'model' }] };
    if (method === 'thread/start' || method === 'thread/resume' || method === 'thread/read') return { thread: { id: 'thread', cwd: this.cwd, turns: this.turns } };
    if (method === 'turn/start') { if (this.failSubmit) throw Error('ack lost'); return { turn: { id: 'turn', status: 'inProgress', items: [] } }; }
    return {};
  }
  notify(method: string): void { this.calls.push({ method, params: null }); }
  respond(id: string | number, result: unknown): void { this.responses.push({ id, result }); }
  listen(message: (value: RpcMessage) => void, disconnected: () => void): void { this.onMessage = message; this.onDisconnect = disconnected; }
  async close(): Promise<void> { this.onDisconnect(); }
  emit(method: string, params: unknown, id?: number): void { this.onMessage({ method, params, ...(id === undefined ? {} : { id }) }); }
}
async function setup(context = '{}') {
  const wire = new FakeTransport(); wire.cwd = await realpath(process.cwd());
  let sequence = 100;
  const adapter = new CodexAdapter({ executable: 'unused.exe', version: async () => 'codex-cli 0.160.1', contextPacket: async () => context, transportFactory: () => wire, nextSequence: () => ++sequence });
  const input: OpenSession = { projectId: randomUUID(), taskId: randomUUID(), projectRevision: 1, workspaceUri: pathToFileURL(wire.cwd).href, routeId: randomUUID(), model: { modelId: 'model', profileId: null }, permissionProfileId: 'read-only', resume: null };
  const session = await adapter.open(input);
  const turnInput: SubmitTurn = { clientTurnId: randomUUID(), session, projectRevision: 1, sourceSnapshotId: null, userText: 'Explain a compile error.', contextPacketId: randomUUID(), attachments: [], model: input.model };
  return { adapter, wire, input, session, turnInput };
}
test('Codex initializes before thread methods; normalizes terminal state and replay without hardware claims', async () => {
  const { adapter, wire, session, turnInput } = await setup();
  assert.deepEqual(wire.calls.slice(0, 5).map(value => value.method), ['initialize', 'initialized', 'account/read', 'model/list', 'thread/start']);
  const turn = await adapter.submit(turnInput);
  const same = await adapter.submit(turnInput); assert.deepEqual(same, turn);
  assert.equal(wire.calls.filter(value => value.method === 'turn/start').length, 1);
  wire.emit('item/agentMessage/delta', { threadId: 'thread', turnId: 'turn', itemId: 'msg', delta: 'Hello' });
  wire.turns = [{ id: 'turn', status: 'completed', items: [{ id: 'msg', type: 'agentMessage', text: 'Hello' }] }];
  const completion = { threadId: 'thread', turn: wire.turns[0] };
  wire.emit('turn/completed', completion); wire.emit('turn/completed', completion);
  const snapshot = await adapter.reconcile(session); assert.equal(snapshot.latestTurnStatus, 'succeeded'); assert.equal(snapshot.messages[0].text, 'Hello');
  await adapter.close({ stopOwnedProcess: true });
  const events = []; for await (const event of adapter.observe(session)) events.push(event);
  assert.equal(events.filter(value => value.type === 'agent.turn.finished').length, 1);
  assert.equal(events[0].sequence, 101);
});
test('Codex validates capabilities/models/workspace and blocks parallel writers before context resolves', async () => {
  const { adapter, wire, input, session, turnInput } = await setup();
  await assert.rejects(adapter.submit({ ...turnInput, attachments: [{ artifactId: randomUUID(), sha256: 'a'.repeat(64), mediaType: 'image/png', displayName: 'image', byteLength: 1 }] }), { code: 'CAPABILITY_UNSUPPORTED' });
  await assert.rejects(adapter.open({ ...input, model: { modelId: 'absent', profileId: null } }), { code: 'MODEL_UNAVAILABLE' });
  await assert.rejects(adapter.open({ ...input, resume: { ...session, projectId: randomUUID() } }), { code: 'WORKSPACE_MISMATCH' });
  const first = adapter.submit(turnInput);
  await assert.rejects(adapter.submit({ ...turnInput, clientTurnId: randomUUID() }), { code: 'REVISION_CONFLICT' }); await first;
  assert.equal(wire.calls.filter(value => value.method === 'turn/start').length, 1); await adapter.close({ stopOwnedProcess: true });
});
test('Codex correlates one-time approvals and refuses reused, broadened or wrong-target answers', async () => {
  const { adapter, wire, session, turnInput } = await setup(); const turn = await adapter.submit(turnInput);
  wire.emit('item/commandExecution/requestApproval', { threadId: 'thread', turnId: 'turn', itemId: 'cmd', command: 'echo token=SECRET' }, 27);
  wire.emit('item/commandExecution/requestApproval', { threadId: 'thread', turnId: 'turn', itemId: 'cmd', command: 'echo token=SECRET' }, 27);
  let snapshot = await adapter.reconcile(session); assert.equal(snapshot.pendingApprovals.length, 1);
  const approval = snapshot.pendingApprovals[0]; assert.ok(!approval.targetSummary.includes('SECRET'));
  const answer: ApprovalAnswer = { approvalId: approval.approvalId, providerRequestId: approval.providerRequestId, turn, decision: 'allow', scope: 'once', expectedProjectRevision: 1, deviceId: null, artifactSha256: null };
  await assert.rejects(adapter.answerApproval({ ...answer, scope: 'task' }), { code: 'APPROVAL_EXPIRED' });
  await assert.rejects(adapter.answerApproval({ ...answer, deviceId: randomUUID() }), { code: 'APPROVAL_EXPIRED' });
  await adapter.answerApproval(answer); assert.deepEqual(wire.responses, [{ id: 27, result: { decision: 'accept' } }]);
  await assert.rejects(adapter.answerApproval(answer), { code: 'APPROVAL_EXPIRED' });
  snapshot = await adapter.reconcile(session); assert.equal(snapshot.pendingApprovals.length, 0); await adapter.close({ stopOwnedProcess: true });
});
test('Codex lost submit acknowledgement is never replayed and disconnection keeps unknown state', async () => {
  const { adapter, wire, session, turnInput } = await setup(); wire.failSubmit = true;
  await assert.rejects(adapter.submit(turnInput)); await assert.rejects(adapter.submit(turnInput));
  assert.equal(wire.calls.filter(value => value.method === 'turn/start').length, 1);
  wire.onDisconnect(); assert.equal((await adapter.reconcile(session)).latestTurnStatus, 'outcome-unknown');
});
test('Codex initialization failure never sends thread/start', async () => {
  const wire = new FakeTransport(); wire.failInitialize = true;
  const adapter = new CodexAdapter({ executable: 'unused.exe', version: async () => 'codex-cli 0.160.1', contextPacket: async () => '{}', transportFactory: () => wire });
  await assert.rejects(adapter.open({ projectId: randomUUID(), taskId: randomUUID(), projectRevision: 1, workspaceUri: pathToFileURL(await realpath(process.cwd())).href, routeId: randomUUID(), model: { modelId: 'model', profileId: null }, permissionProfileId: 'read-only', resume: null }));
  assert.deepEqual(wire.calls.map(value => value.method), ['initialize']);
});

test('Codex interrupt waits for upstream turn start instead of treating admission as running', async () => {
  const { adapter, wire, turnInput } = await setup(); const turn = await adapter.submit(turnInput);
  const interrupt = adapter.interrupt(turn);
  assert.equal(wire.calls.filter(call => call.method === 'turn/interrupt').length, 0);
  wire.emit('turn/started', { threadId: 'thread', turn: { id: 'turn' } }); await interrupt;
  assert.equal(wire.calls.filter(call => call.method === 'turn/interrupt').length, 1); await adapter.close({ stopOwnedProcess: true });
});
test('Codex runtime MCP names cannot overwrite provider-owned configuration', async () => {
  const wire = new FakeTransport();
  const request = wire.request.bind(wire); wire.request = async (method, params) => method === 'config/read' ? { config: { mcp_servers: { robotics: { command: 'user-command' } } } } : request(method, params);
  const adapter = new CodexAdapter({ executable: 'unused.exe', version: async () => 'codex-cli 0.160.1', contextPacket: async () => '{}', transportFactory: () => wire, runtimeConfig: { mcp_servers: { robotics: { command: 'workbench-command' } } } });
  await assert.rejects(adapter.open({ projectId: randomUUID(), taskId: randomUUID(), projectRevision: 1, workspaceUri: pathToFileURL(await realpath(process.cwd())).href, routeId: randomUUID(), model: { modelId: 'model', profileId: null }, permissionProfileId: 'read-only', resume: null }), { code: 'REVISION_CONFLICT' });
  assert.equal(wire.calls.filter(call => call.method === 'thread/start').length, 0);
});
providerContract('Codex', async () => {
  const { adapter, wire, input, session, turnInput } = await setup();
  return { adapter, open: input, session, submit: turnInput, finish(turn) { wire.turns = [{ id: turn.providerTurnId, status: 'completed', items: [{ id: 'msg', type: 'agentMessage', text: 'Normalized answer.' }] }]; wire.emit('turn/completed', { threadId: 'thread', turn: wire.turns[0] }); }, dispose: () => adapter.close({ stopOwnedProcess: true }) };
});
test('Codex native stdio separates stderr, validates stdout and terminates its owned process', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'workbench-codex-wire-'));
  await writeFile(join(cwd, 'app-server'), `const readline = require('node:readline'); console.error('Bearer planted-secret'); readline.createInterface({input:process.stdin}).on('line',line=>{const msg=JSON.parse(line);if(msg.method==='malformed') console.log('not-json');else console.log(JSON.stringify({id:msg.id,result:{echo:true}}));});`);
  const wire = new StdioCodexTransport(process.execPath, cwd); let disconnected = false; wire.listen(() => {}, () => { disconnected = true; });
  try { assert.deepEqual(await wire.request('read', {}), { echo: true }); await assert.rejects(wire.request('malformed', {}), { code: 'TRANSPORT_LOST' }); assert.equal(disconnected, true); }
  finally { await wire.close(); assert.ok(cwd.startsWith(join(tmpdir(), 'workbench-codex-wire-'))); await rm(cwd, { recursive: true, force: true }); }
});
