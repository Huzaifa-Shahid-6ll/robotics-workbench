import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DomainTools } from '@robotics-workbench/application';
import { ToolBridge } from '../src/mcp-bridge';

test('loopback forwarding requires secret, validates scope, and never retries effects', async () => {
  let calls = 0;
  const bridge = new ToolBridge();
  const binding = await bridge.listen(new DomainTools(randomUUID(), async request => { calls++; return { schemaVersion: 1, requestId: request.requestId, result: { ok: true } }; }, async () => {}, () => { throw Error(); }));
  try {
    const body = JSON.stringify({ name: 'project_snapshot', arguments: { requestId: randomUUID(), params: {} } });
    assert.equal((await fetch(binding.endpoint, { method: 'POST', body })).status, 403);
    assert.equal((await fetch(binding.endpoint, { method: 'POST', headers: { Authorization: 'x'.repeat(70) + '\u00ff' }, body })).status, 403);
    const response = await fetch(binding.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${binding.token}` }, body });
    assert.equal(response.status, 200); assert.equal(calls, 1);
    assert.ok((await response.text()).includes('ok'));
    assert.equal((await fetch(binding.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${binding.token}` }, body: '{' })).status, 400);
    assert.equal(calls, 1);
  } finally { await bridge.close(); }
});
