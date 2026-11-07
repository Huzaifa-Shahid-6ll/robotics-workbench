import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { DIAGNOSTIC_BUNDLE_BYTES, DIAGNOSTIC_MEDIA_TYPE, isDiagnosticBundle, isDiagnosticExportResult, isDiagnosticPreview, isProjectRequest, type DiagnosticBundleV1, type DiagnosticPreviewV1, type OperationReceipt, type ProjectRequest, type ProjectResponse } from '@robotics-workbench/contracts';
import { ProjectService } from '../src/project-service';
import { DiagnosticsService } from '../src/diagnostics-service';

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function value<T>(response: ProjectResponse): T { assert.equal(response.error, undefined, JSON.stringify(response.error)); return response.result as T; }
function fixture(t: TestContext) {
  const parent = join(process.cwd(), 'artifacts/task12-diagnostics'); fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(join(parent, 'unit-')), root = join(directory, 'project'); fs.mkdirSync(join(root, 'RangeSensor'), { recursive: true });
  const manifest = JSON.parse(fs.readFileSync('examples/workbench.valid.json', 'utf8')); manifest.projectId = randomUUID(); manifest.name = 'PRIVATE_PROJECT_NAME_CANARY';
  fs.writeFileSync(join(root, 'workbench.json'), JSON.stringify(manifest)); fs.writeFileSync(join(root, 'RangeSensor/RangeSensor.ino'), '// PRIVATE_SOURCE_CANARY\nvoid setup() {}\nvoid loop() {}\n');
  const project = new ProjectService(root, join(directory, 'data')), service = new DiagnosticsService(project, { appVersion: '0.1.0' });
  t.after(() => { project.close(); const within = relative(fs.realpathSync(parent), fs.realpathSync(directory)); assert.ok(within && !isAbsolute(within) && within !== '..' && !within.startsWith(`..${sep}`)); fs.rmSync(directory, { recursive: true, force: true }); });
  const request = (method: ProjectRequest['method'], params: Record<string, unknown> = {}): ProjectRequest => ({ schemaVersion: 1, requestId: randomUUID(), projectId: project.projectId, expectedProjectRevision: 1, method, params });
  const preview = () => { const result = value<DiagnosticPreviewV1>(service.handle(request('diagnostics.preview'))); assert.ok(isDiagnosticPreview(result)); return result; };
  const exportRequest = (report: DiagnosticPreviewV1, destination = join(directory, `${randomUUID()}.json`)) => request('diagnostics.export', { previewId: report.previewId, expectedBundleSha256: report.bundleSha256, destination });
  return { directory, root, project, service, request, preview, exportRequest, manifest };
}

test('private diagnostic preview excludes source, raw recordings, documents, provider text, credentials and paths; export writes exactly reviewed bytes', t => {
  const f = fixture(t), source = fs.readFileSync(join(f.root, 'RangeSensor/RangeSensor.ino'));
  const privateMarkers = ['PRIVATE_SERIAL_CANARY', 'PRIVATE_DOCUMENT_CANARY', 'PRIVATE_PROVIDER_TRANSCRIPT', 'PRIVATE_AUTH_URL', 'PRIVATE_RAW_LOG_TEXT'];
  f.project.store.putRecord('recordings', randomUUID(), f.project.projectId, { text: privateMarkers[0] });
  f.project.store.putRecord('documents', randomUUID(), f.project.projectId, { text: privateMarkers[1] });
  f.project.store.putRecord('sessions', randomUUID(), f.project.projectId, { userText: privateMarkers[2], messages: [{ text: privateMarkers[2] }] });
  f.project.store.appendEvent(f.project.projectId, 1, 'PRIVATE_EVENT_TYPE', { message: privateMarkers[4], url: `https://private.invalid/?session=${privateMarkers[3]}` });
  t.mock.method(f.project.store, 'listRecords', () => { assert.fail('Diagnostic generation must not scan private record tables.'); });
  const actualList = f.project.store.listOperations.bind(f.project.store);
  const operation: OperationReceipt = { schemaVersion: 1, operationId: randomUUID(), requestId: randomUUID(), projectId: f.project.projectId, kind: 'compile', status: 'failed', expectedProjectRevision: 1, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(), tool: { name: 'PRIVATE_TOOL_PATH_C:/Users/ExamplePrivateFixture', version: 'Arduino CLI 1.5.1' }, artifacts: [], error: { code: 'PRIVATE_CODE', message: 'Bearer syntheticcredentialmaterial123456 https://private.invalid/auth', retryable: false } };
  t.mock.method(f.project.store, 'listOperations', () => [...actualList(f.project.projectId), operation]);
  const report = f.preview(), bundle = JSON.parse(report.text) as DiagnosticBundleV1;
  assert.equal(bundle.storage.recoveryBasis, 'companion-startup-scan');
  for (const forbidden of [...privateMarkers, 'PRIVATE_SOURCE_CANARY', 'PRIVATE_PROJECT_NAME_CANARY', 'PRIVATE_TOOL_PATH', 'PRIVATE_CODE', 'Bearer', 'syntheticcredentialmaterial', 'https://', f.root, f.project.store.dataRoot]) assert.equal(report.text.includes(forbidden), false, forbidden);
  assert.equal(bundle.tools.find(tool => tool.toolId === 'arduino-cli')!.version, '1.5.1');
  assert.equal(bundle.tools.find(tool => tool.toolId === 'codex')!.version, null); assert.ok(bundle.tools.every(tool => tool.currentVerified === false));
  assert.equal(bundle.logs.some(log => log.type === 'other-redacted'), true); assert.equal(bundle.operations[0].errorPresent, true);
  assert.equal(sha(report.text), report.bundleSha256); assert.ok(report.byteLength <= DIAGNOSTIC_BUNDLE_BYTES);
  f.project.store.appendEvent(f.project.projectId, 1, 'build.failed', { message: 'PRIVATE_LATER_EVENT' });
  const req = f.exportRequest(report), response = new DiagnosticsService(f.project, { appVersion: '0.1.0' }).handle(req);
  assert.ok(isDiagnosticExportResult(response.result)); assert.equal(fs.readFileSync(response.result.destination, 'utf8'), report.text);
  assert.equal(sha(fs.readFileSync(response.result.destination)), report.bundleSha256); assert.equal(report.text.includes('PRIVATE_LATER_EVENT'), false);
  assert.deepEqual(fs.readFileSync(join(f.root, 'RangeSensor/RangeSensor.ino')), source); assert.deepEqual(f.project.devices.status(), []);
  const duplicate = new DiagnosticsService(f.project, { appVersion: '0.1.0' }).handle(req); assert.deepEqual(duplicate.result, response.result);
});

