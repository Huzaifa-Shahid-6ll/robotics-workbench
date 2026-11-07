import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { isRecoverySnapshot, type ProjectRequest } from '@robotics-workbench/contracts';
import { ProjectService } from '../src/project-service';
import { RecoveryService } from '../src/recovery-service';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-recovery-service-'));
  const root = join(directory, 'project'); mkdirSync(join(root, 'RangeSensor'), { recursive: true });
  const manifest = JSON.parse(readFileSync('examples/workbench.valid.json', 'utf8')); manifest.projectId = randomUUID();
  writeFileSync(join(root, 'workbench.json'), JSON.stringify(manifest));
  writeFileSync(join(root, 'RangeSensor', 'RangeSensor.ino'), 'void setup() {}\nvoid loop() {}\n');
  const project = new ProjectService(root, join(directory, 'data'));
  t.after(() => { project.close(); const within = relative(tmpdir(), directory); assert.ok(within && !isAbsolute(within) && within !== '..' && !within.startsWith(`..${sep}`)); rmSync(directory, { recursive: true, force: true }); });
  const service = new RecoveryService(project);
  const request = (method: ProjectRequest['method'], params: Record<string, unknown> = {}): ProjectRequest => ({ schemaVersion: 1, requestId: randomUUID(), projectId: manifest.projectId, method, expectedProjectRevision: 1, params });
  return { directory, root, project, service, request, manifest };
}

test('recovery inspection shows historical unknown outcomes without connecting hardware, including invalid source manifests', t => {
  const { root, project, service, request, manifest } = fixture(t);
  const operationId = randomUUID();
  project.store.createOperation({ schemaVersion: 1, operationId, requestId: randomUUID(), projectId: manifest.projectId, kind: 'upload', status: 'queued', expectedProjectRevision: 1, sourceSnapshotId: randomUUID(), deviceId: randomUUID(),
    createdAt: new Date().toISOString(), tool: { name: 'synthetic-no-device', version: 'fixture' }, artifacts: [] }, { synthetic: true });
  project.store.transitionOperation(manifest.projectId, operationId, 'running');
  project.store.reconcileOperations();
  const response = service.handle(request('recovery.inspect'));
  assert.ok(isRecoverySnapshot(response.result));
  assert.equal(response.result.operations[0].status, 'outcome-unknown');
  assert.match(response.result.notice, /does not restore firmware/);
  assert.deepEqual(project.devices.status(), []);
  writeFileSync(join(root, 'workbench.json'), '{invalid unsaved recovery fixture');
  const broken = service.handle(request('recovery.inspect'));
  assert.ok(isRecoverySnapshot(broken.result));
  assert.match(broken.result.notice, /manifest needs repair/);
  assert.equal(broken.result.operations[0].operationId, operationId);
  assert.equal(project.store.listOperations(manifest.projectId).length, 1);
});

test('recovery pages are byte bounded and reject stale cursors without changing any receipt', t => {
  const { project, service, request, manifest } = fixture(t);
  for (let index = 0; index < 40; index++) {
    const operationId = randomUUID();
    project.store.createOperation({ schemaVersion: 1, operationId, requestId: randomUUID(), projectId: manifest.projectId, kind: 'compile', status: 'queued', expectedProjectRevision: 1,
      createdAt: new Date().toISOString(), tool: { name: 'synthetic', version: 'fixture' }, artifacts: [] }, { index });
    project.store.transitionOperation(manifest.projectId, operationId, 'failed', { error: { code: 'SYNTHETIC', message: 'x'.repeat(2000), retryable: false } });
  }
  const first = service.handle(request('recovery.inspect'));
  assert.ok(isRecoverySnapshot(first.result));
  assert.ok(first.result.nextCursor);
  assert.ok(Buffer.byteLength(JSON.stringify(first.result)) < 16 * 1024);
  const second = service.handle(request('recovery.inspect', { cursor: first.result.nextCursor }));
  assert.ok(isRecoverySnapshot(second.result));
  assert.notEqual(second.result.operations[0].operationId, first.result.operations[0].operationId);
  project.store.appendEvent(manifest.projectId, 1, 'project.changed', { synthetic: true });
  assert.equal(service.handle(request('recovery.inspect', { cursor: first.result.nextCursor })).error?.code, 'REVISION_CONFLICT');
  assert.equal(project.store.listOperations(manifest.projectId).length, 40);
});

