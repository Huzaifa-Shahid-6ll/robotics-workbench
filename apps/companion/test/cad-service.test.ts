import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ProcessResult, ProcessSpec } from '@robotics-workbench/application';
import { isCadSnapshot, isProjectRequest, type CadSnapshot, type CadExport, type CadViewer, type OperationReceipt, type ProjectRequest, type ProjectResponse } from '@robotics-workbench/contracts';
import { CadService, type CadSourceSnapshot } from '../src/cad-service';
import { ProjectService } from '../src/project-service';

const assetId = '99999999-9999-4999-8999-999999999999';
const successfulProcess: ProcessResult = { exitCode: 0, signal: null, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false, logsTruncated: false, timedOut: false, cancelled: false, terminationObserved: true };
const report = { schemaVersion: 1, geometry: { valid: true, boundsMm: [20, 10, 3], volumeMm3: 600, stepReopened: true, stlReopened: true, stlUnit: 'mm' }, environment: { python: '3.11.9', packages: { cadquery: '2.8.0', 'cadquery-ocp': '7.9.3.1.1' } }, reproducible: true, issues: [] };
function result<T>(response: ProjectResponse): T { assert.equal(response.error, undefined, JSON.stringify(response.error)); return response.result as T; }
function fixture(t: TestContext, trusted = true) {
  const parent = resolve('artifacts/task10-temp'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'cad-unit-')), root = join(directory, 'project'), data = join(directory, 'data');
  mkdirSync(join(root, 'mechanical'), { recursive: true });
  const manifest = JSON.parse(readFileSync('examples/workbench.valid.json', 'utf8')); writeFileSync(join(root, 'workbench.json'), JSON.stringify(manifest));
  for (const filename of ['assets.json', 'box.py', 'box_dimensions.py', 'parameters.json']) copyFileSync(`packages/test-fixtures/cad/${filename}`, join(root, 'mechanical', filename));
  writeFileSync(join(root, 'mechanical/environment.lock.json'), JSON.stringify(report.environment));
  const project = new ProjectService(root, data), cad = new CadService(project, { pythonPath: process.execPath, trusted });
  let mode: 'good' | 'invalid' | 'empty' | 'timeout' | 'cancel' | 'dynamic' = 'good', calls = 0;
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  project.runner.run = async (spec: ProcessSpec) => {
    calls++; started();
    assert.equal(spec.executable, process.execPath); assert.equal(spec.args[0], '-I'); assert.equal(spec.maxLogBytes, 1024 * 1024);
    assert.equal(spec.env?.TEMP, spec.env?.TMP);
    const request = JSON.parse(readFileSync(spec.args[2], 'utf8'));
    assert.equal(readFileSync(join(request.snapshotRoot, 'mechanical/box_dimensions.py'), 'utf8'), readFileSync(join(root, 'mechanical/box_dimensions.py'), 'utf8'));
    if (mode === 'timeout') return { ...successfulProcess, exitCode: null, timedOut: true };
    if (mode === 'cancel') { await new Promise<void>(resolve => { if (spec.signal?.aborted) resolve(); else spec.signal?.addEventListener('abort', () => resolve(), { once: true }); }); return { ...successfulProcess, exitCode: null, cancelled: true }; }
    writeFileSync(join(request.outputDirectory, 'model.step'), mode === 'empty' ? '' : 'synthetic STEP bytes; unit fixture only');
    writeFileSync(join(request.outputDirectory, 'model.stl'), 'synthetic STL bytes; unit fixture only');
    writeFileSync(request.reportPath, JSON.stringify(mode === 'invalid' ? { error: { code: 'CAD_GEOMETRY_INVALID', message: 'Synthetic invalid geometry' } } : { ...report, reproducible: mode !== 'dynamic', issues: mode === 'dynamic' ? ['Synthetic dynamic dependency'] : [] }));
    return { ...successfulProcess, exitCode: mode === 'invalid' ? 1 : 0 };
  };
  t.after(async () => { await project.shutdown(); assert.equal(dirname(realpathSync(directory)), realpathSync(parent)); rmSync(directory, { recursive: true, force: true }); });
  const request = (method: ProjectRequest['method'], params: Record<string, unknown> = {}, revision?: number): ProjectRequest => ({ schemaVersion: 1, requestId: randomUUID(), projectId: project.projectId, method, params, ...(revision === undefined ? {} : { expectedProjectRevision: revision }) });
  const snapshot = async () => { const snapshot = result<CadSnapshot>(await cad.handle(request('cad.snapshot'))); assert.ok(isCadSnapshot(snapshot)); return snapshot; };
  const generateRequest = async (mode = 'production', assumptions?: Record<string, number>) => request('cad.generate', { assetId, expectedFingerprint: (await snapshot()).assets[0].currentFingerprint!, mode, ...(assumptions ? { assumptions } : {}) }, manifest.projectRevision);
  const generate = async () => { const admitted = result<OperationReceipt>(await cad.handle(await generateRequest())); return project.jobs.wait(admitted.operationId); };
  return { root, data, project, cad, request, snapshot, generateRequest, generate, running, get calls() { return calls; }, set mode(next: typeof mode) { mode = next; } };
}

