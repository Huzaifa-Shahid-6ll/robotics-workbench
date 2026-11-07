import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync, symlinkSync, existsSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkbenchStore, migrations, canonicalJson, type ArtifactCommitStep } from '../src/index';
import type { OperationReceipt } from '@robotics-workbench/contracts';

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-store-'));
  const root = join(directory, 'project'); mkdirSync(root);
  const store = new WorkbenchStore(join(directory, 'data'));
  const projectId = randomUUID();
  store.registerProject({ projectId, root, projectRevision: 1, manifestSha256: digest('manifest') });
  return { directory, root, store, projectId };
}
function operation(projectId: string, kind: OperationReceipt['kind'] = 'compile'): OperationReceipt {
  return { schemaVersion: 1, operationId: randomUUID(), requestId: randomUUID(), projectId, kind,
    status: 'queued', expectedProjectRevision: 1, createdAt: new Date().toISOString(),
    tool: { name: 'synthetic-tool', version: 'fixture-1' }, artifacts: [],
    ...(kind === 'upload' ? { sourceSnapshotId: randomUUID(), deviceId: randomUUID() } : {}) };
}

test('durable operation receipts, normalized deduplication, project scope and terminal immutability', () => {
  const { store, projectId } = setup();
  const receipt = operation(projectId, 'upload');
  store.createOperation(receipt, { b: 2, a: 1 });
  assert.equal(store.createOperation({ ...receipt, operationId: randomUUID() }, { a: 1, b: 2 }).operationId, receipt.operationId);
  assert.throws(() => store.createOperation(receipt, { a: 2 }), { code: 'REQUEST_ID_CONFLICT' });
  assert.throws(() => store.getOperation(randomUUID(), receipt.operationId), { code: 'NOT_FOUND' });
  const running = store.transitionOperation(projectId, receipt.operationId, 'running');
  assert.ok(running.startedAt);
  const unknown = store.transitionOperation(projectId, receipt.operationId, 'outcome-unknown');
  assert.ok(unknown.finishedAt);
  assert.throws(() => store.transitionOperation(projectId, receipt.operationId, 'succeeded'));
  const directory = store.dataRoot; store.close();
  const reopened = new WorkbenchStore(directory);
  assert.deepEqual(reopened.getOperationByRequest(projectId, receipt.requestId), unknown);
  assert.equal(reopened.eventsSince(projectId, 0).events.length, 3);
  assert.deepEqual(reopened.reconcileOperations(), []);
  reopened.close();
});

test('startup reconciliation records unknown upload and cancels queued work without replay', () => {
  const { store, projectId } = setup();
  const upload = operation(projectId, 'upload');
  const queued = operation(projectId, 'upload');
  const compile = operation(projectId);
  for (const receipt of [upload, queued, compile]) store.createOperation(receipt, { requestId: receipt.requestId });
  store.transitionOperation(projectId, upload.operationId, 'running');
  store.transitionOperation(projectId, compile.operationId, 'running');
  const reconciled = store.reconcileOperations();
  assert.equal(reconciled.find(item => item.operationId === upload.operationId)!.status, 'outcome-unknown');
  assert.equal(reconciled.find(item => item.operationId === queued.operationId)!.status, 'cancelled');
  assert.equal(reconciled.find(item => item.operationId === compile.operationId)!.status, 'failed');
  assert.deepEqual(store.reconcileOperations(), []);
  store.close();
});

test('an identical retry after a project revision change returns the original receipt before checking new admission', () => {
  const { store, projectId } = setup();
  const receipt = operation(projectId); const intent = { targetId: randomUUID(), sourceSnapshotId: randomUUID() };
  store.createOperation(receipt, intent);
  store.updateProject(projectId, 2, digest('changed manifest'));
  assert.deepEqual(store.createOperation({ ...receipt, operationId: randomUUID() }, intent), receipt);
  assert.throws(() => store.createOperation(receipt, { ...intent, targetId: randomUUID() }), { code: 'REQUEST_ID_CONFLICT' });
  assert.throws(() => store.createOperation(operation(projectId), intent), { code: 'REVISION_CONFLICT' });
  store.close();
});

