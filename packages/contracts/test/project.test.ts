import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  isManifest, isOperationReceipt, isProjectEvent, isProjectRequest, isProjectResponse,
  validateManifest, validateOperation, methodPolicies
} from '@robotics-workbench/contracts';
import manifest from '../../../examples/workbench.valid.json';
import receipt from '../../../examples/operation.valid.json';
import event from '../../../examples/event.valid.json';

test('engineering requests preserve revision and argument boundaries before optional tools execute', () => {
  const request = { schemaVersion: 1, requestId: randomUUID(), projectId: randomUUID(), expectedProjectRevision: 1 };
  const { expectedProjectRevision: _revision, ...read } = request;
  for (const [method, params] of [
    ['cad.generate', { assetId: randomUUID(), expectedFingerprint: 'a'.repeat(64), mode: 'production' }],
    ['kicad.generate', { mappingPath: 'components/kicad.json', expectedManifestSha256: 'b'.repeat(64) }],
    ['kicad.validate', { sourcePath: 'schematic/main.kicad_sch', expectedSourceSha256: 'c'.repeat(64) }],
    ['kicad.export', { generationId: randomUUID(), destinationPath: 'exports/new-project' }]
  ] as const) {
    assert.ok(isProjectRequest({ ...request, method, params }));
    assert.equal(isProjectRequest({ ...read, method, params }), false);
    assert.equal(isProjectRequest({ ...request, method, params: { ...params, shell: 'execute' } }), false);
  }
  assert.ok(isProjectRequest({ ...read, method: 'cad.snapshot', params: {} }));
  assert.equal(isProjectRequest({ ...request, method: 'cad.generate', params: { assetId: randomUUID(), expectedFingerprint: 'a'.repeat(64), mode: 'production', assumptions: { width: Infinity } } }), false);
});

test('manifest/operation/event validators use v1 schemas and format validation', () => {
  assert.ok(isManifest(manifest));
  assert.equal(validateManifest(manifest), manifest);
  assert.ok(isOperationReceipt(receipt));
  assert.equal(validateOperation(receipt), receipt);
  assert.ok(isProjectEvent(event));
  assert.equal(isManifest({ ...manifest, projectId: 'COM3' }), false);
  assert.equal(isManifest({ ...manifest, projectRevision: 0 }), false);
  assert.equal(isManifest({ ...manifest, projectRevision: 1e30 }), false);
  assert.equal(isManifest({ ...manifest, undocumented: true }), false);
  assert.throws(() => validateManifest({ ...manifest, schemaVersion: 2 }), { code: 'UNSUPPORTED_SCHEMA' });
  assert.equal(isOperationReceipt({ ...receipt, status: 'success' }), false);
  assert.equal(isOperationReceipt({ ...receipt, finishedAt: undefined }), false);
  assert.equal(isOperationReceipt({ ...receipt, sourceSnapshotId: undefined }), false);
  assert.equal(isProjectEvent({ ...event, occurredAt: 'yesterday' }), false);
  assert.equal(isProjectEvent({ ...event, sequence: 1e30 }), false);
});

test('project RPC rejects unknown methods, malformed method arguments and ambiguous operation lookup', () => {
  const request = { schemaVersion: 1, requestId: randomUUID(), projectId: randomUUID(), method: 'project.snapshot', params: {} };
  assert.ok(isProjectRequest(request));
  assert.ok(isProjectRequest({ ...request, method: 'operation.get', params: { operationId: randomUUID() } }));
  assert.ok(isProjectRequest({ ...request, method: 'operation.get', params: { requestId: randomUUID() } }));
  for (const bad of [null, {}, { ...request, method: 'constructor' }, { ...request, method: 'shell.execute' },
    { ...request, projectId: 'bad' }, { ...request, schemaVersion: 2 }, { ...request, params: { shell: 'execute' } },
    { ...request, method: 'operation.get', params: {} },
    { ...request, method: 'operation.get', params: { operationId: randomUUID(), requestId: randomUUID() } },
    { ...request, method: 'operation.get', params: { operationId: 'COM3' } },
    { ...request, params: { limit: 501 } }, { ...request, params: { include: ['secrets'] } },
    { ...request, params: { selection: { kind: 'component', id: randomUUID() } } },
    { ...request, method: 'build.compile', params: { targetId: randomUUID(), sourceSnapshotId: randomUUID() } }]) {
    assert.equal(isProjectRequest(bad), false);
  }
  assert.equal(methodPolicies['firmware.upload'].classification, 'execute');
  assert.equal(methodPolicies['operation.get'].classification, 'read');
});

test('message limits reject oversized, deeply nested, cyclic and non-JSON result payloads', () => {
  const response = { schemaVersion: 1, requestId: randomUUID(), result: { text: '<script>not executed</script>' } };
  assert.ok(isProjectResponse(response));
  assert.equal(isProjectResponse({ ...response, error: { code: 'INVALID_REQUEST', message: 'bad', retryable: false } }), false);
  assert.equal(isProjectResponse({ ...response, result: 'é'.repeat(524288) }), false);
  assert.equal(isProjectResponse({ ...response, result: Array.from({ length: 20 }).reduce(value => ({ value }), {} as unknown) }), false);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const result of [cycle, 1n, undefined, () => true, Infinity]) assert.equal(isProjectResponse({ ...response, result }), false);
});
