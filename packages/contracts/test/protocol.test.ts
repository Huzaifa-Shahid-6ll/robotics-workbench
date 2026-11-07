import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isControlRequest, isControlResponse } from '@robotics-workbench/contracts';

test('lifecycle validates envelopes, method parameters and results before dispatch', () => {
  const request = { schemaVersion: 1, requestId: randomUUID(), method: 'companion.hello', params: {} };
  assert.ok(isControlRequest(request));
  for (const bad of [null, {}, { ...request, schemaVersion: 2 }, { ...request, requestId: 'bad' },
    { ...request, method: 'firmware.upload' }, { ...request, params: { command: 'execute' } },
    { ...request, projectId: randomUUID() }, { ...request, params: { text: 'x'.repeat(1024 * 1024) } },
    { ...request, params: { nested: Array.from({ length: 20 }).reduce(value => ({ value }), {} as unknown) } },
    { ...request, params: { bigint: 1n } }]) assert.equal(isControlRequest(bad), false);
  const response = { schemaVersion: 1, requestId: request.requestId, result: { state: 'ready', pid: 123, runtimeVersion: 'v24.18.0', platform: 'win32', arch: 'x64' } };
  assert.ok(isControlResponse(response));
  assert.equal(isControlResponse({ ...response, error: { code: 'ERROR', message: 'error', retryable: false } }), false);
  assert.equal(isControlResponse({ ...response, result: { state: 'uploaded' } }), false);
  assert.equal(isControlResponse({ ...response, result: { ...response.result, pid: -1 } }), false);
  assert.ok(isControlResponse({ schemaVersion: 1, requestId: request.requestId, error: { code: 'INVALID_REQUEST', message: 'Rejected.', retryable: false } }));
});
