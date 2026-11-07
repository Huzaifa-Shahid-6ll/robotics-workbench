const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const esbuild = require('esbuild');
fs.mkdirSync(path.resolve('artifacts/tmp'), { recursive: true }); process.env.TEMP = process.env.TMP = path.resolve('artifacts/tmp');
esbuild.buildSync({ entryPoints: ['apps/extension/src/engineering-controller.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node24', outfile: 'artifacts/task10-controller-under-audit.cjs', external: ['vscode'] });
esbuild.buildSync({ entryPoints: ['packages/test-fixtures/ui/engineering-state.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node24', outfile: 'artifacts/task10-controller-fixture.cjs' });
const fixture = require(path.resolve('artifacts/task10-controller-fixture.cjs')).engineeringViewFixture();
const root = fs.mkdtempSync(path.resolve('artifacts/task10-controller-audit-'));
const files = ['workbench.json', 'mechanical/assets.json', 'mechanical/bracket.py', 'mechanical/parameters.json', 'mechanical/environment.json'];
for (const name of files) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), 'preserved source'); }
const artifactPath = path.join(root, 'retained.step'), destination = path.join(root, 'reviewed.step');
fs.writeFileSync(artifactPath, 'exact retained STEP bytes');
const artifactSha256 = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');
let afterReview = false;
const disposable = () => ({ dispose() {} });
const vscode = { workspace: { isTrusted: true, textDocuments: [], onDidSaveTextDocument: disposable, createFileSystemWatcher: () => ({ dispose() {}, onDidChange: disposable, onDidCreate: disposable, onDidDelete: disposable }) }, Uri: { file: file => ({ scheme: 'file', fsPath: path.resolve(file) }) }, RelativePattern: class {}, window: { showInformationMessage: async () => 'Export exact artifact', showSaveDialog: async () => { afterReview = true; return { scheme: 'file', fsPath: destination }; } } };
const originalLoad = Module._load;
Module._load = function(name, ...args) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
const { EngineeringController } = require(path.resolve('artifacts/task10-controller-under-audit.cjs'));
Module._load = originalLoad;
let failCad = true, failKicad = false, exportCalls = 0, delayedSnapshot, delayedKicad;
const manifest = JSON.parse(fs.readFileSync('examples/workbench.valid.json', 'utf8')); Object.assign(manifest, fixture.project);
const controller = new EngineeringController({}, { project: async () => ({ root, manifest }), request: async (_bound, method) => {
  if (method === 'project.snapshot') { if (delayedSnapshot) await delayedSnapshot; return { manifest }; }
  if (method === 'kicad.snapshot') { const refused = failKicad; if (delayedKicad) await delayedKicad; if (refused) throw Error('Synthetic KiCad read unavailable'); return structuredClone(fixture.schematic); }
  if (method === 'cad.snapshot') { if (failCad) throw Error('CAD_MANIFEST_INVALID: Repair mechanical/assets.json'); return structuredClone(fixture.cad); }
  if (method === 'cad.export') { exportCalls++; if (afterReview) throw Error('CAD_EXPORT_BLOCKED: source changed during review'); return { path: artifactPath, sha256: artifactSha256, unit: 'mm', productionAllowed: true, mediaType: 'model/step' }; }
  throw Error(`Unexpected method ${method}`);
}, wait: async (_, receipt) => receipt });
(async () => {
  try {
    await controller.refresh(); let state = controller.getState(); assert.equal(state.project.projectId, fixture.project.projectId); assert.ok(state.schematic); assert.equal(state.cad, null); assert.match(state.error, /CAD inspection unavailable/);
    failCad = false; failKicad = true; await controller.refresh(); state = controller.getState(); assert.equal(state.cad.assets[0].assetId, fixture.cad.assets[0].assetId); assert.equal(state.schematic.readiness.available, false); assert.equal(state.schematic.generations[0].stale, true);
    failKicad = false; await controller.refresh(); assert.equal(controller.getState().error, null, 'Recovered inspection must remove an obsolete read failure.');
    let releaseKicad; failKicad = true; delayedKicad = new Promise(resolve => { releaseKicad = resolve; });
    const staleInspection = controller.refresh(); await new Promise(setImmediate); failKicad = false;
    const explicitRefresh = controller.handle({ schemaVersion: 1, requestId: crypto.randomUUID(), projectId: fixture.project.projectId, type: 'refresh', payload: {} });
    releaseKicad(); await Promise.all([staleInspection, explicitRefresh]); delayedKicad = undefined;
    assert.equal(controller.getState().error, null, 'A failed watcher read racing with explicit refresh cannot restore an obsolete inspection error.');
    let releaseReady, refreshCompleted = false; failKicad = true; delayedKicad = new Promise(resolve => { releaseReady = resolve; });
    const pendingReady = controller.handle({ schemaVersion: 1, requestId: crypto.randomUUID(), projectId: fixture.project.projectId, type: 'ready', payload: {} });
    await new Promise(setImmediate); failKicad = false;
    const busyRefresh = controller.handle({ schemaVersion: 1, requestId: crypto.randomUUID(), projectId: fixture.project.projectId, type: 'refresh', payload: {} }).then(() => { refreshCompleted = true; });
    await new Promise(setImmediate); assert.equal(refreshCompleted, false, 'An explicit Refresh during the pending Ready handler must await a fresh inspection instead of silently returning.');
    releaseReady(); await Promise.all([pendingReady, busyRefresh]); delayedKicad = undefined;
    assert.equal(controller.getState().error, null, 'The refresh queued during Ready must replace its old KiCad error with a recovered snapshot.');
    let confirmExport; const exportApproval = new Promise(resolve => { confirmExport = resolve; }); vscode.window.showInformationMessage = async () => exportApproval;
    const exportRequest = () => ({ schemaVersion: 1, requestId: crypto.randomUUID(), projectId: fixture.project.projectId, type: 'exportCad', payload: { assetId: fixture.cad.assets[0].assetId, operationId: fixture.cad.assets[0].lastGood.operationId, format: 'step' } });
    const pendingExport = controller.handle(exportRequest()); await new Promise(setImmediate); assert.equal(exportCalls, 1);
    await controller.handle({ schemaVersion: 1, requestId: crypto.randomUUID(), projectId: fixture.project.projectId, type: 'refresh', payload: {} });
    assert.equal(controller.getState().loading, true, 'A read-only refresh must not clear the active mutation state.');
    await controller.handle(exportRequest()); assert.equal(exportCalls, 1, 'Read-only refresh must not release the single mutation owner.');
    confirmExport('Export exact artifact'); await pendingExport;
    assert.equal(exportCalls, 2); assert.equal(fs.existsSync(destination), false); assert.match(controller.getState().error, /source changed during review/); assert.equal(fs.readFileSync(artifactPath, 'utf8'), 'exact retained STEP bytes');
    await controller.refresh(); assert.match(controller.getState().error, /source changed during review/, 'Automatic inspection keeps a relevant action failure.');
    await controller.handle({ schemaVersion: 1, requestId: crypto.randomUUID(), projectId: fixture.project.projectId, type: 'refresh', payload: {} }); assert.equal(controller.getState().error, null, 'Explicit refresh clears the acknowledged action error once inspections succeed.');
    let release, secondCompleted = false; delayedSnapshot = new Promise(resolve => { release = resolve; });
    const firstRefresh = controller.refresh(), secondRefresh = controller.refresh().then(() => { secondCompleted = true; });
    await new Promise(setImmediate); assert.equal(secondCompleted, false, 'An awaited refresh must wait for an existing in-flight snapshot.'); release(); await Promise.all([firstRefresh, secondRefresh]); assert.equal(secondCompleted, true);
    const result = { taskId: 'TASK-10', status: 'passed', evidenceClass: 'deterministic-host-boundary-with-mocked-vscode-and-service', command: 'node scripts/engineering/controller-audit.cjs', checks: ['First-open CAD inspection failure preserves project and independent KiCad snapshot', 'KiCad inspection failure preserves CAD and marks retained schematic stale', 'Recovered reads clear obsolete inspection errors, including an in-flight watcher failure racing with explicit refresh', 'Explicit Refresh during a pending Ready handler waits and replaces its stale failed inspection', 'Read-only refresh during export preserves loading state and cannot admit a second mutation', 'Automatic refresh preserves action failures until explicit user refresh', 'CAD source change during native export review causes second preflight refusal, no destination write, retained bytes preserved', 'Concurrent awaited refresh waits for the existing snapshot and coalesced follow-up read'], controllerSha256: crypto.createHash('sha256').update(fs.readFileSync('apps/extension/src/engineering-controller.ts')).digest('hex'), limitations: ['VS Code APIs and service replies are mocked here; actual native-host helper remains separate.'] };
    const evidence = process.env.WORKBENCH_CONTROLLER_AUDIT_EVIDENCE_ROOT || 'verification/evidence/task-10/ui'; fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, 'controller-audit.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } finally { controller.dispose(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
