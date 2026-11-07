import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectService } from '../src/project-service';
import { HardwareService, type BuildRecord } from '../src/hardware-service';
import { WorkbenchError, isOperationReceipt, type OperationReceipt, type ProjectRequest } from '@robotics-workbench/contracts';
import { fingerprintTree, type CompileResult, type DiscoveredPort } from '@robotics-workbench/arduino';
import { FakeSerialTransport } from '../../../packages/test-fixtures/devices/fake-serial';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
async function fixture(t: TestContext) {
  const temp = mkdtempSync(join(tmpdir(), 'workbench-hardware-'));
  const root = join(temp, 'Probe'); mkdirSync(root);
  const manifest = JSON.parse(readFileSync('examples/workbench.valid.json', 'utf8'));
  manifest.sketches[0].path = '.';
  writeFileSync(join(root, 'workbench.json'), JSON.stringify(manifest));
  const sketch = join(root, 'Probe.ino'); writeFileSync(sketch, 'void setup() {}\nvoid loop() {}\n');
  const project = new ProjectService(root, join(temp, 'data'));
  t.after(async () => { await project.shutdown(); rmSync(temp, { recursive: true, force: true }); });
  const transport = new FakeSerialTransport();
  let uploads = 0, compilations = 0, failed = false, staleTool = false;
  let ports: DiscoveredPort[] = [{ address: 'COM4', protocol: 'serial', label: 'Synthetic Uno', properties: { serialNumber: 'synthetic-only', vid: '2341', pid: '0043' }, matchingBoards: [{ name: 'Uno fixture', fqbn: 'arduino:avr:uno' }] }];
  const processResult = { exitCode: 0, signal: null, stdout: 'synthetic', stderr: '', stdoutBytes: 9, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false, logsTruncated: false, timedOut: false, cancelled: false, terminationObserved: true };
  const adapter = {
    inspect: async () => { throw new Error('Unused in synthetic integration'); },
    discover: async () => ports,
    assertCurrent: async () => { if (staleTool) throw new WorkbenchError('REVISION_CONFLICT', 'Synthetic toolchain changed'); },
    compile: async (input: Parameters<HardwareService['arduino']['compile']>[0]): Promise<CompileResult> => {
      compilations++;
      const path = join(temp, `${randomUUID()}.hex`), bytes = ':synthetic-hex'; writeFileSync(path, bytes);
      const output = { path, sha256: sha(bytes), sizeBytes: bytes.length, mediaType: 'application/octet-stream' };
      return { succeeded: !failed, sourceSnapshotId: input.snapshot.sourceSnapshotId, inputFingerprint: sha('inputs'), sourceSha256: input.snapshot.sha256,
        fqbn: input.fqbn, boardOptions: input.boardOptions, warnings: 'default', toolchain: { schemaVersion: 1, executablePath: process.execPath, executableSha256: sha('cli'), version: 'synthetic', checkedAt: new Date().toISOString(), configuration: { directories: { data: temp, user: temp, downloads: temp } }, cores: [], libraries: [], capabilities: { compileJson: true, exactFileUpload: true, supportedUploadFqbns: ['arduino:avr:uno'] }, helpSha256: { compile: sha('help'), upload: sha('help') } },
        buildProperties: {}, libraryInputs: [], diagnostics: failed ? [{ path: 'Probe.ino', line: 1, column: 1, severity: 'error', message: 'Synthetic failure', sourceSnapshotId: input.snapshot.sourceSnapshotId }] : [],
        outputs: failed ? [] : [output], ...(!failed ? { uploadArtifact: output } : {}), process: { ...processResult, exitCode: failed ? 1 : 0 }, limitations: ['Synthetic adapter; no physical evidence'], operationDirectory: temp };
    },
    upload: async () => { uploads++; assert.ok(transport.connections.every(item => item.closed)); return processResult; }
  };
  const hardware = new HardwareService(project, process.execPath, undefined, { arduino: adapter, transport });
  const request = (method: ProjectRequest['method'], params: Record<string, unknown>, revision?: number): ProjectRequest => ({ schemaVersion: 1, requestId: randomUUID(), projectId: project.projectId, method, params, ...(revision !== undefined ? { expectedProjectRevision: revision } : {}) });
  const call = async <T>(value: ProjectRequest): Promise<T> => { const response = await hardware.handle(value); if (response.error) throw new WorkbenchError(response.error.code, response.error.message); return response.result as T; };
  const compile = async () => {
    const prepRequest = request('project.prepareBuild', { targetId: manifest.targets[0].targetId, documentHashes: [{ path: 'Probe.ino', sha256: sha(readFileSync(sketch, 'utf8')) }] }, 1);
    const prepared = await call<{ sourceSnapshotId: string }>(prepRequest);
    const compileRequest = request('build.compile', { targetId: manifest.targets[0].targetId, sourceSnapshotId: prepared.sourceSnapshotId }, 1);
    const receipt = await call<OperationReceipt>(compileRequest);
    return { prepared, prepRequest, compileRequest, receipt: await project.jobs.wait(receipt.operationId) };
  };
  const uploadRequest = async (build: { buildId: string; uploadArtifact: { artifactId: string; sha256: string } }) => {
    const device = (await hardware.discover()).find(item => item.observation.connected)!;
    return request('firmware.upload', { buildId: build.buildId, artifactId: build.uploadArtifact.artifactId, artifactSha256: build.uploadArtifact.sha256, deviceId: device.observation.deviceId, expectedDeviceObservationId: device.observation.observationId, fqbn: 'arduino:avr:uno', resumeMonitoring: true }, 1);
  };
  return { temp, root, sketch, project, hardware, transport, call, request, compile, uploadRequest,
    counters: () => ({ uploads, compilations }), fail: () => { failed = true; }, stale: () => { staleTool = true; }, ports: (value: DiscoveredPort[]) => { ports = value; } };
}