test('CAD supervised generation retains immutable exact outputs and provenance; duplicate intent never reruns', async t => {
  const f = fixture(t), beforeScript = readFileSync(join(f.root, 'mechanical/box.py')), request = await f.generateRequest();
  assert.ok(isProjectRequest(request)); assert.equal(isProjectRequest({ ...request, params: { ...request.params, shell: 'arbitrary' } }), false);
  assert.equal(isProjectRequest({ ...request, expectedProjectRevision: undefined }), false);
  const admitted = result<OperationReceipt>(await f.cad.handle(request)); assert.equal(admitted.status, 'queued');
  const source = f.project.store.getRecord<CadSourceSnapshot>('source_snapshots', admitted.sourceSnapshotId!, f.project.projectId);
  assert.equal(source.kind, 'cad-source'); assert.equal(source.projectRevision, 1); assert.equal(source.sourceSnapshotId, admitted.sourceSnapshotId); assert.equal(source.fingerprint, admitted.result?.fingerprint);
  assert.deepEqual(source.files.map(file => file.path), ['mechanical/box.py', 'mechanical/box_dimensions.py', 'mechanical/environment.lock.json', 'mechanical/parameters.json']);
  assert.equal(source.sha256, f.project.files.snapshotSource({ paths: source.files.map(file => file.path), host: () => ({ dirtyPaths: [] }) }).sha256);
  for (const file of source.files) assert.deepEqual(f.project.store.readArtifact(f.project.projectId, file.artifactId), readFileSync(join(f.root, file.path)));
  const good = await f.project.jobs.wait(admitted.operationId); assert.equal(good.status, 'succeeded', JSON.stringify(good.error));
  assert.equal(f.calls, 1); assert.equal(good.artifacts.length, 3); assert.equal(good.result?.unit, 'mm');
  assert.deepEqual(readFileSync(join(f.root, 'mechanical/box.py')), beforeScript);
  const exported = result<CadExport>(await f.cad.handle(f.request('cad.export', { assetId, operationId: good.operationId, format: 'stl' })));
  assert.equal(exported.unit, 'mm'); assert.equal(exported.productionAllowed, true); assert.match(readFileSync(exported.path, 'utf8'), /synthetic STL/);
  const duplicate = result<OperationReceipt>(await f.cad.handle(request)); assert.equal(duplicate.operationId, good.operationId); assert.equal(duplicate.status, 'succeeded'); assert.equal(f.calls, 1);
  assert.equal((await f.cad.handle({ ...request, params: { ...request.params, mode: 'exploratory' } })).error?.code, 'REQUEST_ID_CONFLICT');
  const status = (await f.snapshot()).assets[0]; assert.equal(status.stale, false); assert.equal(status.lastGood?.operationId, good.operationId);
});