test('artifact bytes are verified, immutable, scoped and deduplicated without losing provenance', () => {
  const { store, projectId } = setup();
  const one = store.storeArtifact(projectId, Buffer.from('evidence'), 'text/plain');
  const two = store.storeArtifact(projectId, Buffer.from('evidence'), 'text/plain');
  assert.notEqual(one.artifactId, two.artifactId);
  assert.equal(one.relativePath, two.relativePath);
  assert.equal(store.readArtifact(projectId, one.artifactId).toString(), 'evidence');
  assert.throws(() => store.readArtifact(randomUUID(), one.artifactId), { code: 'NOT_FOUND' });
  writeFileSync(join(store.dataRoot, one.relativePath), 'corrupt');
  assert.throws(() => store.readArtifact(projectId, one.artifactId), { code: 'ARTIFACT_MISMATCH' });
  assert.throws(() => store.storeArtifact(projectId, Buffer.from('evidence'), 'text/plain'), { code: 'ARTIFACT_MISMATCH' });
  assert.equal(readFileSync(join(store.dataRoot, one.relativePath), 'utf8'), 'corrupt');
  const dataRoot = store.dataRoot; store.close();
  const reopened = new WorkbenchStore(dataRoot);
  assert.deepEqual(new Set(reopened.recovery.corrupt), new Set([one.artifactId, two.artifactId]));
  assert.equal(reopened.getArtifact(projectId, one.artifactId).sha256, one.sha256);
  reopened.close();
});

for (const step of ['temporary-created', 'bytes-written', 'finalized', 'registered'] as ArtifactCommitStep[]) {
  test(`artifact crash at ${step} retains verified evidence or quarantines recoverable bytes`, () => {
    const { store, projectId } = setup();
    const dataRoot = store.dataRoot; store.close();
    const faulted = new WorkbenchStore(dataRoot, { fault(observed) { if (observed === step) throw new Error('simulated crash'); } });
    assert.throws(() => faulted.storeArtifact(projectId, Buffer.from('preserved bytes'), 'text/plain'), /simulated crash/);
    faulted.close();
    const recovered = new WorkbenchStore(dataRoot);
    if (step === 'registered') {
      assert.deepEqual(recovered.recovery.quarantined, []);
      assert.equal(readdirSync(join(dataRoot, 'artifacts')).length, 1);
      assert.deepEqual(recovered.recovery.missing, []);
    } else assert.equal(recovered.recovery.quarantined.length, 1);
    recovered.close();
  });
}

test('missing evidence remains registered and cannot become a successful artifact receipt', () => {
  const { store, projectId } = setup();
  const artifact = store.storeArtifact(projectId, Buffer.from('retain history'), 'text/plain');
  unlinkSync(join(store.dataRoot, artifact.relativePath));
  const root = store.dataRoot; store.close();
  const reopened = new WorkbenchStore(root);
  assert.deepEqual(reopened.recovery.missing, [artifact.artifactId]);
  assert.throws(() => reopened.readArtifact(projectId, artifact.artifactId), { code: 'NOT_FOUND' });
  const receipt = operation(projectId); reopened.createOperation(receipt, {});
  reopened.transitionOperation(projectId, receipt.operationId, 'running');
  assert.throws(() => reopened.transitionOperation(projectId, receipt.operationId, 'succeeded', { artifacts: [{ artifactId: artifact.artifactId, relativePath: artifact.relativePath, sha256: artifact.sha256, mediaType: artifact.mediaType }] }), { code: 'NOT_FOUND' });
  assert.equal(reopened.getOperation(projectId, receipt.operationId).status, 'running');
  reopened.close();
});

test('migration failure rolls back and leaves a valid pre-upgrade snapshot; newer schema is untouched', () => {
  const { store, projectId } = setup();
  const receipt = operation(projectId); store.createOperation(receipt, { purpose: 'survives migration' });
  const root = store.dataRoot; store.close();
  assert.throws(() => new WorkbenchStore(root, { migrations: [...migrations, { version: migrations.length + 1, sql: 'CREATE TABLE before_error(value TEXT); SELECT * FROM nonexistent;' }] }));
  const backups = readdirSync(join(root, 'backups'));
  assert.equal(backups.length, 1);
  const snapshot = new DatabaseSync(join(root, 'backups', backups[0]), { readOnly: true });
  assert.equal(snapshot.prepare('SELECT COUNT(*) AS count FROM operations').get()!.count, 1);
  snapshot.close();
  const usable = new WorkbenchStore(root);
  assert.equal(usable.getOperation(projectId, receipt.operationId).status, 'queued'); usable.close();
  const db = new DatabaseSync(join(root, 'workbench.sqlite')); db.exec('PRAGMA user_version=99;'); db.close();
  const before = digest(readFileSync(join(root, 'workbench.sqlite')));
  assert.throws(() => new WorkbenchStore(root), { code: 'UNSUPPORTED_SCHEMA' });
  assert.equal(digest(readFileSync(join(root, 'workbench.sqlite'))), before);
});