test('diagnostic boundary rejects private inclusion, arbitrary artifact handles, malformed requests, wrong project and stale review before writing', t => {
  const f = fixture(t), report = f.preview(), req = f.exportRequest(report);
  assert.equal(isProjectRequest({ ...f.request('diagnostics.preview'), params: { includeSource: true } }), false);
  assert.equal(isProjectRequest({ ...req, expectedProjectRevision: undefined }), false);
  assert.equal(isProjectRequest({ ...req, params: { ...req.params, artifactId: randomUUID() } }), false);
  assert.equal(isProjectRequest({ ...req, params: { ...req.params, destination: 'x'.repeat(32769) } }), false);
  assert.throws(() => f.service.handle({ ...f.request('diagnostics.preview'), params: { rawSerial: true } }), { code: 'INVALID_REQUEST' });
  assert.equal(f.service.handle({ ...req, projectId: randomUUID() }).error?.code, 'UNAUTHORIZED_SCOPE');
  assert.equal(f.service.handle({ ...req, requestId: randomUUID(), params: { ...req.params, expectedBundleSha256: '0'.repeat(64) } }).error?.code, 'REVISION_CONFLICT');
  fs.writeFileSync(join(f.root, 'workbench.json'), JSON.stringify({ ...f.manifest, projectRevision: 2 }));
  assert.equal(f.service.handle(req).error?.code, 'REVISION_CONFLICT'); assert.equal(fs.existsSync(String(req.params.destination)), false);
  const changedPreview = { ...report, text: report.text.replace('default-private', 'include-everything') }; assert.equal(isDiagnosticPreview(changedPreview), false);
  const extraPrivateBody = { ...JSON.parse(report.text), source: 'PRIVATE_SOURCE' }; assert.equal(isDiagnosticBundle(extraPrivateBody), false);
});

