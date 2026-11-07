import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkbenchStore, migrations } from '@robotics-workbench/persistence';

export { ProcessRunner } from '@robotics-workbench/application';
export { checkArtifactCredentials } from '@robotics-workbench/persistence';
export { CompanionClient } from '../../apps/extension/src/companion-client';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function seedFixture(runRoot: string) {
  const projectRoot = join(runRoot, 'project', 'MaintenanceProbe'), dataRoot = join(runRoot, 'data');
  mkdirSync(projectRoot, { recursive: true });
  const projectId = randomUUID(), targetId = randomUUID();
  const manifest = { schemaVersion: 1, projectId, projectRevision: 1, name: 'SYNTHETIC maintenance preservation fixture', sketches: [{ path: '.', targetId }], targets: [{ targetId, fqbn: 'arduino:avr:uno', options: {} }], components: [], nets: [], codeBindings: [], documents: [], extensions: {} };
  const source = '// SYNTHETIC maintenance fixture. No hardware actions.\nvoid setup() {}\nvoid loop() {}\n';
  writeFileSync(join(projectRoot, 'MaintenanceProbe.ino'), source, { flag: 'wx' });
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(projectRoot, 'workbench.json'), manifestBytes, { flag: 'wx' });
  const store = new WorkbenchStore(dataRoot), operationId = randomUUID();
  try {
    store.registerProject({ projectId, root: projectRoot, projectRevision: 1, manifestSha256: hash(manifestBytes) });
    store.createOperation({ schemaVersion: 1, operationId, requestId: randomUUID(), projectId, kind: 'document-ingest', status: 'queued', expectedProjectRevision: 1, createdAt: new Date().toISOString(), tool: { name: 'synthetic-maintenance-fixture', version: '1' }, artifacts: [] }, { purpose: 'Synthetic retained receipt; no document tool, provider, compiler or hardware was run.' });
    store.transitionOperation(projectId, operationId, 'running');
    const artifact = store.storeArtifact(projectId, Buffer.from('SYNTHETIC immutable maintenance evidence.\n'), 'text/plain', operationId);
    store.transitionOperation(projectId, operationId, 'succeeded', { artifacts: [{ artifactId: artifact.artifactId, relativePath: artifact.relativePath, sha256: artifact.sha256, mediaType: artifact.mediaType }] });
    store.putRecord('observations', randomUUID(), projectId, { kind: 'synthetic-maintenance-observation', basis: 'reported', result: 'inconclusive', note: 'No physical behavior was tested.' });
    return { projectRoot, dataRoot, projectId, operationId, schemaVersion: migrations.length, sourceSha256: hash(Buffer.from(source)), artifactId: artifact.artifactId, artifactRelativePath: artifact.relativePath, artifactSha256: artifact.sha256 };
  } finally { store.close(); }
}

export function verifyFixture(fixture: ReturnType<typeof seedFixture>) {
  const database = new DatabaseSync(join(fixture.dataRoot, 'workbench.sqlite'), { readOnly: true });
  try {
    const row = database.prepare('SELECT receipt FROM operations WHERE operation_id=? AND project_id=?').get(fixture.operationId, fixture.projectId);
    assert.ok(row); const receipt = JSON.parse(String(row.receipt));
    assert.equal(receipt.status, 'succeeded'); assert.equal(receipt.artifacts[0].artifactId, fixture.artifactId);
    const artifact = database.prepare('SELECT body FROM artifacts WHERE artifact_id=? AND project_id=?').get(fixture.artifactId, fixture.projectId);
    assert.ok(artifact); assert.equal(JSON.parse(String(artifact.body)).relativePath, fixture.artifactRelativePath);
    assert.equal(hash(readFileSync(join(fixture.dataRoot, fixture.artifactRelativePath))), fixture.artifactSha256);
    assert.equal(hash(readFileSync(join(fixture.projectRoot, 'MaintenanceProbe.ino'))), fixture.sourceSha256);
    assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM observations WHERE project_id=?').get(fixture.projectId)!.count), 1);
    return { operationStatus: receipt.status, artifactSha256: fixture.artifactSha256, observationsPreserved: 1, sourceSha256: fixture.sourceSha256 };
  } finally { database.close(); }
}

export function storageChecks(runRoot: string, fixture: ReturnType<typeof seedFixture>) {
  const migrationRoot = join(runRoot, 'migration-failure');
  cpSync(fixture.dataRoot, migrationRoot, { recursive: true, errorOnExist: true, force: false });
  assert.throws(() => new WorkbenchStore(migrationRoot, { migrations: [...migrations, { version: migrations.length + 1, sql: 'CREATE TABLE synthetic_before_failure(value TEXT); SELECT * FROM synthetic_missing_table;' }] }));
  const snapshots = readdirSync(join(migrationRoot, 'backups'));
  assert.equal(snapshots.length, 1, 'Failed migration must retain one pre-upgrade snapshot.');
  const backupPath = join(migrationRoot, 'backups', snapshots[0]);
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  try {
    assert.equal(Number(backup.prepare('PRAGMA user_version').get()!.user_version), migrations.length);
    assert.equal(Number(backup.prepare('SELECT COUNT(*) AS count FROM operations').get()!.count), 1);
  } finally { backup.close(); }
  const preserved = new WorkbenchStore(migrationRoot);
  try { assert.equal(preserved.getOperation(fixture.projectId, fixture.operationId).status, 'succeeded'); }
  finally { preserved.close(); }
  const restoreRoot = join(runRoot, 'restored-migration-snapshot'); mkdirSync(restoreRoot);
  copyFileSync(backupPath, join(restoreRoot, 'workbench.sqlite'));
  cpSync(join(fixture.dataRoot, 'artifacts'), join(restoreRoot, 'artifacts'), { recursive: true, errorOnExist: true, force: false });
  const restored = new WorkbenchStore(restoreRoot);
  try {
    const receipt = restored.getOperation(fixture.projectId, fixture.operationId);
    assert.equal(receipt.status, 'succeeded');
    assert.equal(hash(restored.readArtifact(fixture.projectId, receipt.artifacts[0].artifactId)), fixture.artifactSha256);
  } finally { restored.close(); }
  const futureRoot = join(runRoot, 'unsupported-future-schema');
  cpSync(fixture.dataRoot, futureRoot, { recursive: true, errorOnExist: true, force: false });
  const futurePath = join(futureRoot, 'workbench.sqlite'), future = new DatabaseSync(futurePath);
  try { future.exec(`PRAGMA user_version=${migrations.length + 1};`); } finally { future.close(); }
  const before = hash(readFileSync(futurePath));
  assert.throws(() => new WorkbenchStore(futureRoot), { code: 'UNSUPPORTED_SCHEMA' });
  assert.equal(hash(readFileSync(futurePath)), before, 'Unsupported newer database must remain byte-identical.');
  return { result: 'passed', evidenceClass: 'real-sqlite-with-synthetic-maintenance-records', schemaVersion: migrations.length, attemptedMigrationVersion: migrations.length + 1, backup: { path: backupPath, sha256: hash(readFileSync(backupPath)), independentlyOpenedReadOnly: true, restoredReceiptAndArtifact: true }, futureDatabase: { path: futurePath, schemaVersion: migrations.length + 1, sha256Before: before, sha256After: hash(readFileSync(futurePath)), refusedWithoutDatabaseWrite: true }, limitations: ['Injected SQL failure exercises the actual migration/store implementation; it is not an OS crash or an old released application.', 'Version-fixture install mechanics do not establish historical application/schema compatibility.'] };
}