test('script, declared imported module, parameters, output settings and engine lock independently invalidate prior generation', async t => {
  const f = fixture(t), good = await f.generate(); assert.equal(good.status, 'succeeded');
  const original = (await f.snapshot()).assets[0].currentFingerprint;
  for (const [path, mutate] of [
    ['box.py', (s: string) => s + '\n# saved external edit\n'],
    ['box_dimensions.py', (s: string) => s + '\n# local module changed\n'],
    ['parameters.json', (s: string) => s.replace('"value": 20', '"value": 21')],
    ['assets.json', (s: string) => s.replace('"linearTolerance": 0.1', '"linearTolerance": 0.2')],
    ['environment.lock.json', (s: string) => s.replace('2.8.0', '2.8.1')]
  ] as const) {
    const full = join(f.root, 'mechanical', path), before = readFileSync(full, 'utf8'), changed = mutate(before); assert.notEqual(changed, before); writeFileSync(full, changed);
    const status = (await f.snapshot()).assets[0]; assert.notEqual(status.currentFingerprint, original); assert.equal(status.stale, true);
    assert.equal((await f.cad.handle(f.request('cad.export', { assetId, operationId: good.operationId, format: 'step' }))).error?.code, 'CAD_EXPORT_BLOCKED');
    assert.equal(status.lastGood?.operationId, good.operationId); assert.equal(readFileSync(full, 'utf8'), changed); writeFileSync(full, before);
  }
  assert.equal((await f.snapshot()).assets[0].stale, false);
});

test('accepted manifest revision marks unchanged CAD geometry stale and blocks production export while preserving historical viewer handoff', async t => {
  const f = fixture(t), good = await f.generate(), before = (await f.snapshot()).assets[0];
  assert.equal(good.status, 'succeeded'); assert.equal(before.stale, false);
  const path = join(f.root, 'workbench.json'), manifest = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...manifest, projectRevision: manifest.projectRevision + 1, name: 'Later accepted design intent' }));
  const after = await f.snapshot(); assert.equal(after.projectRevision, 2);
  assert.equal(after.assets[0].currentFingerprint, before.currentFingerprint); assert.equal(after.assets[0].stale, true);
  assert.equal(after.assets[0].lastGood?.expectedProjectRevision, 1); assert.equal(after.assets[0].lastGood?.operationId, good.operationId);
  assert.equal((await f.cad.handle(f.request('cad.export', { assetId, operationId: good.operationId, format: 'step' }))).error?.code, 'CAD_EXPORT_BLOCKED');
  const viewer = result<CadViewer>(await f.cad.handle(f.request('cad.viewer', { assetId, operationId: good.operationId })));
  assert.equal(viewer.status, 'handoff-required'); assert.match(viewer.script, /from ocp_vscode import show/);
  assert.equal(f.project.store.getOperation(f.project.projectId, good.operationId).status, 'succeeded');
});

test('unknown fit-critical parameter stays null; production refused, explicit exploratory assumptions retained separately', async t => {
  const f = fixture(t), path = join(f.root, 'mechanical/parameters.json');
  const parameters = JSON.parse(readFileSync(path, 'utf8')); parameters.width.value = null; parameters.width.basis = 'unknown'; writeFileSync(path, JSON.stringify(parameters));
  assert.equal((await f.snapshot()).assets[0].parameters.width.value, null);
  assert.equal((await f.cad.handle(await f.generateRequest())).error?.code, 'CAD_DIMENSION_UNKNOWN');
  assert.equal((await f.cad.handle(await f.generateRequest('exploratory'))).error?.code, 'CAD_DIMENSION_UNKNOWN');
  const request = await f.generateRequest('exploratory', { width: 20 }), admitted = result<OperationReceipt>(await f.cad.handle(request)), completed = await f.project.jobs.wait(admitted.operationId);
  assert.equal(completed.status, 'succeeded'); assert.deepEqual(completed.result?.assumptions, { width: 20 });
  assert.equal((completed.result?.originalParameters as typeof parameters).width.value, null);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).width.value, null);
  assert.equal((await f.cad.handle(f.request('cad.export', { assetId, operationId: completed.operationId, format: 'step' }))).error?.code, 'CAD_EXPORT_BLOCKED');
  const viewer = result<CadViewer>(await f.cad.handle(f.request('cad.viewer', { assetId, operationId: completed.operationId })));
  assert.equal(viewer.workflow, 'explicit-handoff'); assert.match(viewer.script, /from ocp_vscode import show/);
});