test('known old manifest builds never read input trees while current-revision library edits still invalidate exact build currency', async t => {
  const f = await fixture(t), compiled = await f.compile(); assert.equal(compiled.receipt.status, 'succeeded');
  const build = f.project.store.listRecords<BuildRecord>('builds', f.project.projectId)[0], library = join(f.temp, 'library'), source = join(library, 'fixture.h'); mkdirSync(library); writeFileSync(source, 'const int fixture = 1;');
  build.buildId = randomUUID(); build.libraryInputs = [fingerprintTree(library)]; f.project.store.putRecord('builds', build.buildId, f.project.projectId, build);
  const initial = await f.hardware.inputHashesAsync(); assert.equal(initial.get(library), build.libraryInputs[0].sha256); assert.equal(await f.hardware.currentAsync(build), true);
  writeFileSync(source, 'const int fixture = 2;'); const changed = await f.hardware.inputHashesAsync(); assert.notEqual(changed.get(library), initial.get(library)); assert.equal(await f.hardware.currentAsync(build), false, 'Current-revision library bytes remain freshly verified.');
  const manifestPath = join(f.root, 'workbench.json'), manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); manifest.projectRevision++; writeFileSync(manifestPath, JSON.stringify(manifest));
  const inaccessible = join(f.temp, 'must-not-inspect-old-build'), historical = { ...build, buildId: randomUUID(), libraryInputs: [...build.libraryInputs, { path: inaccessible, sha256: sha('historical'), files: 1, sizeBytes: 1 }] }; f.project.store.putRecord('builds', historical.buildId, f.project.projectId, historical);
  let reads = 0; const realpath = fs.realpath;
  t.mock.method(fs, 'realpath', async (...args: Parameters<typeof fs.realpath>) => { reads++; if (String(args[0]) === inaccessible) throw new Error('Old input path is deliberately unavailable'); return realpath(...args); });
  assert.equal((await f.hardware.inputHashesAsync()).size, 0); assert.equal(await f.hardware.currentAsync(build), false); assert.equal((f.hardware.summaries()[0] as { sourceCurrent: boolean }).sourceCurrent, false); assert.equal(reads, 0, 'Known revision mismatch must perform zero asynchronous tree reads, including inaccessible historical inputs.');
});

