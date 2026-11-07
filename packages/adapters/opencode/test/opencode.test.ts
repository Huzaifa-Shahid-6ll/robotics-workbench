import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OpenCodeAdapter } from '../src/index.js';
import type { OpenSession, SubmitTurn, SessionRef } from '@robotics-workbench/contracts';
import { providerContract } from '../../../test-fixtures/agents/shared/provider-contract.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'opencode space '));
  const doc = { openapi: '3.1.0', info: { version: 'fixture' } };
  const calls: { path: string; method: string; body: unknown }[] = [];
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let version = '1.18.32'; let failPrompt = false; let messages: unknown[] = []; let busy = true; let permission: unknown;
  const fakeFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    assert.ok(request.headers.get('Authorization')?.startsWith('Basic '));
    const path = new URL(request.url).pathname;
    const text = request.method === 'POST' ? await request.text() : '';
    calls.push({ path, method: request.method, body: text ? JSON.parse(text) : null });
    const json = (value: unknown) => Response.json(value);
    if (path === '/global/health') return json({ healthy: true, version });
    if (path === '/doc') return json(doc);
    if (path === '/provider') return json({ connected: ['fixture'], all: [{ id: 'fixture', models: { 'test-model': {} } }] });
    if (path === '/session' && request.method === 'POST') { permission = JSON.parse(text).permission; return json({ id: 'ses_test', directory, permission }); }
    if (path === '/session/ses_test' && request.method === 'GET') return json({ id: 'ses_test', directory, permission });
    if (path === '/session/status') return json(busy ? { ses_test: { type: 'busy' } } : {});
    if (path === '/session/ses_test/message') return json(messages);
    if (path === '/session/ses_test/abort') { busy = false; return json(true); }
    if (path.includes('/permissions/')) return json(true);
    if (path === '/session/ses_test/prompt_async') { if (failPrompt) throw new Error('secret planted transport exception'); return new Response(null, { status: 204 }); }
    if (path === '/event') return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","properties":{}}\n\n')); } }), { headers: { 'content-type': 'text/event-stream' } });
    throw new Error(`Unexpected fixture endpoint ${path}`);
  };
  const adapter = new OpenCodeAdapter({ endpoint: 'http://127.0.0.1:4321', directory, password: 'planted-test-password', contextText: async () => '{"unknowns":["voltage unmeasured"]}', expectedFingerprint: createHash('sha256').update(JSON.stringify(doc)).digest('hex'), fetch: fakeFetch });
  const open: OpenSession = { projectId: randomUUID(), taskId: randomUUID(), projectRevision: 1, workspaceUri: pathToFileURL(directory).href, routeId: randomUUID(), model: { modelId: 'fixture/test-model', profileId: null }, permissionProfileId: 'read-only', resume: null };
  const session = await adapter.open(open);
  const submit: SubmitTurn = { clientTurnId: randomUUID(), session, projectRevision: 1, sourceSnapshotId: null, userText: 'Explain the missing voltage.', contextPacketId: randomUUID(), attachments: [], model: open.model };
  t.after(async () => { await adapter.close({ stopOwnedProcess: true }); try { stream?.close(); } catch {} await rm(directory, { recursive: true, force: true }); });
  return { adapter, session, open, submit, calls, send: async (value: unknown) => { stream!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)); await new Promise(resolve => setTimeout(resolve, 5)); }, setMessages: (value: unknown[]) => { messages = value; }, idle: () => { busy = false; }, failPrompt: () => { failPrompt = true; }, changeVersion: () => { version = '99.0.0'; } };
}

test('OpenCode supplies exact bounded context, deduplicates turn IDs and rejects cross-project sessions and images', async t => {
  const f = await fixture(t);
  const turn = await f.adapter.submit(f.submit);
  assert.deepEqual(await f.adapter.submit(f.submit), turn);
  const prompts = f.calls.filter(call => call.path.endsWith('/prompt_async'));
  assert.equal(prompts.length, 1);
  assert.match(JSON.stringify(prompts[0].body), /voltage unmeasured/);
  await assert.rejects(() => f.adapter.submit({ ...f.submit, userText: 'different' }), { code: 'PROTOCOL_ERROR' });
  await assert.rejects(() => f.adapter.submit({ ...f.submit, session: { ...f.session, projectId: randomUUID() } }), { code: 'WORKSPACE_MISMATCH' });
  await assert.rejects(() => f.adapter.submit({ ...f.submit, attachments: [{ artifactId: randomUUID(), sha256: 'a'.repeat(64), mediaType: 'image/png', displayName: 'image', byteLength: 1 }] }), { code: 'CAPABILITY_UNSUPPORTED' });
  assert.ok(!f.calls.some(call => call.method === 'PATCH' || call.path.includes('/config')));
});