for (const [mode, error] of [['invalid', 'CAD_GEOMETRY_INVALID'], ['empty', 'CAD_OUTPUT_INVALID'], ['timeout', 'CAD_TIMEOUT']] as const) test(`${mode} generation retains last good bytes and marks them visibly stale`, async t => {
  const f = fixture(t), good = await f.generate(); assert.equal(good.status, 'succeeded');
  const exact = f.project.store.readArtifact(f.project.projectId, good.artifacts[0].artifactId);
  f.mode = mode; const failed = await f.generate(); assert.equal(failed.status, 'failed'); assert.equal(failed.error?.code, error); assert.equal(failed.artifacts.length, 0);
  const frozen = f.project.store.getRecord<CadSourceSnapshot>('source_snapshots', failed.sourceSnapshotId!, f.project.projectId);
  assert.equal(frozen.kind, 'cad-source'); assert.equal(frozen.fingerprint, good.result?.fingerprint); assert.equal(frozen.sourceSnapshotId, failed.sourceSnapshotId);
  assert.notEqual(frozen.sourceSnapshotId, good.sourceSnapshotId);
  const status = (await f.snapshot()).assets[0]; assert.equal(status.stale, true); assert.equal(status.lastGood?.operationId, good.operationId);
  assert.deepEqual(f.project.store.readArtifact(f.project.projectId, good.artifacts[0].artifactId), exact);
});

test('cancellation observes the owned process and retains the successful generation without promoting partial output', async t => {
  const f = fixture(t); const good = await f.generate(); f.mode = 'cancel';
  const admitted = result<OperationReceipt>(await f.cad.handle(await f.generateRequest()));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.project.store.getOperation(f.project.projectId, admitted.operationId).status, 'running');
  f.project.jobs.requestCancel(f.project.projectId, admitted.operationId);
  const cancelled = await f.project.jobs.wait(admitted.operationId); assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.artifacts.length, 0);
  const status = (await f.snapshot()).assets[0]; assert.equal(status.stale, true); assert.equal(status.lastGood?.operationId, good.operationId);
});

test('queued saved-source race refuses execution and preserves both current source and prior geometry', async t => {
  const f = fixture(t), good = await f.generate();
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  const receipt: OperationReceipt = { schemaVersion: 1, operationId: randomUUID(), requestId: randomUUID(), projectId: f.project.projectId, kind: 'document-ingest', status: 'queued', expectedProjectRevision: 1, createdAt: new Date().toISOString(), tool: { name: 'synthetic-blocker', version: '1' }, artifacts: [] };
  const blocker = f.project.jobs.submit({ receipt, payload: {}, heavy: true, execute: async () => { await blocked; } });
  try {
    const admitted = result<OperationReceipt>(await f.cad.handle(await f.generateRequest())), path = join(f.root, 'mechanical/box.py');
    const changed = readFileSync(path, 'utf8') + '\n# provider write retained\n'; writeFileSync(path, changed);
    release(); await f.project.jobs.wait(blocker.operationId); const rejected = await f.project.jobs.wait(admitted.operationId);
    assert.equal(rejected.status, 'failed'); assert.equal(rejected.error?.code, 'REVISION_CONFLICT'); assert.equal(f.calls, 1); assert.equal(readFileSync(path, 'utf8'), changed);
    const frozen = f.project.store.getRecord<CadSourceSnapshot>('source_snapshots', admitted.sourceSnapshotId!, f.project.projectId), source = frozen.files.find(file => file.path === 'mechanical/box.py')!;
    assert.notEqual(f.project.store.readArtifact(f.project.projectId, source.artifactId).toString('utf8'), changed);
    assert.equal((await f.snapshot()).assets[0].lastGood?.operationId, good.operationId);
  } finally { release(); }
});