test('host export rejects stale buffers, cross-project scope and unknown filesystem paths before creating an archive', t => {
  const { directory, root, project, service, request } = fixture(t);
  const destination = join(directory, 'export');
  const params = { destination, expectedManifestSha256: project.files.inspectManifest().sha256, documentHashes: { 'RangeSensor/RangeSensor.ino': '0'.repeat(64) } };
  assert.equal(service.handle(request('project.export', params)).error?.code, 'REVISION_CONFLICT');
  assert.equal(existsSync(destination), false);
  assert.equal(service.handle({ ...request('project.export', params), projectId: randomUUID() }).error?.code, 'UNAUTHORIZED_SCOPE');
  assert.equal(service.handle(request('project.export', { ...params, documentHashes: { '../outside': '0'.repeat(64) } })).error?.code, 'UNAUTHORIZED_SCOPE');
  assert.equal(readFileSync(join(root, 'RangeSensor', 'RangeSensor.ino'), 'utf8'), 'void setup() {}\nvoid loop() {}\n');
});

test('export and independent restore are idempotent and leave present device state unknown', t => {
  const { directory, root, project, service, request, manifest } = fixture(t);
  const artifact = project.store.storeArtifact(manifest.projectId, Buffer.from('retained synthetic evidence'), 'text/plain');
  const exportRequest = request('project.export', { destination: join(directory, 'export'), expectedManifestSha256: project.files.inspectManifest().sha256, documentHashes: {} });
  const exported = service.handle(exportRequest); assert.ok(exported.result);
  assert.deepEqual(service.handle(exportRequest), exported);
  const originalManifest = readFileSync(join(root, 'workbench.json'));
  writeFileSync(join(root, 'workbench.json'), '{later malformed file must not replay or invalidate a finished export');
  assert.deepEqual(service.handle(exportRequest), exported);
  assert.equal(service.handle({ ...exportRequest, params: { ...exportRequest.params, destination: join(directory, 'changed-intent') } }).error?.code, 'REQUEST_ID_CONFLICT');
  writeFileSync(join(root, 'workbench.json'), originalManifest);
  const restoreRequest = request('project.restore', { archiveDirectory: join(directory, 'export'), newProjectRoot: join(directory, 'restored-project'), newDataRoot: join(directory, 'restored-data') });
  const restored = service.handle(restoreRequest); assert.ok(restored.result);
  const inventory = readdirSync(directory);
  assert.deepEqual(service.handle(restoreRequest), restored);
  assert.deepEqual(readdirSync(directory), inventory);
  assert.equal(project.store.getProject(manifest.projectId).root, root);
  assert.equal(project.store.readArtifact(manifest.projectId, artifact.artifactId).toString(), 'retained synthetic evidence');
  assert.deepEqual(project.devices.status(), []);
  assert.equal(service.handle(request('project.restore', { ...restoreRequest.params, newProjectRoot: root })).error?.code, 'UNAUTHORIZED_SCOPE');
});

test('failed admitted restore is not replayed after archive repair', t => {
  const { directory, project, service, request } = fixture(t);
  const archiveDirectory = join(directory, 'export'), newProjectRoot = join(directory, 'restored-project'), newDataRoot = join(directory, 'restored-data');
  assert.ok(service.handle(request('project.export', { destination: archiveDirectory, expectedManifestSha256: project.files.inspectManifest().sha256, documentHashes: {} })).result);
  const metadata = join(archiveDirectory, 'archive.json'), original = readFileSync(metadata);
  writeFileSync(metadata, 'bad synthetic archive');
  const restoreRequest = request('project.restore', { archiveDirectory, newProjectRoot, newDataRoot });
  assert.equal(service.handle(restoreRequest).error?.code, 'INVALID_REQUEST');
  writeFileSync(metadata, original);
  assert.equal(service.handle(restoreRequest).error?.code, 'OUTCOME_UNKNOWN');
  assert.equal(existsSync(newProjectRoot), false);
  assert.equal(existsSync(newDataRoot), false);
});