test('OpenCode normalizes assistant events once and filters user or unrelated-session text', async t => {
  const f = await fixture(t); const turn = await f.adapter.submit(f.submit);
  const iterator = f.adapter.observe(f.session)[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, 'agent.session.opened');
  assert.equal((await iterator.next()).value?.type, 'agent.turn.started');
  await f.send({ type: 'message.part.updated', properties: { part: { id: 'user', sessionID: 'ses_test', messageID: turn.providerTurnId, type: 'text', text: 'User prompt must not be assistant text' } } });
  await f.send({ type: 'message.updated', properties: { info: { id: 'assistant', sessionID: 'ses_test', role: 'assistant', parentID: turn.providerTurnId } } });
  const part = { id: 'part', sessionID: 'ses_test', messageID: 'assistant', type: 'text', text: 'Hello' };
  await f.send({ type: 'message.part.updated', properties: { part: { ...part, sessionID: 'ses_other' } } });
  await f.send({ type: 'message.part.updated', properties: { part } });
  await f.send({ type: 'message.part.updated', properties: { part } });
  await f.send({ type: 'message.part.updated', properties: { part: { ...part, text: 'Hello world' } } });
  const first = (await iterator.next()).value; const second = (await iterator.next()).value;
  assert.equal(first?.type, 'agent.text.delta'); assert.equal(second?.type, 'agent.text.delta');
  if (first?.type === 'agent.text.delta' && second?.type === 'agent.text.delta') { assert.equal(first.payload.text, 'Hello'); assert.equal(first.payload.deltaIndex, 0); assert.equal(second.payload.text, ' world'); assert.equal(second.payload.deltaIndex, 1); }
  await iterator.return?.();
});

test('OpenCode approvals correlate all fields and never broaden once to always', async t => {
  const f = await fixture(t); await f.adapter.submit(f.submit);
  await f.send({ type: 'permission.asked', properties: { id: 'permission_one', sessionID: 'ses_test', permission: 'bash', patterns: ['echo OK token=planted-secret'], metadata: {} } });
  const snapshot = await f.adapter.reconcile(f.session); const approval = snapshot.pendingApprovals[0];
  assert.ok(approval); assert.deepEqual(approval.permittedScopes, ['once']); assert.doesNotMatch(JSON.stringify(approval), /planted-secret/); assert.match(approval.targetSummary, /echo OK/);
  const answer = { ...approval, decision: 'allow' as const, scope: 'once' as const };
  await assert.rejects(() => f.adapter.answerApproval({ ...answer, expectedProjectRevision: 2 }), { code: 'APPROVAL_EXPIRED' });
  await assert.rejects(() => f.adapter.answerApproval({ ...answer, scope: 'task' }), { code: 'APPROVAL_EXPIRED' });
  await f.adapter.answerApproval(answer);
  await assert.rejects(() => f.adapter.answerApproval(answer), { code: 'APPROVAL_EXPIRED' });
  assert.deepEqual(f.calls.find(call => call.path.includes('/permissions/'))?.body, { response: 'once' });
});

test('OpenCode lost prompt acknowledgement is unknown and reconciliation never resubmits', async t => {
  const f = await fixture(t); f.failPrompt();
  await assert.rejects(() => f.adapter.submit(f.submit), error => { assert.equal((error as { code: string }).code, 'TRANSPORT_LOST'); assert.doesNotMatch(String(error), /planted/); return true; });
  assert.equal((await f.adapter.reconcile(f.session)).latestTurnStatus, 'outcome-unknown');
  await f.adapter.submit(f.submit);
  assert.equal(f.calls.filter(call => call.path.endsWith('/prompt_async')).length, 1);
});