test('diagnostic publication preserves existing files, rejects source/data/linked destinations and binds the exact preview kind and media', t => {
  const f = fixture(t), report = f.preview();
  const existing = join(f.directory, 'retained.json'); fs.writeFileSync(existing, 'unrelated user bytes');
  assert.equal(f.service.handle(f.exportRequest(report, existing)).error?.code, 'REVISION_CONFLICT'); assert.equal(fs.readFileSync(existing, 'utf8'), 'unrelated user bytes');
  for (const destination of [join(f.root, 'diagnostics.json'), join(f.project.store.dataRoot, 'diagnostics.json'), 'relative.json', '\\\\server\\share\\diagnostics.json']) assert.equal(f.service.handle(f.exportRequest(report, destination)).error?.code, 'UNAUTHORIZED_SCOPE');
  const link = join(f.directory, 'linked-project'); fs.symlinkSync(f.root, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(f.service.handle(f.exportRequest(report, join(link, 'diagnostics.json'))).error?.code, 'UNAUTHORIZED_SCOPE');
  const old = f.project.store.getRecord<Record<string, unknown>>('observations', report.previewId, f.project.projectId), privateArtifact = f.project.store.storeArtifact(f.project.projectId, Buffer.from('PRIVATE_DOCUMENT_CANARY'), 'text/plain');
  const fakeId = randomUUID(); f.project.store.putRecord('observations', fakeId, f.project.projectId, { ...old, previewId: fakeId, artifactId: privateArtifact.artifactId, bundleSha256: privateArtifact.sha256, byteLength: privateArtifact.sizeBytes });
  assert.equal(f.service.handle(f.request('diagnostics.export', { previewId: fakeId, expectedBundleSha256: privateArtifact.sha256, destination: join(f.directory, 'forged.json') })).error?.code, 'ARTIFACT_MISMATCH');
  const poisoned = f.project.store.storeArtifact(f.project.projectId, Buffer.from(JSON.stringify({ ...JSON.parse(report.text), providerTranscript: 'PRIVATE_PROVIDER_CANARY' })), DIAGNOSTIC_MEDIA_TYPE), poisonedId = randomUUID();
  f.project.store.putRecord('observations', poisonedId, f.project.projectId, { ...old, previewId: poisonedId, artifactId: poisoned.artifactId, bundleSha256: poisoned.sha256, byteLength: poisoned.sizeBytes });
  assert.equal(f.service.handle(f.request('diagnostics.export', { previewId: poisonedId, expectedBundleSha256: poisoned.sha256, destination: join(f.directory, 'poisoned.json') })).error?.code, 'INVALID_REQUEST');
  assert.equal(fs.existsSync(join(f.directory, 'forged.json')), false); assert.equal(fs.existsSync(join(f.directory, 'poisoned.json')), false);
});

test('disk-full diagnostic write preserves source and existing evidence, cleans only owned staging, and leaks no raw failure path', t => {
  const f = fixture(t), report = f.preview(), req = f.exportRequest(report), original = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', ((file: Parameters<typeof original>[0], data: Parameters<typeof original>[1], options?: Parameters<typeof original>[2]) => {
    if (typeof file === 'number') { original(file, 'partial diagnostic staging'); throw Object.assign(new Error('PRIVATE_PATH C:/Users/ExamplePrivateFixture/secret ENOSPC'), { code: 'ENOSPC' }); }
    return original(file, data, options);
  }) as typeof original);
  const response = f.service.handle(req); assert.equal(response.error?.code, 'DIAGNOSTIC_UNAVAILABLE'); assert.equal(JSON.stringify(response).includes('PRIVATE_PATH'), false);
  assert.equal(fs.existsSync(String(req.params.destination)), false); assert.equal(fs.readdirSync(f.directory).some(name => name.startsWith('.workbench-diagnostics-')), false);
  t.mock.restoreAll();
  assert.ok(isDiagnosticPreview(new DiagnosticsService(f.project, { appVersion: '0.1.0' }).handle(f.request('diagnostics.preview')).result));
  assert.equal(f.project.store.readArtifact(f.project.projectId, f.project.store.getRecord<{ artifactId: string }>('observations', report.previewId, f.project.projectId).artifactId).toString(), report.text);
});

test('published diagnostic with lost result remains uncertain and the same request is never replayed', t => {
  const f = fixture(t), report = f.preview(), req = f.exportRequest(report), put = f.project.store.putRecord.bind(f.project.store);
  t.mock.method(f.project.store, 'putRecord', (table: Parameters<typeof put>[0], id: string, projectId: string, body: unknown) => { if ((body as { kind?: string }).kind === 'diagnostic-export') throw Error('synthetic result persistence failure'); return put(table, id, projectId, body); });
  assert.equal(f.service.handle(req).error?.code, 'OUTCOME_UNKNOWN'); assert.equal(fs.readFileSync(String(req.params.destination), 'utf8'), report.text);
  fs.writeFileSync(String(req.params.destination), 'later user bytes');
  assert.equal(f.service.handle(req).error?.code, 'OUTCOME_UNKNOWN'); assert.equal(fs.readFileSync(String(req.params.destination), 'utf8'), 'later user bytes');
});

test('bounded diagnostics report historical versions and unknown free space without guessing values', t => {
  const f = fixture(t), timestamp = new Date().toISOString();
  t.mock.method(f.project.store, 'listOperations', () => Array.from({ length: 105 }, (): OperationReceipt => ({ schemaVersion: 1, operationId: randomUUID(), requestId: randomUUID(), projectId: f.project.projectId, kind: 'compile', status: 'succeeded', expectedProjectRevision: 1, createdAt: timestamp, finishedAt: timestamp, tool: { name: 'private-user-tool', version: 'unknown PRIVATE_VERSION' }, artifacts: [] })));
  t.mock.method(fs, 'statfsSync', () => { throw Error('synthetic unsupported free-space probe'); });
  const report = f.preview(), bundle = JSON.parse(report.text) as DiagnosticBundleV1;
  assert.equal(bundle.operations.length, 100); assert.equal(bundle.omitted.operations, 5); assert.equal(bundle.storage.freeBytes, null);
  assert.ok(bundle.tools.every(tool => tool.version === null && tool.basis === 'not-recorded')); assert.equal(report.text.includes('PRIVATE_VERSION'), false); assert.ok(report.byteLength <= DIAGNOSTIC_BUNDLE_BYTES);
});
