const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const esbuild = require('esbuild');
const evidence = path.resolve(process.env.WORKBENCH_READINESS_AUDIT_EVIDENCE_ROOT || 'verification/evidence/task-11/ui/controller-readiness');
fs.mkdirSync(evidence, { recursive: true });
const root = fs.mkdtempSync(path.resolve('artifacts/task11-controller-readiness-'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(setImmediate);
const disposable = () => ({ dispose() {} });
const documents = new Map();
const uri = file => ({ scheme: 'file', fsPath: path.resolve(file), toString() { return this.fsPath; } });
const vscode = { workspace: { isTrusted: true, textDocuments: [], async openTextDocument(value) {
  if (!documents.has(value.fsPath)) {
    let text = fs.readFileSync(value.fsPath, 'utf8');
    const doc = { uri: value, version: 1, isDirty: false, eol: 1, getText: () => text, positionAt: offset => ({ offset }), setText(next) { text = next; this.version++; this.isDirty = true; }, async save() { fs.writeFileSync(value.fsPath, text); this.isDirty = false; return true; } };
    documents.set(value.fsPath, doc); vscode.workspace.textDocuments.push(doc);
  }
  return documents.get(value.fsPath);
} }, Uri: { file: uri }, Range: class { constructor(start, end) { this.start = start; this.end = end; } }, EndOfLine: { CRLF: 2 }, window: { registerWebviewViewProvider: disposable, onDidChangeTextEditorSelection: disposable, async showTextDocument(document) { return { edit: async callback => { callback({ replace(range, replacement) { const before = document.getText(); document.setText(before.slice(0, range.start.offset) + replacement + before.slice(range.end.offset)); } }); return true; } }; } } };
function load(source) {
  const output = path.join(root, path.basename(source).replace(/\.ts$/, '.cjs'));
  esbuild.buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', target: 'node24', outfile: output, external: ['vscode'] });
  const original = Module._load;
  Module._load = function(name, ...args) { return name === 'vscode' ? vscode : original.call(this, name, ...args); };
  try { return require(output); } finally { Module._load = original; }
}
const { WiringController } = load('apps/extension/src/wiring-controller.ts');
const { DocumentController } = load('apps/extension/src/document-controller.ts');
const { TelemetryController } = load('apps/extension/src/telemetry-controller.ts');
const { AgentController } = load('apps/extension/src/agent-controller.ts');
const { ProjectService } = load('apps/companion/src/project-service.ts');
const { WiringService } = load('apps/companion/src/wiring-service.ts');
const { ReviewService } = load('apps/companion/src/review-service.ts');
const documentFixture = load('packages/test-fixtures/ui/documents-state.ts').documentViewFixture();
const telemetryFixture = load('packages/test-fixtures/ui/telemetry-state.ts').telemetryViewFixture();
const results = [];
async function check(name, body) { try { await body(); results.push({ name, result: 'passed' }); } catch (error) { results.push({ name, result: 'failed', error: error.stack }); console.error(name, error); } }
const intent = (controller, projectId, type, payload = {}) => controller.handle({ schemaVersion: 1, requestId: crypto.randomUUID(), projectId, type, payload });
(async () => {
  await check('Wiring commit waits for a precommit Ready read and publishes the accepted saved revision', async () => {
    const projectRoot = path.join(root, 'project'); fs.mkdirSync(projectRoot);
    const manifest = JSON.parse(fs.readFileSync('examples/workbench.valid.json', 'utf8'));
    const file = path.join(projectRoot, 'workbench.json'); fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
    const project = new ProjectService(projectRoot, path.join(root, 'data')), wiring = new WiringService(project), reviews = new ReviewService(project);
    let hold, entered;
    const controller = new WiringController({}, { project: async () => ({ root: projectRoot, manifest: structuredClone(manifest) }), request: async (_bound, method, params = {}, revision) => {
      const request = { schemaVersion: 1, requestId: crypto.randomUUID(), projectId: manifest.projectId, method, params, ...(revision === undefined ? {} : { expectedProjectRevision: revision }) };
      const response = (method.startsWith('review.') ? reviews : wiring).handle(request);
      if (response.error) throw Error(JSON.stringify(response.error));
      if (method === 'wiring.snapshot' && hold) { const gate = hold; hold = undefined; entered.resolve(); await gate.promise; }
      return structuredClone(response.result);
    }, ask() {} });
    try {
      await controller.refresh();
      const componentId = crypto.randomUUID();
      await intent(controller, manifest.projectId, 'propose', { operations: [{ type: 'component.add', component: { componentId, label: 'Synthetic unresolved component', definition: null, identityStatus: 'unresolved' } }] });
      assert.ok(controller.getState().preview, controller.getState().error);
      hold = deferred(); const release = hold; entered = deferred();
      const ready = intent(controller, manifest.projectId, 'ready'); await entered.promise;
      let completed = false;
      const commit = intent(controller, manifest.projectId, 'commit', { previewId: controller.getState().preview.previewId }).then(() => { completed = true; });
      for (let i = 0; i < 20 && JSON.parse(fs.readFileSync(file, 'utf8')).projectRevision === 1; i++) await tick();
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).projectRevision, 2, 'Actual native-adapter file save must complete under the real WiringService CAS.');
      await tick(); const returnedBeforeRead = completed;
      release.resolve(); await Promise.all([ready, commit]);
      assert.equal(returnedBeforeRead, false, 'Commit completion cannot be acknowledged while its final refresh skipped a precommit Ready snapshot.');
      assert.equal(controller.getState().project.projectRevision, 2);
      assert.equal(controller.getState().preview, null);
      assert.equal(project.store.listRecords('sessions', manifest.projectId).filter(r => r.kind === 'wiring-commit').length, 1);
      assert.equal(project.store.listOperations(manifest.projectId).length, 0);
    } finally { controller.dispose(); project.close(); }
  });
  await check('Document Ready cannot silently swallow a Search intent and concurrent actions retain one owner', async () => {
    const fixture = documentFixture, manifest = { ...JSON.parse(fs.readFileSync('examples/workbench.valid.json', 'utf8')), ...fixture.project };
    let hold, entered, queries = 0, queryHold;
    const controller = new DocumentController({}, { project: async () => ({ root, manifest }), request: async (_, method) => {
      if (method === 'project.snapshot') { if (hold) { const gate = hold; hold = undefined; entered.resolve(); await gate.promise; } return { manifest }; }
      if (method === 'document.list') return structuredClone(fixture.documents);
      if (method === 'document.query') { queries++; if (queryHold) await queryHold.promise; return { excerpts: [], omitted: 0 }; }
      throw Error(`Unexpected ${method}`);
    }, ask() {}, wait: async (_, receipt) => receipt });
    try {
      await controller.refresh(); hold = deferred(); const release = hold; entered = deferred();
      const ready = intent(controller, manifest.projectId, 'ready'); await entered.promise;
      const search = intent(controller, manifest.projectId, 'search', { query: 'retained source' });
      await tick(); release.resolve(); await Promise.all([ready, search]);
      assert.equal(queries, 1, 'Search received during read-only Ready must execute once.');
      queryHold = deferred(); const pending = intent(controller, manifest.projectId, 'search', { query: 'first pending' }); await tick();
      await intent(controller, manifest.projectId, 'search', { query: 'second pending' });
      assert.equal(queries, 2, 'Concurrent second action cannot acquire the first action owner.');
      queryHold.resolve(); await pending;
    } finally { controller.dispose(); }
  });
  await check('Telemetry Ready/polling cannot reject a Compare intent; refreshed evidence is awaited', async () => {
    const fixture = telemetryFixture, manifest = { ...JSON.parse(fs.readFileSync('examples/workbench.valid.json', 'utf8')), ...fixture.project };
    let hold, entered, comparisons = 0;
    const controller = new TelemetryController({}, { project: async () => ({ root, manifest }), request: async (_, method) => {
      if (method === 'telemetry.snapshot') { const snapshot = structuredClone({ project: fixture.project, recordings: fixture.recordings, profiles: fixture.profiles, procedures: fixture.procedures, runs: fixture.runs }); if (hold) { const gate = hold; hold = undefined; entered.resolve(); await gate.promise; } return snapshot; }
      if (method === 'experiment.compare') { comparisons++; return structuredClone(fixture.comparison); }
      throw Error(`Unexpected ${method}`);
    }, ask() {}, wait: async (_, receipt) => receipt });
    try {
      await controller.refresh(); hold = deferred(); const release = hold; entered = deferred();
      const ready = intent(controller, manifest.projectId, 'ready'); await entered.promise;
      const compare = intent(controller, manifest.projectId, 'compare', { experimentIds: fixture.runs.map(r => r.experimentId) });
      await tick(); release.resolve(); await Promise.all([ready, compare]);
      assert.equal(comparisons, 1, 'Compare intent during Ready must execute once.');
      assert.equal(controller.getState().error, null);
    } finally { controller.dispose(); }
  });
  await check('Agent awaited Refresh cannot return with an older Ready snapshot after source changes', async () => {
    const manifest = JSON.parse(fs.readFileSync('examples/workbench.valid.json', 'utf8'));
    let hold, entered;
    const controller = new AgentController({ workspaceState: { get: (_, fallback) => fallback } }, { project: async () => ({ root, manifest: structuredClone(manifest) }), request: async (_, method) => {
      if (method === 'project.snapshot') { const snapshot = { manifest: structuredClone(manifest) }; if (hold) { const gate = hold; hold = undefined; entered.resolve(); await gate.promise; } return snapshot; }
      if (method === 'agent.list') return [];
      throw Error(`Unexpected ${method}`);
    } });
    try {
      await controller.refresh(); hold = deferred(); const release = hold; entered = deferred();
      const ready = intent(controller, manifest.projectId, 'ready'); await entered.promise;
      manifest.projectRevision = 2; let completed = false;
      const refresh = intent(controller, manifest.projectId, 'refresh').then(() => { completed = true; });
      await tick(); const completedBeforeRead = completed;
      release.resolve(); await Promise.all([ready, refresh]);
      assert.equal(completedBeforeRead, false, 'Awaited Refresh cannot return before the held read and fresh follow-up finish.');
      assert.equal(controller.getState().project.projectRevision, 2);
    } finally { controller.dispose(); }
  });
  await check('Agent clears a recovered read timeout without hiding an action failure', async () => {
    const manifest = JSON.parse(fs.readFileSync('examples/workbench.valid.json', 'utf8'));
    let failRead = true;
    const controller = new AgentController({ workspaceState: { get: (_, fallback) => fallback } }, { project: async () => ({ root, manifest }), request: async (_, method) => {
      if (method === 'project.snapshot') { if (failRead) throw Error('TIMEOUT: synthetic snapshot timeout'); return { manifest }; }
      if (method === 'agent.list') return [];
      throw Error(`Unexpected ${method}`);
    } });
    try {
      await controller.refresh(); assert.match(controller.getState().error, /TIMEOUT/);
      failRead = false; await intent(controller, manifest.projectId, 'refresh');
      assert.equal(controller.getState().error, null, 'A successful refresh must clear its resolved read timeout.');
      assert.equal(controller.getState().task, null); assert.deepEqual(controller.getState().operations, []);
      await intent(controller, manifest.projectId, 'pin', { id: 'not-a-uuid', pinned: true });
      const actionError = controller.getState().error; assert.match(actionError, /cannot be pinned/);
      await controller.refresh(); assert.equal(controller.getState().error, actionError);
      failRead = true; await controller.refresh(); assert.equal(controller.getState().error, actionError);
      failRead = false; await intent(controller, manifest.projectId, 'refresh');
      assert.equal(controller.getState().error, null); assert.equal(controller.getState().task, null);
      assert.deepEqual(controller.getState().operations, []);
    } finally { controller.dispose(); }
  });
  const output = { taskId: 'TASK-11', command: 'node scripts/ui/controller-readiness-audit.cjs', status: results.every(r => r.result === 'passed') ? 'passed' : 'failed', results, sourceHashes: Object.fromEntries(['wiring', 'document', 'telemetry', 'engineering', 'agent'].map(name => [name, hash(fs.readFileSync(`apps/extension/src/${name}-controller.ts`))])), fixtureRoot: root, evidenceClass: 'deterministic-mocked-vscode; Wiring uses real ProjectService/WiringService/ReviewService, SQLite and ordinary saved source', limitations: ['No actual native host, real hardware or provider was invoked. Document, Telemetry and Agent service snapshots are synthetic fixtures.'] };
  fs.writeFileSync(path.join(evidence, process.env.WORKBENCH_READINESS_AUDIT_NAME || 'result.json'), JSON.stringify(output, null, 2)); console.log(JSON.stringify(output)); if (output.status !== 'passed') process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
