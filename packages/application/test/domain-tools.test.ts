import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DomainTools, domainMethods, domainToolNames, domainToolDefinitions } from '../src/tools/index';
import { isProjectRequest } from '@robotics-workbench/contracts';

test('each MCP name maps once to its domain method and fixes project scope', async () => {
  const projectId = randomUUID(); let calls = 0;
  const tools = new DomainTools(projectId, async request => { calls++; assert.equal(request.projectId, projectId); return { schemaVersion: 1, requestId: request.requestId, result: { observed: true } }; }, async () => {}, () => { throw Error(); });
  assert.equal(new Set(Object.values(domainToolNames)).size, domainMethods.length);
  const result = await tools.call('project_snapshot', { requestId: randomUUID(), params: {} });
  assert.equal(JSON.parse(result.content[0].text).result.observed, true);
  await assert.rejects(tools.call('project_snapshot', { requestId: randomUUID(), projectId: randomUUID(), params: {} }));
  await assert.rejects(tools.call('project_snapshot', { requestId: randomUUID(), params: { arbitrary: true } }));
  assert.equal(calls, 1);
});
test('tool admission policy runs before effect and oversized evidence is retained', async () => {
  let calls = 0, retained = 0;
  const tools = new DomainTools(randomUUID(), async request => { calls++; return { schemaVersion: 1, requestId: request.requestId, result: 'x'.repeat(20000) }; }, async request => { if (request.method === 'operation.cancel') throw Error('denied'); }, () => { retained++; return { artifactId: randomUUID(), sha256: 'a'.repeat(64) }; });
  await assert.rejects(tools.call('operation_cancel', { requestId: randomUUID(), params: { operationId: randomUUID() } }));
  assert.equal(calls, 0);
  const result = await tools.call('project_snapshot', { requestId: randomUUID(), params: {} });
  assert.ok(Buffer.byteLength(result.content[0].text) < 16384);
  assert.equal(JSON.parse(result.content[0].text).truncated, true); assert.equal(retained, 1);
});
test('long native recordings remain separate from the one-minute MCP capture authority', async () => {
  const projectId = randomUUID(), params = { deviceId: randomUUID(), baudRate: 9600, durationMs: 600000 }, requestId = randomUUID();
  assert.equal(isProjectRequest({ schemaVersion: 1, requestId, projectId, method: 'serial.capture', params }), true);
  assert.equal(isProjectRequest({ schemaVersion: 1, requestId, projectId, method: 'serial.capture', params: { ...params, durationMs: 3600001 } }), false);
  const schema = domainToolDefinitions.find(tool => tool.name === 'serial_capture')!.inputSchema.properties.params;
  assert.equal((schema.properties.durationMs as { maximum: number }).maximum, 60000);
  let calls = 0, authorizations = 0;
  const tools = new DomainTools(projectId, async request => { calls++; return { schemaVersion: 1, requestId: request.requestId, result: {} }; }, async () => { authorizations++; }, () => { throw Error(); });
  await assert.rejects(tools.call('serial_capture', { requestId, params }), { code: 'INVALID_REQUEST' }); assert.equal(calls, 0); assert.equal(authorizations, 0);
  await tools.call('serial_capture', { requestId: randomUUID(), params: { ...params, durationMs: 60000 } }); assert.equal(calls, 1); assert.equal(authorizations, 1);
});

test('diagnostic preview and filesystem export remain host-only and cannot be invoked as provider tools', async () => {
  let calls = 0, authorizations = 0;
  const tools = new DomainTools(randomUUID(), async () => { calls++; throw Error('Host-only diagnostic reached dispatch'); }, async () => { authorizations++; }, () => { throw Error(); });
  for (const name of ['diagnostics_preview', 'diagnostics_export']) {
    assert.equal(domainToolDefinitions.some(tool => tool.name === name), false);
    await assert.rejects(tools.call(name, { requestId: randomUUID(), params: {} }));
  }
  assert.equal(calls, 0); assert.equal(authorizations, 0);
});