test('OpenCode interruption needs authoritative aborted message and version drift blocks new work', async t => {
  const f = await fixture(t); const turn = await f.adapter.submit(f.submit);
  f.setMessages([{ info: { id: 'assistant', parentID: turn.providerTurnId, sessionID: 'ses_test', role: 'assistant', time: { completed: Date.now() }, error: { name: 'MessageAbortedError' }, tokens: { input: 3, output: 1, cache: { read: 0 } } }, parts: [{ type: 'text', text: 'partial' }] }]);
  await f.adapter.interrupt(turn);
  const snapshot = await f.adapter.reconcile(f.session);
  assert.equal(snapshot.latestTurnStatus, 'cancelled'); assert.equal(snapshot.activeTurn, null);
  f.changeVersion();
  await assert.rejects(() => f.adapter.submit({ ...f.submit, clientTurnId: randomUUID() }), { code: 'PROVIDER_UNSUPPORTED' });
});

test('OpenCode borrowed close does not call global/session disposal or abort', async t => {
  const f = await fixture(t);
  await f.adapter.close({ stopOwnedProcess: true });
  assert.ok(!f.calls.some(call => /dispose|abort/.test(call.path)));
});

test('OpenCode expired approvals and denial preserve once-only authorization', async t => {
  const f = await fixture(t); await f.adapter.submit(f.submit);
  await f.send({ type: 'permission.asked', properties: { id: 'deny', sessionID: 'ses_test', permission: 'edit', patterns: ['fixture.cpp'] } });
  const denied = (await f.adapter.reconcile(f.session)).pendingApprovals[0];
  await f.adapter.answerApproval({ ...denied, decision: 'deny', scope: 'once' });
  assert.deepEqual(f.calls.find(call => call.path.endsWith('/permissions/deny'))?.body, { response: 'reject' });
  await f.send({ type: 'permission.asked', properties: { id: 'expire', sessionID: 'ses_test', permission: 'edit', patterns: ['fixture.cpp'] } });
  const expired = (await f.adapter.reconcile(f.session)).pendingApprovals[0];
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(5 * 60_000 + 1);
  await assert.rejects(() => f.adapter.answerApproval({ ...expired, decision: 'allow', scope: 'once' }), { code: 'APPROVAL_EXPIRED' });
  assert.ok(!f.calls.some(call => call.path.endsWith('/permissions/expire')));
});

test('OpenCode refuses resuming another active writer and model fallback', async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.adapter.open({ ...f.open, resume: f.session }), { code: 'PROTOCOL_ERROR' });
  await assert.rejects(() => f.adapter.submit({ ...f.submit, model: { modelId: 'fixture/absent', profileId: null } }), { code: 'MODEL_UNAVAILABLE' });
  assert.ok(!f.calls.some(call => call.path.endsWith('/prompt_async')));
});

test('OpenCode confirms per-session read-only permissions and rejects unknown or widened profiles', async t => {
  const f = await fixture(t);
  const created = f.calls.find(call => call.path === '/session' && call.method === 'POST')?.body as { permission: { permission: string; pattern: string; action: string }[] };
  assert.deepEqual(created.permission[0], { permission: '*', pattern: '*', action: 'deny' });
  assert.ok(!created.permission.some(rule => rule.permission === 'bash' || rule.permission === 'edit'));
  await assert.rejects(() => f.adapter.open({ ...f.open, permissionProfileId: 'unknown' }), { code: 'CAPABILITY_UNSUPPORTED' });
  f.idle();
  await assert.rejects(() => f.adapter.open({ ...f.open, permissionProfileId: 'workspace-write', resume: f.session }), { code: 'CAPABILITY_UNSUPPORTED' });
});

test('OpenCode rejects unauthenticated non-loopback endpoints before connection', () => {
  assert.throws(() => new OpenCodeAdapter({ endpoint: 'http://example.com', directory: '.', password: 'x', contextText: async () => '' }), { code: 'PROVIDER_UNSUPPORTED' });
});

providerContract('OpenCode', async t => {
  const f = await fixture(t);
  return { ...f, finish: async turn => {
    f.setMessages([{ info: { id: 'assistant', sessionID: f.session.providerSessionId, role: 'assistant', parentID: turn.providerTurnId, time: { completed: Date.now() }, tokens: { input: 1, output: 1, cache: { read: 0 } } }, parts: [{ type: 'text', text: 'Complete' }] }]);
    f.idle(); await f.adapter.reconcile(f.session);
  } };
});