test('backup restores to another directory with exact artifacts, watermark and a fresh event epoch', () => {
  const { store, projectId, directory } = setup();
  const artifact = store.storeArtifact(projectId, Buffer.from('portable evidence'), 'text/plain');
  const experimentId = randomUUID();
  store.putRecord('experiments', experimentId, projectId, { recordingIds: [], outcome: 'inconclusive' });
  store.appendEvent(projectId, 1, 'source.changed', { paths: ['Sketch/Sketch.ino'] });
  const originalEpoch = store.epoch;
  const backupPath = join(directory, 'backup');
  const manifest = store.backup(backupPath);
  assert.equal(manifest.snapshotSequence, store.snapshotWatermark());
  const restored = WorkbenchStore.restore(backupPath, join(directory, 'restored'));
  assert.notEqual(restored.epoch, originalEpoch);
  assert.equal(restored.readArtifact(projectId, artifact.artifactId).toString(), 'portable evidence');
  assert.deepEqual(restored.getRecord('experiments', experimentId, projectId), { recordingIds: [], outcome: 'inconclusive' });
  assert.equal(restored.eventsSince(projectId, 0, originalEpoch).resyncRequired, true);
  assert.throws(() => WorkbenchStore.restore(backupPath, restored.dataRoot), { code: 'REVISION_CONFLICT' });
  writeFileSync(join(backupPath, artifact.relativePath), 'corrupt');
  assert.throws(() => WorkbenchStore.restore(backupPath, join(directory, 'bad-restore')), { code: 'ARTIFACT_MISMATCH' });
  restored.close(); store.close();
});

test('credential fixtures never reach metadata, artifact bytes or backup', () => {
  const { store, projectId, directory } = setup();
  const secret = 'planted-credential-1234567890';
  assert.throws(() => store.putRecord('sessions', randomUUID(), projectId, { accessToken: secret }), { code: 'INVALID_REQUEST' });
  assert.throws(() => store.storeArtifact(projectId, Buffer.from(`Authorization: Bearer ${secret}`), 'text/plain'), { code: 'INVALID_REQUEST' });
  assert.throws(() => store.storeArtifact(projectId, Buffer.from(JSON.stringify({ apiKey: secret })), 'application/json'), { code: 'INVALID_REQUEST' });
  store.putRecord('sessions', randomUUID(), projectId, { providerId: 'codex', providerSessionId: 'opaque-session-id' });
  const destination = join(directory, 'safe-backup'); store.backup(destination);
  assert.equal(readFileSync(join(destination, 'workbench.sqlite')).includes(Buffer.from(secret)), false);
  store.close();
});

test('index rebuild preserves observations and experiments, stale projections and copied identities fail', () => {
  const { store, projectId, directory } = setup();
  const experimentId = randomUUID(); store.putRecord('experiments', experimentId, projectId, { outcome: 'inconclusive' });
  store.rebuildFileIndex(projectId, [{ path: 'Sketch/Sketch.ino', sha256: digest('source') }]);
  store.rebuildFileIndex(projectId, []);
  assert.deepEqual(store.getRecord('experiments', experimentId, projectId), { outcome: 'inconclusive' });
  assert.throws(() => store.updateProject(projectId, 1, digest('external edit')), { code: 'REVISION_CONFLICT' });
  const updated = store.updateProject(projectId, 2, digest('accepted edit')); assert.equal(updated.projectRevision, 2);
  const copy = join(directory, 'copy'); mkdirSync(copy);
  assert.throws(() => store.registerProject({ projectId, root: copy, projectRevision: 2, manifestSha256: digest('accepted edit') }), { code: 'REVISION_CONFLICT' });
  assert.throws(() => store.putRecord('experiments', experimentId, projectId, { outcome: 'passed' }), { code: 'REVISION_CONFLICT' });
  store.close();
});

test('canonical hashing rejects non-JSON and over-limit payloads instead of hiding changed intent', () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  for (const value of [NaN, undefined, { value: undefined }, new Date(), { value: 'a'.repeat(1024 * 1024) }]) assert.throws(() => canonicalJson(value));
});