test('root sketch snapshot, immutable compile receipts, replay and failed-build diagnostics integrate', async t => {
  const f = await fixture(t), built = await f.compile();
  assert.equal(built.receipt.status, 'succeeded'); assert.equal(isOperationReceipt(built.receipt), true);
  const build = built.receipt.result as { buildId: string; uploadArtifact: { artifactId: string; sha256: string } };
  assert.equal((f.hardware.summaries()[0] as { sourceCurrent: boolean }).sourceCurrent, true);
  writeFileSync(f.sketch, '// later edit');
  assert.equal((await f.call<OperationReceipt>(built.compileRequest)).operationId, built.receipt.operationId);
  assert.deepEqual(await f.call(built.prepRequest), { ...built.prepared, manifestSha256: f.project.files.inspectManifest().sha256 });
  assert.equal((f.hardware.summaries()[0] as { sourceCurrent: boolean }).sourceCurrent, false);
  const upload = await f.call<OperationReceipt>(await f.uploadRequest(build));
  assert.equal((await f.project.jobs.wait(upload.operationId)).error?.code, 'ARTIFACT_MISMATCH');
  assert.equal(f.counters().uploads, 0);
  f.fail(); const bad = await f.compile();
  assert.equal(bad.receipt.status, 'failed');
  const summary = f.hardware.summaries().find(item => (item as { operationId: string }).operationId === bad.receipt.operationId) as { buildId: string; uploadArtifact?: unknown };
  assert.ok(summary); assert.equal(summary.uploadArtifact, undefined);
  const diagnostics = await f.call<{ items: unknown[] }>(f.request('build.diagnostics', { buildId: summary.buildId }));
  assert.equal(diagnostics.items.length, 1);
  const failedBuild = f.project.store.listRecords<any>('builds', f.project.projectId).find(item => item.buildId === summary.buildId);
  const expanded = { ...failedBuild, buildId: randomUUID(), diagnostics: Array.from({ length: 30 }, () => ({ ...failedBuild.diagnostics[0], message: 'x'.repeat(1800) })) };
  f.project.store.putRecord('builds', expanded.buildId, f.project.projectId, expanded);
  const page = await f.call<{ items: unknown[]; nextCursor: string }>(f.request('build.diagnostics', { buildId: expanded.buildId, limit: 1 }));
  assert.equal(page.items.length, 1); assert.ok(page.nextCursor);
  const next = await f.call<{ items: unknown[] }>(f.request('build.diagnostics', { buildId: expanded.buildId, cursor: page.nextCursor }));
  assert.ok(next.items.length > 1); assert.ok(Buffer.byteLength(JSON.stringify(next)) < 32768);
  await assert.rejects(f.call(f.request('build.diagnostics', { buildId: build.buildId, cursor: page.nextCursor })), { code: 'INVALID_REQUEST' });
});

test('device observation stays stable, replacements change identity, scoped admissions reject collisions', async t => {
  const f = await fixture(t);
  const first = (await f.hardware.discover())[0];
  assert.deepEqual((await f.hardware.discover())[0].observation, first.observation);
  f.ports([{ address: 'COM4', protocol: 'serial', label: 'Replacement', properties: { serialNumber: 'replacement' }, matchingBoards: [] }]);
  const current = await f.hardware.discover();
  assert.equal(current.find(item => item.observation.deviceId === first.observation.deviceId)?.observation.connected, false);
  assert.notEqual(current.find(item => item.observation.connected)?.observation.deviceId, first.observation.deviceId);
  const bad = f.request('project.prepareBuild', { targetId: randomUUID(), documentHashes: [] }, 1);
  await assert.rejects(f.call(bad), { code: 'NOT_FOUND' });
  await assert.rejects(f.call(bad), { code: 'OUTCOME_UNKNOWN' });
  await assert.rejects(f.call({ ...bad, params: { ...bad.params, targetId: randomUUID() } }), { code: 'REQUEST_ID_CONFLICT' });
  await assert.rejects(f.call({ ...bad, projectId: randomUUID() }), { code: 'UNAUTHORIZED_SCOPE' });
});

