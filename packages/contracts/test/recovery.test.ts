import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isProjectRequest, isRecoverySnapshot } from '../src/index';

test('recovery boundary rejects unknown outcomes and unbounded or malformed summaries', () => {
  const snapshot = { projectId: randomUUID(), projectRevision: 1, operations: [{ operationId: randomUUID(), kind: 'upload', status: 'outcome-unknown', createdAt: new Date().toISOString(), artifactCount: 0 }], storage: { quarantined: 0, missing: 0, corrupt: 0 }, nextCursor: null, notice: 'Historical receipt; no current device state is implied.' };
  assert.equal(isRecoverySnapshot(snapshot), true);
  assert.equal(isRecoverySnapshot({ ...snapshot, operations: [{ ...snapshot.operations[0], status: 'success' }] }), false);
  assert.equal(isRecoverySnapshot({ ...snapshot, operations: Array(101).fill(snapshot.operations[0]) }), false);
  assert.equal(isRecoverySnapshot({ ...snapshot, storage: { ...snapshot.storage, missing: -1 } }), false);
});
test('archive mutations require explicit revision and bounded host document identities', () => {
  const request = { schemaVersion: 1, requestId: randomUUID(), projectId: randomUUID(), method: 'project.export', params: { destination: 'G:/backup', expectedManifestSha256: 'a'.repeat(64), documentHashes: {} } };
  assert.equal(isProjectRequest(request), false);
  assert.equal(isProjectRequest({ ...request, expectedProjectRevision: 1 }), true);
  assert.equal(isProjectRequest({ ...request, expectedProjectRevision: 1, params: { ...request.params, documentHashes: { 'sketch.ino': 'wrong' } } }), false);
  assert.equal(isProjectRequest({ ...request, expectedProjectRevision: 1, params: { ...request.params, shell: 'unexpected' } }), false);
});
