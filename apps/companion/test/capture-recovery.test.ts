import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { RawRecorder } from '@robotics-workbench/serial';
import type { OperationReceipt, ProjectRequest } from '@robotics-workbench/contracts';
import { ProjectService } from '../src/project-service';
import { HardwareService, type StoredRecording } from '../src/hardware-service';
import { FakeSerialTransport } from '../../../packages/test-fixtures/devices/fake-serial';
import { exportProject, restoreProject } from '../src/project-archive';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-capture-recovery-')), root = join(directory, 'project'), data = join(directory, 'data'); mkdirSync(root);
  writeFileSync(join(root, 'workbench.json'), readFileSync('examples/workbench.valid.json'));
  mkdirSync(join(root, 'RangeSensor')); writeFileSync(join(root, 'RangeSensor/RangeSensor.ino'), '// Synthetic capture-recovery source; never uploaded.\nvoid setup(){}\nvoid loop(){}\n');
  let project = new ProjectService(root, data), transport = new FakeSerialTransport(), hardware = new HardwareService(project, '', undefined, { transport });
  t.after(async () => { await project.shutdown(); assert.equal(dirname(realpathSync(directory)), realpathSync(tmpdir())); rmSync(directory, { recursive: true, force: true }); });
  const operation: OperationReceipt = { schemaVersion: 1, operationId: randomUUID(), requestId: randomUUID(), projectId: project.projectId, kind: 'serial-capture', status: 'queued', expectedProjectRevision: 1, createdAt: new Date().toISOString(), tool: { name: 'synthetic-receive', version: '1' }, artifacts: [] };
  project.store.createOperation(operation, { synthetic: true }); project.store.transitionOperation(project.projectId, operation.operationId, 'running');
  const recorder = new RawRecorder(hardware.workRoot, { projectId: project.projectId, projectRevision: 1, deviceId: randomUUID() }), initial = recorder.snapshot();
  project.store.putRecord('observations', recorder.recordingId, project.projectId, { kind: 'capture-intent', operationId: operation.operationId, directory: recorder.directory, recording: initial });
  const bytes = Buffer.from('range:31\nrange:32\n'); recorder.receive(bytes);
  const before = recorder.snapshot(), closed = recorder.finish(), originalPath = closed.segments[0].path, partialPath = originalPath.replace(/\.jsonl$/, '.partial.jsonl'); renameSync(originalPath, partialPath);
  writeFileSync(join(recorder.directory, 'metadata.json'), JSON.stringify({ ...before, status: 'recording', segments: [] }));
  appendFileSync(partialPath, '{"incomplete":');
  return { directory, recorder, bytes, partialPath, operation, get project() { return project; }, get hardware() { return hardware; }, get transport() { return transport; }, async restart() { await project.shutdown(); project = new ProjectService(root, data); transport = new FakeSerialTransport(); hardware = new HardwareService(project, '', undefined, { transport }); } };
}

test('startup retains exact interrupted capture prefixes and tail without reopening a device or promoting the old operation', async t => {
  const f = await fixture(t), original = readFileSync(f.partialPath); await f.restart();
  const old = f.project.store.getOperation(f.project.projectId, f.operation.operationId); assert.equal(old.status, 'failed');
  const recording = f.project.store.getRecord<StoredRecording>('recordings', f.recorder.recordingId, f.project.projectId); assert.equal(recording.status, 'interrupted'); assert.equal(recording.rawBytes, f.bytes.length); assert.equal(recording.rawSha256, createHash('sha256').update(f.bytes).digest('hex')); assert.equal(recording.gaps.at(-1)!.cause, 'service-restart'); assert.equal(recording.gaps.at(-1)!.lostBytes, null);
  assert.deepEqual(readFileSync(f.partialPath), original); assert.equal(f.transport.connections.length, 0);
  const request: ProjectRequest = { schemaVersion: 1, requestId: randomUUID(), projectId: f.project.projectId, method: 'recording.query', params: { recordingId: f.recorder.recordingId, range: { startMs: 0, endMs: 60000, timeBasis: 'host-receive' } } };
  const response = await f.hardware.handle(request); assert.equal(response.error, undefined); assert.deepEqual(Buffer.from((response.result as { bytesBase64: string }).bytesBase64, 'base64'), f.bytes);
  const recovery = f.project.store.listRecords<{ kind: string; recoveredSources: { incompleteTailBytes: number; quarantinePath: string; originalArtifactId: string; tailArtifactId: string }[] }>('observations', f.project.projectId).find(item => item.kind === 'capture-recovery')!;
  assert.ok(recovery.recoveredSources[0].incompleteTailBytes > 0); assert.equal(readFileSync(recovery.recoveredSources[0].quarantinePath, 'utf8'), '{"incomplete":');
  await f.restart(); assert.deepEqual(f.project.store.getRecord('recordings', f.recorder.recordingId, f.project.projectId), recording); assert.deepEqual(f.project.store.getOperation(f.project.projectId, f.operation.operationId), old); assert.equal(f.transport.connections.length, 0);
  const archivePath = join(f.directory, 'archive'); exportProject(f.project.files, f.project.store, archivePath, () => ({ dirtyPaths: [] }));
  const dataRoot = f.project.store.dataRoot; await f.project.shutdown(); renameSync(dataRoot, dataRoot + '-unavailable');
  const restored = restoreProject(archivePath, join(f.directory, 'restored-project'), join(f.directory, 'restored-data'));
  try { assert.deepEqual(restored.store.readArtifact(f.project.projectId, recovery.recoveredSources[0].originalArtifactId), original); assert.equal(restored.store.readArtifact(f.project.projectId, recovery.recoveredSources[0].tailArtifactId).toString('utf8'), '{"incomplete":'); }
  finally { restored.store.close(); }
});

test('a foreign raw recording ID leaves original bytes intact and never publishes false recovery evidence', async t => {
  const f = await fixture(t), line = readFileSync(f.partialPath, 'utf8').split('\n')[0], record = JSON.parse(line); record.recordingId = randomUUID();
  const changed = JSON.stringify(record) + '\n'; writeFileSync(f.partialPath, changed); await f.restart();
  assert.throws(() => f.project.store.getRecord('recordings', f.recorder.recordingId, f.project.projectId), { code: 'NOT_FOUND' }); assert.equal(readFileSync(f.partialPath, 'utf8'), changed); assert.equal(f.transport.connections.length, 0);
  assert.equal(f.project.store.getOperation(f.project.projectId, f.operation.operationId).status, 'failed');
});