test('viewer handoff edits and missing viewer do not corrupt valid geometry; untrusted workspace cannot run code', async t => {
  const f = fixture(t), good = await f.generate();
  const viewer = result<CadViewer>(await f.cad.handle(f.request('cad.viewer', { assetId, operationId: good.operationId })));
  writeFileSync(viewer.path, '# external handoff edit retained');
  assert.equal((await f.cad.handle(f.request('cad.viewer', { assetId, operationId: good.operationId }))).error?.code, 'REVISION_CONFLICT');
  assert.equal(readFileSync(viewer.path, 'utf8'), '# external handoff edit retained'); assert.equal((await f.snapshot()).assets[0].lastGood?.status, 'succeeded');
  const untrusted = new CadService(f.project, { pythonPath: process.execPath, trusted: false });
  assert.equal((await untrusted.handle(await f.generateRequest())).error?.code, 'WORKSPACE_UNTRUSTED');
  const missing = new CadService(f.project, { trusted: true });
  assert.equal((await missing.handle(await f.generateRequest())).error?.code, 'CAD_ENVIRONMENT_MISSING');
});

test('dynamic dependency disclosure blocks production export and path escapes are refused before execution', async t => {
  const f = fixture(t); f.mode = 'dynamic'; const good = await f.generate(); assert.equal(good.status, 'succeeded');
  assert.equal(good.result?.reproducible, false); assert.equal((await f.snapshot()).assets[0].stale, true);
  assert.equal((await f.cad.handle(f.request('cad.export', { assetId, operationId: good.operationId, format: 'step' }))).error?.code, 'CAD_EXPORT_BLOCKED');
  const path = join(f.root, 'mechanical/assets.json'), assets = JSON.parse(readFileSync(path, 'utf8')); assets.assets[0].scriptRelativePath = '../outside.py'; writeFileSync(path, JSON.stringify(assets));
  const status = (await f.snapshot()).assets[0]; assert.equal(status.currentFingerprint, null); assert.match(status.issues[0], /project-relative/); assert.equal(f.calls, 1);
});

test('CAD source credentials and unsupported provenance claims are excluded before process launch', async t => {
  const f = fixture(t), source = join(f.root, 'mechanical/box.py');
  writeFileSync(source, readFileSync(source, 'utf8') + '\n# Bearer syntheticcredentialmaterial12345\n');
  assert.equal((await f.cad.handle(await f.generateRequest())).error?.code, 'INVALID_REQUEST');
  assert.equal(f.calls, 0); assert.equal(f.project.store.listOperations(f.project.projectId).length, 0);
  const path = join(f.root, 'mechanical/parameters.json'), parameters = JSON.parse(readFileSync(path, 'utf8')); parameters.width.basis = 'measured'; writeFileSync(path, JSON.stringify(parameters));
  const snapshot = await f.snapshot(); assert.equal(snapshot.assets[0].currentFingerprint, null); assert.match(snapshot.assets[0].issues[0], /evidence files/);
  assert.equal(isCadSnapshot({ ...snapshot, projectRevision: 0 }), false);
});

test('malformed CAD manifest gives a source repair action and preserves the malformed file', async t => {
  const f = fixture(t), path = join(f.root, 'mechanical/assets.json'), malformed = '{ malformed saved CAD source';
  writeFileSync(path, malformed);
  const response = await f.cad.handle(f.request('cad.snapshot')); assert.equal(response.error?.code, 'CAD_MANIFEST_INVALID'); assert.match(response.error!.message, /mechanical\/assets.json/);
  assert.equal(readFileSync(path, 'utf8'), malformed); assert.equal(f.calls, 0);
});
