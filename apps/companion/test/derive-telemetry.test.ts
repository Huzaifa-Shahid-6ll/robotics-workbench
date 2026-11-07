import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { WorkbenchStore } from '@robotics-workbench/persistence';
import { RawRecorder, createParserProfile } from '@robotics-workbench/serial';
import { deriveTelemetryInWorker } from '../src/derive-telemetry';
import { HardwareService, type CaptureEvent, type StoredRecording } from '../src/hardware-service';
import { ProjectService } from '../src/project-service';
import { FakeSerialTransport } from '../../../packages/test-fixtures/devices/fake-serial';

const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const profile = createParserProfile({ schemaVersion: 1, id: '66666666-6666-4666-8666-666666666666', parserVersion: 'telemetry-v1', mode: 'labeled-numeric', channels: [{ channelId: 'range', label: 'Range', source: 'range', unit: 'mm' }] });
const workerPath = resolve('apps/extension/dist/telemetry-worker.cjs');
function temp() {
  const base = resolve('artifacts/task09-worker'); mkdirSync(base, { recursive: true }); const root = mkdtempSync(join(base, 'case-'));
  return root;
}
function remove(root: string) {
  assert.ok(!relative(resolve('artifacts/task09-worker'), root).startsWith('..')); rmSync(root, { recursive: true, force: true });
}
function fixture(t: TestContext) {
  const root = temp(), projectId = randomUUID(), store = new WorkbenchStore(join(root, 'data')); t.after(() => { store.close(); remove(root); });
  store.registerProject({ projectId, root, projectRevision: 1, manifestSha256: sha('synthetic') });
  const recorder = new RawRecorder(root, { projectId, projectRevision: 1, deviceId: randomUUID() }); recorder.receive(Buffer.from('range:1\nran')); recorder.receive(Buffer.from('ge:3\n'));
  const result = recorder.finish(), segments = result.segments.map(segment => { const artifact = store.storeArtifact(projectId, readFileSync(segment.path), 'application/x-ndjson'); return { ...segment, artifactId: artifact.artifactId }; });
  const recording: StoredRecording = { ...result, segments };
  return { root, store, recording, path: join(store.dataRoot, 'artifacts', segments[0].sha256) };
}
test('worker verifies retained artifact bytes and derives deterministic replay without modifying source', async t => {
  const { store, recording, path } = fixture(t), before = readFileSync(path);
  let mainLoopRan = false; const pending = deriveTelemetryInWorker(store, recording, profile, undefined, { workerPath });
  await new Promise<void>(resolve => setImmediate(() => { mainLoopRan = true; resolve(); }));
  const result = await pending;
  assert.equal(mainLoopRan, true); assert.deepEqual(result.samples.map(sample => sample.value), [1, 3]); assert.equal(result.rawSha256, recording.rawSha256);
  assert.deepEqual(readFileSync(path), before); assert.equal((await deriveTelemetryInWorker(store, recording, profile, undefined, { workerPath })).derivationId, result.derivationId);
});
test('worker rejects corrupt segment hashes and mismatched recording IDs while preserving evidence', async t => {
  const { store, recording, path } = fixture(t), before = readFileSync(path);
  const corrupted = Buffer.from(before); corrupted[corrupted.length - 2] ^= 1; writeFileSync(path, corrupted);
  await assert.rejects(deriveTelemetryInWorker(store, recording, profile, undefined, { workerPath }), { code: 'ARTIFACT_MISMATCH' }); assert.deepEqual(readFileSync(path), corrupted);
  writeFileSync(path, before);
  await assert.rejects(deriveTelemetryInWorker(store, { ...recording, recordingId: randomUUID() }, profile, undefined, { workerPath }), { code: 'ARTIFACT_MISMATCH' }); assert.deepEqual(readFileSync(path), before);
});
test('worker rejects shared hardlinks and forged segment metadata', async t => {
  const { root, store, recording, path } = fixture(t); linkSync(path, join(root, 'shared-copy'));
  await assert.rejects(deriveTelemetryInWorker(store, recording, profile, undefined, { workerPath }), { code: 'UNAUTHORIZED_SCOPE' });
  await assert.rejects(deriveTelemetryInWorker(store, { ...recording, segments: [{ ...recording.segments[0], sha256: '0'.repeat(64) }] }, profile, undefined, { workerPath }), { code: 'ARTIFACT_MISMATCH' });
});
test('failed partial raw segment analyzes only its verified complete prefix without repairing source bytes', async t => {
  const { store, recording, path } = fixture(t), before = readFileSync(path);
  const original = recording.segments[0], raw = Buffer.concat([before, Buffer.from('{"schemaVersion":1,"bytesBase64":"dW5maW5pc2hlZA=="')]);
  const artifact = store.storeArtifact(recording.projectId, raw, 'application/x-ndjson'), partialPath = join(store.dataRoot, artifact.relativePath);
  const partial: StoredRecording = { ...recording, status: 'failed', segments: [{ ...original, artifactId: artifact.artifactId, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes, complete: false }] };
  const result = await deriveTelemetryInWorker(store, partial, profile, undefined, { workerPath });
  assert.deepEqual(result.samples.map(sample => sample.value), [1, 3]); assert.deepEqual(result.segmentSha256s, [sha(raw)]);
  assert.equal(result.rawSha256, recording.rawSha256); assert.equal(result.issues.at(-1)?.code, 'incomplete-frame'); assert.deepEqual(result.issues.at(-1)?.raw, []);
  assert.deepEqual(readFileSync(partialPath), raw); assert.deepEqual(readFileSync(path), before);
  await assert.rejects(deriveTelemetryInWorker(store, { ...partial, status: 'completed' }, profile, undefined, { workerPath }), { code: 'INVALID_REQUEST' });
  await assert.rejects(deriveTelemetryInWorker(store, { ...partial, segments: [{ ...partial.segments[0], complete: true }] }, profile, undefined, { workerPath }), { code: 'INVALID_REQUEST' });
  await assert.rejects(deriveTelemetryInWorker(store, { ...partial, rawBytes: recording.rawBytes + 1 }, profile, undefined, { workerPath }), { code: 'ARTIFACT_MISMATCH' });
  assert.deepEqual(readFileSync(partialPath), raw);
});
test('deadline and cancellation terminate isolated work and preserve exact artifacts', async t => {
  const { root, store, recording, path } = fixture(t), before = readFileSync(path), hanging = join(root, 'hanging.cjs');
  writeFileSync(hanging, 'setInterval(() => {}, 1000);');
  await assert.rejects(deriveTelemetryInWorker(store, recording, profile, undefined, { workerPath: hanging, timeoutMs: 10 }), { code: 'TELEMETRY_TIMEOUT' });
  const controller = new AbortController(), pending = deriveTelemetryInWorker(store, recording, profile, controller.signal, { workerPath: hanging });
  controller.abort(); await assert.rejects(pending, { code: 'CANCELLED' });
  await assert.rejects(deriveTelemetryInWorker(store, recording, profile, controller.signal, { workerPath }), { code: 'CANCELLED' }); assert.deepEqual(readFileSync(path), before);
});
test('capture observers receive start/record/gap/finish from one coordinator and cannot change outcomes', { timeout: 30_000 }, async t => {
  const root = temp(), projectRoot = join(root, 'project'); mkdirSync(projectRoot);
  const manifest = JSON.parse(readFileSync('examples/workbench.valid.json', 'utf8')); writeFileSync(join(projectRoot, 'workbench.json'), JSON.stringify(manifest));
  const project = new ProjectService(projectRoot, join(root, 'data')); t.after(async () => { await project.shutdown(); remove(root); });
  const transport = new FakeSerialTransport(), hardware = new HardwareService(project, '', undefined, { transport });
  const observation = { deviceId: randomUUID(), observationId: randomUUID(), transportPath: 'COM9', observedAt: new Date().toISOString(), connected: true, identityStatus: 'identified' as const };
  hardware.devices.observe(observation);
  const events: CaptureEvent[] = []; hardware.setCaptureObserver(event => { events.push(event); throw new Error('Synthetic display failed'); });
  const response = await hardware.handle({ schemaVersion: 1, requestId: randomUUID(), projectId: manifest.projectId, method: 'serial.capture', params: { deviceId: observation.deviceId, baudRate: 9600, durationMs: 1000 } });
  assert.ok(response.result); const receipt = response.result as { operationId: string; status: string }; assert.equal(receipt.status, 'queued');
  const deadline = Date.now() + 3000;
  while (!transport.connections.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(hardware.liveRecordings().length, 1); transport.emit('COM9', Buffer.from('range:4\n')); transport.disconnect('COM9');
  assert.ok(hardware.liveRecordings()[0].preview.omittedDisplayEvents >= 3);
  // Synchronous raw persistence can consume the polling budget before capture's timer runs.
  const completed = await project.jobs.wait(receipt.operationId);
  assert.equal(completed.status, 'failed', JSON.stringify(completed));
  assert.equal(completed.error?.code, 'CAPTURE_FAILED');
  assert.deepEqual(events.map(event => event.type), ['start', 'record', 'gap', 'finish']);
  assert.equal(events.find(event => event.type === 'record')?.recording.rawBytes, 8); assert.equal(hardware.liveRecordings().length, 0);
  const recordingId = events.at(-1)!.recording.recordingId;
  const retained = project.store.getRecord<{ recordingId: string; status: string; rawBytes: number }>('recordings', recordingId, manifest.projectId);
  assert.equal(retained.recordingId, recordingId); assert.equal(retained.rawBytes, 8);
  assert.equal(retained.status, 'failed'); assert.equal(events.at(-1)?.recording.status, 'failed');
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(events.length, 4, 'No late gap follows finalized capture.');
  assert.equal(project.store.getOperation(manifest.projectId, receipt.operationId).status, 'failed'); assert.equal(transport.connections.length, 1);
});