test('capture upload handoff preserves raw data, gaps and advancing scoped cursors', async t => {
  const f = await fixture(t), built = await f.compile();
  const device = (await f.hardware.discover())[0];
  const capture = await f.call<OperationReceipt>(f.request('serial.capture', { deviceId: device.observation.deviceId, baudRate: 115200, durationMs: 60000 }));
  const readyBy = Date.now() + 10000;
  while (f.hardware.devices.status(device.observation.deviceId)[0].state !== 'monitoring' && Date.now() < readyBy) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.hardware.devices.status(device.observation.deviceId)[0].state, 'monitoring');
  const before = 'A'.repeat(24000); f.transport.emit('COM4', Buffer.from(before));
  const upload = await f.call<OperationReceipt>(await f.uploadRequest(built.receipt.result as any));
  assert.equal((await f.project.jobs.wait(upload.operationId)).status, 'succeeded');
  f.transport.emit('COM4', Buffer.from('after-upload\n'));
  f.project.jobs.requestCancel(f.project.projectId, capture.operationId);
  const finished = await f.project.jobs.wait(capture.operationId);
  assert.equal(finished.status, 'cancelled'); assert.equal(isOperationReceipt(finished), true);
  const params = { recordingId: finished.result!.recordingId, range: { startMs: 0, endMs: 60000, timeBasis: 'host-receive' } };
  let text = '', cursor: string | null = null, pages = 0;
  do {
    const page: { text: string; nextCursor: string | null; gaps: { cause: string }[] } = await f.call(f.request('recording.query', { ...params, ...(cursor ? { cursor } : {}) }));
    text += page.text; assert.equal(page.gaps.filter(item => item.cause === 'upload').length, 1); cursor = page.nextCursor; assert.ok(++pages < 10);
  } while (cursor);
  assert.equal(text, before + 'after-upload\n'); assert.ok(pages >= 2);
  const first = await f.call<{ nextCursor: string }>(f.request('recording.query', params));
  await assert.rejects(f.call(f.request('recording.query', { ...params, range: { ...params.range, endMs: 100 }, cursor: first.nextCursor })), { code: 'INVALID_REQUEST' });
  assert.equal(f.counters().uploads, 1);
});

test('changed toolchain blocks exact-artifact upload before any external effect', async t => {
  const f = await fixture(t), built = await f.compile(); f.stale();
  const upload = await f.call<OperationReceipt>(await f.uploadRequest(built.receipt.result as any));
  assert.equal((await f.project.jobs.wait(upload.operationId)).error?.code, 'REVISION_CONFLICT');
  assert.equal(f.counters().uploads, 0);
});

test('binary recording windows advance without UTF8 expansion loops and preserve exact byte pages', async t => {
  const f = await fixture(t), device = (await f.hardware.discover())[0];
  const capture = await f.call<OperationReceipt>(f.request('serial.capture', { deviceId: device.observation.deviceId, baudRate: 9600, durationMs: 1000 }));
  await new Promise(resolve => setTimeout(resolve, 30));
  const binary = Buffer.alloc(8192, 255);
  f.transport.emit('COM4', binary); f.transport.emit('COM4', Buffer.from([0xe2])); f.transport.emit('COM4', Buffer.from([0x82, 0xac]));
  const receipt = await f.project.jobs.wait(capture.operationId);
  const chunks: Buffer[] = []; let cursor: string | null = null, pages = 0, lastText = '';
  do {
    const page: { text: string; bytesBase64: string; nextCursor: string | null } = await f.call(f.request('recording.query', { recordingId: receipt.result!.recordingId, range: { startMs: 0, endMs: 2000, timeBasis: 'host-receive' }, ...(cursor ? { cursor } : {}) }));
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 32768); chunks.push(Buffer.from(page.bytesBase64, 'base64')); lastText = page.text;
    assert.notEqual(page.nextCursor, cursor); cursor = page.nextCursor; assert.ok(++pages < 5);
  } while (cursor);
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat([binary, Buffer.from('€')])); assert.equal(lastText, '€');
});