test('relocation is explicit and compares the old binding before preserving identity', () => {
  const { store, projectId, directory, root } = setup();
  const target = join(directory, 'moved-project'); mkdirSync(target);
  assert.throws(() => store.relocateProject(projectId, target, target), { code: 'REVISION_CONFLICT' });
  assert.equal(store.getProject(projectId).root, root);
  assert.equal(store.relocateProject(projectId, target, root).root, target);
  store.close();
});

test('hostile backup metadata and credential-bearing database bodies are rejected before restore writes', () => {
  const { store, projectId, directory } = setup();
  const artifact = store.storeArtifact(projectId, Buffer.from('checked evidence'), 'text/plain');
  const sessionId = randomUUID(); store.putRecord('sessions', sessionId, projectId, { providerId: 'codex' });
  const backupPath = join(directory, 'untrusted-backup'); store.backup(backupPath);
  const manifestPath = join(backupPath, 'backup.json');
  const original = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const patch of [
    { snapshotSequence: original.snapshotSequence + 1 },
    { epoch: randomUUID() },
    { artifacts: [{ ...artifact, sizeBytes: -1 }] },
    { artifacts: [{ ...artifact, relativePath: '../outside' }] },
    { artifacts: [{ ...artifact, createdAt: 'yesterday' }] },
    { artifacts: [artifact, artifact] },
  ]) {
    writeFileSync(manifestPath, JSON.stringify({ ...original, ...patch }));
    assert.throws(() => WorkbenchStore.restore(backupPath, join(directory, 'must-not-exist')));
    assert.equal(existsSync(join(directory, 'must-not-exist')), false);
  }
  const databasePath = join(backupPath, 'workbench.sqlite');
  const hostile = new DatabaseSync(databasePath);
  hostile.prepare('UPDATE sessions SET body=? WHERE id=?').run(JSON.stringify({ accessToken: 'planted-secret-in-crafted-backup' }), sessionId);
  hostile.close();
  writeFileSync(manifestPath, JSON.stringify({ ...original, databaseSha256: digest(readFileSync(databasePath)) }));
  assert.throws(() => WorkbenchStore.restore(backupPath, join(directory, 'must-not-exist')), { code: 'INVALID_REQUEST' });
  assert.equal(existsSync(join(directory, 'must-not-exist')), false);
  store.close();
});

test('restore rejects oversized manifests and destination junctions', () => {
  const { store, directory } = setup();
  const backupPath = join(directory, 'bounded-backup'); store.backup(backupPath);
  const target = join(directory, 'actual-target'); mkdirSync(target);
  const linked = join(directory, 'linked-target'); symlinkSync(target, linked, 'junction');
  assert.throws(() => WorkbenchStore.restore(backupPath, linked), { code: 'UNAUTHORIZED_SCOPE' });
  assert.deepEqual(readdirSync(target), []);
  writeFileSync(join(backupPath, 'backup.json'), ' '.repeat(1024 * 1024 + 1));
  assert.throws(() => WorkbenchStore.restore(backupPath, join(directory, 'oversized')), { code: 'INVALID_REQUEST' });
  store.close();
});

test('a hardlinked database cannot redirect SQLite writes outside the selected data root', () => {
  const { store, directory } = setup();
  const original = store.databasePath; store.close();
  const before = digest(readFileSync(original));
  const hostile = join(directory, 'hostile-root'); mkdirSync(hostile);
  linkSync(original, join(hostile, 'workbench.sqlite'));
  assert.throws(() => new WorkbenchStore(hostile), { code: 'UNAUTHORIZED_SCOPE' });
  assert.equal(digest(readFileSync(original)), before);
});

test('operational directory junctions are rejected before database creation or artifact writes', () => {
  for (const name of ['temporary', 'artifacts', 'quarantine', 'backups']) {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-owned-path-'));
    const dataRoot = join(directory, 'data'); mkdirSync(dataRoot);
    const outside = join(directory, 'outside'); mkdirSync(outside);
    symlinkSync(outside, join(dataRoot, name), 'junction');
    assert.throws(() => new WorkbenchStore(dataRoot), { code: 'UNAUTHORIZED_SCOPE' });
    assert.deepEqual(readdirSync(outside), []);
    assert.equal(existsSync(join(dataRoot, 'workbench.sqlite')), false);
  }
});
