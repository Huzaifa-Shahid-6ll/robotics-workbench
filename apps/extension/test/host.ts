import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { resolve, join } from 'node:path';
import { CompanionClient } from '../src/companion-client';
import { SourcePolicy, manifestForSketch } from '../src/source-policy';
import { TaskReview, nativeReviewHost, type ReviewSnapshot } from '../src/task-review';
import { AgentController, type AgentControllerHost } from '../src/agent-controller';
import { WiringController } from '../src/wiring-controller';
import { checkDocumentHost } from './document-host';
import { checkLanguageService } from './language-host';
import { checkTelemetryHost } from './telemetry-host';
import { checkEngineeringHost } from './engineering-host';
import { checkRecoveryHost } from './recovery-host';
import { checkDiagnosticsHost } from './diagnostics-host';
import type { WorkbenchManifest, WiringViewRequest, ProjectMethod, WiringSnapshotData } from '@robotics-workbench/contracts';

export async function run(): Promise<void> {
  try { await runSuite(); }
  catch (error) {
    if (process.env.WORKBENCH_TEST_REPORT) await writeFile(process.env.WORKBENCH_TEST_REPORT, JSON.stringify({ passed: false, error: error instanceof Error ? error.stack : String(error) }));
    throw error;
  }
}

async function runSuite(): Promise<void> {
  const extension = vscode.extensions.getExtension('local-workbench.robotics-workbench');
  assert.ok(extension, 'Workbench must be installed/discovered by VS Code.');
  assert.equal(resolve(extension.extensionPath).toLowerCase(), resolve(process.env.WORKBENCH_TEST_EXTENSION_PATH!).toLowerCase());
  const api = await extension.activate();
  assert.equal(api.getCompanionPid(), undefined, 'Activation must be lazy.');
  assert.equal(api.getAgentState().task, null);
  const commands = await vscode.commands.getCommands();
  assert.ok(commands.includes('roboticsWorkbench.openProject'));
  assert.ok(commands.includes('roboticsWorkbench.checkTools'));
  for (const command of ['importSketch', 'selectBoard', 'compile', 'upload', 'openSerial', 'inspectContext', 'openAgent', 'openWiring', 'openComponents']) assert.ok(commands.includes('roboticsWorkbench.' + command));
  const restricted = process.env.WORKBENCH_TEST_RESTRICTED === '1';
  assert.equal(vscode.workspace.isTrusted, !restricted);
  if (restricted) {
    assert.deepEqual(await api.checkTools(), { error: 'WORKSPACE_UNTRUSTED' });
    assert.equal(api.getCompanionPid(), undefined);
    await writeFile(process.env.WORKBENCH_TEST_REPORT!, JSON.stringify({ passed: true, restricted, pid: null }));
    return;
  }
  const hello = await vscode.commands.executeCommand<{ state: string; pid: number; runtimeVersion: string }>('roboticsWorkbench.checkTools');
  assert.equal(hello?.state, 'ready');
  assert.equal(hello.pid, api.getCompanionPid());
  await api.stop();
  assert.throws(() => process.kill(hello.pid, 0), 'Explicit shutdown must observe process exit.');
  await vscode.commands.executeCommand('roboticsWorkbench.openAgent');
  assert.equal(api.getCompanionPid(), undefined, 'Opening an empty-project agent view cannot start a provider.');
  const temp = await mkdtemp(join(tmpdir(), 'workbench-installed-state-'));
  const projectRoot = join(temp, 'ordinary-project'); await mkdir(projectRoot);
  let nativeResult: unknown;
  if (extension.extensionPath.toLowerCase().includes('installed-extensions')) nativeResult = await installedNative(extension.extensionPath, temp);
  const ordinaryPath = join(projectRoot, 'Ordinary.ino'); await writeFile(ordinaryPath, 'void setup() {} void loop() {}');
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(ordinaryPath));
  const policy = new SourcePolicy(); policy.remember(document);
  const edit = new vscode.WorkspaceEdit(); edit.insert(document.uri, new vscode.Position(0, 0), '// user unsaved edit\\n');
  assert.equal(await vscode.workspace.applyEdit(edit), true); assert.equal(document.isDirty, true);
  const visible = document.getText(); await writeFile(ordinaryPath, '// provider disk edit');
  await assert.rejects(policy.save(projectRoot, [document], async () => true), { code: 'REVISION_CONFLICT' });
  assert.equal(document.getText(), visible); assert.equal(document.isDirty, true);
  assert.equal(manifestForSketch(projectRoot, projectRoot, 'arduino:avr:uno').sketches[0].path, '.');
  await vscode.window.showTextDocument(document); await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  const nativeReview = await checkNativeReview(projectRoot);
  const nativeRecovery = await checkRecoveryHost();
  const projectId = randomUUID(), targetId = randomUUID();
  await writeFile(join(projectRoot, 'workbench.json'), JSON.stringify({ schemaVersion: 1, projectId, projectRevision: 1,
    name: 'Installed persistence fixture', sketches: [{ path: 'Sketch', targetId }],
    targets: [{ targetId, fqbn: 'arduino:avr:uno', options: {} }], components: [], nets: [], codeBindings: [], documents: [], extensions: {} }));
  const bound = new CompanionClient(join(extension.extensionPath, 'dist/companion.js'), process.env.WORKBENCH_TEST_NODE_EXECUTABLE!, () => {}, () => {}, { projectRoot, dataRoot: join(temp, 'data') });
  let nativeWiring: unknown;
  let nativeDocuments: unknown;
  let nativeLanguage: unknown;
  let nativeTelemetry: unknown;
  let nativeEngineering: unknown;
  let nativeDiagnostics: unknown;
  try {
    const request = { schemaVersion: 1 as const, projectId, requestId: randomUUID(), method: 'project.snapshot' as const, params: {} };
    const snapshot = await bound.requestProject(request) as { manifest: { projectId: string }; epoch: string; snapshotSequence: number };
    assert.equal(snapshot.manifest.projectId, projectId);
    assert.match(snapshot.epoch, /^[a-f0-9-]{36}$/);
    assert.equal(snapshot.snapshotSequence, 0);
    nativeDiagnostics = await checkDiagnosticsHost(bound, projectRoot, temp, snapshot.manifest as WorkbenchManifest);
    const context = await bound.requestProject({ ...request, requestId: randomUUID(), method: 'project.context' }) as { text: string };
    assert.equal(JSON.parse(context.text).projectId, projectId);
    await assert.rejects(bound.requestProject({ ...request, requestId: randomUUID(), method: 'toolchain.inspect' }), /TOOL_UNAVAILABLE/);
    await assert.rejects(bound.requestProject({ ...request, requestId: randomUUID(), projectId: randomUUID() }), /UNAUTHORIZED_SCOPE/);
    nativeWiring = await checkWiringController(extension.extensionUri, bound, projectRoot);
    nativeDocuments = await checkDocumentHost(extension.extensionUri, bound, projectRoot);
    nativeLanguage = await checkLanguageService(extension.extensionUri, join(temp, 'language'));
    await writeFile(process.env.WORKBENCH_TEST_REPORT!.replace(/\.json$/, '-language.log'), await readFile(join(temp, 'language', 'language-server.log')));
  } finally { await bound.stop(); }
  try { nativeTelemetry = await checkTelemetryHost(extension.extensionUri, temp); nativeEngineering = await checkEngineeringHost(extension.extensionUri, temp); }
  finally { await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(error => { console.error('Fixture cleanup retained for inspection:', error); }); }
  api.agent.dispose();
  const controllerChecks = await checkController(extension.extensionUri);
  const restarted = await api.checkTools();
  assert.equal(restarted.state, 'ready');
  // Leave this child alive so the outer runner checks real host deactivation.
  await writeFile(process.env.WORKBENCH_TEST_REPORT!, JSON.stringify({ passed: true, restricted, pid: restarted.pid, runtimeVersion: restarted.runtimeVersion, vscodeVersion: vscode.version, nativeResult, nativeReview, nativeRecovery, controllerChecks, nativeWiring, nativeDocuments, nativeLanguage, nativeTelemetry, nativeEngineering, nativeDiagnostics }));
}

async function checkWiringController(extensionUri: vscode.Uri, client: CompanionClient, root: string): Promise<unknown> {
  const manifest = JSON.parse(await readFile(join(root, 'workbench.json'), 'utf8')) as WorkbenchManifest;
  let selected: unknown;
  const controller = new WiringController({ extensionUri } as vscode.ExtensionContext, { project: async () => ({ root, manifest }),
    request: async <T>(_bound: unknown, method: ProjectMethod, params: Record<string, unknown> = {}, revision?: number) => await client.requestProject({ schemaVersion: 1, requestId: randomUUID(), projectId: manifest.projectId, method, params, ...(revision === undefined ? {} : { expectedProjectRevision: revision }) }) as T,
    ask: value => { selected = value; } });
  const intent = async (type: WiringViewRequest['type'], payload: Record<string, unknown> = {}) => controller.handle({ schemaVersion: 1, requestId: randomUUID(), projectId: manifest.projectId, type, payload });
  const commit = async () => { const id = controller.getState().preview?.previewId; assert.ok(id, controller.getState().error ?? 'Preview missing'); await intent('commit', { previewId: id }); assert.equal(controller.getState().preview, null, controller.getState().error ?? 'Commit failed'); };
  const componentId = randomUUID(), manifestPath = join(root, 'workbench.json');
  let validFixtureBytes: string | undefined;
  try {
    await controller.show(); assert.equal(controller.getState().project?.projectRevision, 1);
    await intent('propose', { operations: [{ type: 'component.add', component: { componentId, label: 'Unresolved native fixture', definition: null, identityStatus: 'unresolved', provisionalPins: [{ pinId: 'signal', label: 'Signal (unverified)' }] } }] });
    assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).components.length, 0, 'Preview is read-only.');
    await commit(); assert.equal(controller.getState().project?.projectRevision, 2);
    assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).components[0].componentId, componentId);
    const unchangedBytes = await readFile(manifestPath, 'utf8');
    await intent('propose', { operations: [{ type: 'component.rename', componentId, label: 'Unresolved native fixture' }] }); await commit();
    assert.equal(await readFile(manifestPath, 'utf8'), unchangedBytes, 'Semantic no-op preserves exact formatting and revision.');
    await intent('select', { kind: 'component', id: componentId }); await intent('ask');
    assert.deepEqual(selected, { kind: 'component', id: componentId, revision: 2 }, 'Ask prepares exact revision context without a provider submission.');
    await intent('layout', { positions: { [componentId]: { x: 120, y: 80 } } });
    assert.equal(controller.getState().project?.projectRevision, 2);
    assert.deepEqual(controller.getState().layout.positions[componentId], { x: 120, y: 80 });
    const reportId = randomUUID(), before = controller.getState();
    await client.requestProject({ schemaVersion: 1, requestId: reportId, projectId: manifest.projectId, method: 'wiring.observe', expectedProjectRevision: 2, params: { subjectIds: [componentId], procedure: 'Synthetic software observation fixture; no board inspected.', note: 'Validates report immutability only.', result: 'inconclusive', observedAt: new Date().toISOString(), expectedManifestSha256: before.project!.manifestSha256 } });
    await controller.refresh(); assert.equal(controller.getState().confirmations[0]?.applicability, 'current');
    await intent('layout', { positions: { [componentId]: { x: 160, y: 90 } } });
    assert.equal(controller.getState().confirmations[0]?.applicability, 'current', 'Geometry does not invalidate revision-scoped evidence.');
    await intent('propose', { operations: [{ type: 'component.rename', componentId, label: 'Renamed stable ID' }] }); await commit();
    assert.equal(controller.getState().project?.projectRevision, 3); assert.equal(controller.getState().manifest!.components[0]!.componentId, componentId);
    assert.equal(controller.getState().confirmations[0]?.applicability, 'stale'); assert.equal(controller.getState().confirmations[0]?.projectRevision, 2);
    await intent('undo'); await commit();
    assert.equal(controller.getState().project?.projectRevision, 4); assert.equal(controller.getState().manifest!.components[0]!.label, 'Unresolved native fixture');
    await intent('propose', { operations: [{ type: 'component.rename', componentId, label: 'Must not overwrite' }] });
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(manifestPath)); await vscode.window.showTextDocument(doc);
    const edit = new vscode.WorkspaceEdit(); edit.insert(doc.uri, new vscode.Position(0, 0), ' '); assert.equal(await vscode.workspace.applyEdit(edit), true);
    const userText = doc.getText(), providerText = JSON.stringify({ ...controller.getState().manifest!, projectRevision: 5, name: 'Concurrent external provider' });
    await writeFile(manifestPath, providerText); await intent('commit', { previewId: controller.getState().preview!.previewId });
    assert.ok(controller.getState().error); assert.equal(doc.getText(), userText); assert.equal(await readFile(manifestPath, 'utf8'), providerText);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    validFixtureBytes = providerText;
    await writeFile(manifestPath, '{invalid external manifest'); await controller.refresh();
    assert.ok(controller.getState().error?.includes('read-only')); assert.equal(controller.getState().project?.projectRevision, 5);
    await intent('layout', { positions: { [componentId]: { x: 999, y: 999 } } });
    assert.equal(await readFile(manifestPath, 'utf8'), '{invalid external manifest');
    assert.equal(JSON.parse(await readFile(join(root, '.workbench-layout.json'), 'utf8')).positions[componentId].x, 160);
    return { productionPanel: true, previewSaveUndo: true, stableIdentity: true, layoutRevisionIndependent: true, reportedObservationBecomesStale: true, concurrentUserAndProviderPreserved: true, malformedManifestPreserved: true, physicalHardware: 'not-run' };
  } finally {
    controller.dispose();
    // Later native fixtures reuse this project; replace only this test's deliberate corruption.
    if (validFixtureBytes && await readFile(manifestPath, 'utf8') === '{invalid external manifest') await writeFile(manifestPath, validFixtureBytes);
  }
}

async function checkController(extensionUri: vscode.Uri): Promise<unknown> {
  const temp = await mkdtemp(join(tmpdir(), 'workbench-controller-')), root = join(temp, 'Probe'); await mkdir(root);
  const projectId = randomUUID(), targetId = randomUUID(), sourceSnapshotId = randomUUID(), first = randomUUID(), second = randomUUID();
  const manifest = { schemaVersion: 1 as const, projectId, projectRevision: 1, name: 'Synthetic controller', sketches: [{ path: '.', targetId }], targets: [{ targetId, fqbn: 'arduino:avr:uno', options: {} }], components: [], nets: [], codeBindings: [], documents: [], extensions: {} };
  await writeFile(join(root, 'workbench.json'), JSON.stringify(manifest)); await writeFile(join(root, 'Probe.ino'), 'void setup() {} void loop() {}');
  const memory = new Map<string, unknown>(), snapshots = new Map<string, unknown>(); let admitted: Record<string, unknown> | undefined, record: any;
  let ready!: () => void, release!: () => void;
  const preparing = new Promise<void>(resolve => { ready = resolve; }), saved = new Promise<void>(resolve => { release = resolve; });
  const host: AgentControllerHost = {
    project: async () => ({ root, manifest }), prepareSource: async () => { ready(); await saved; return sourceSnapshotId; }, authorizeUpload: async () => { throw Error('No hardware in synthetic controller check.'); },
    request: async <T>(_bound: unknown, method: string, params: Record<string, unknown> = {}): Promise<T> => {
      let result: unknown;
      if (method === 'project.snapshot') result = { manifest };
      else if (method === 'agent.list') result = record ? [{ task: record.task, updatedAt: new Date().toISOString(), lastProblem: null }] : [];
      else if (method === 'review.load') result = snapshots.get(String(params.taskId)) ?? null;
      else if (method === 'review.save') { snapshots.set(String(params.taskId), params.snapshot); result = {}; }
      else if (method === 'agent.start') {
        admitted = structuredClone(params);
        record = { task: { taskId: params.taskId, providerId: params.providerId, projectId, projectRevision: 1, sourceSnapshotId, operationIds: [], status: 'running' }, open: { model: { modelId: params.modelId } }, messages: [], pendingApprovals: [], events: [], packet: { packetId: randomUUID(), projectRevision: 1, evidenceRefs: [], omitted: [] }, providerOutcome: null, lastProblem: null, sourceCurrent: true }; result = record;
      } else if (method === 'agent.get') result = record;
      else throw Error(`Unexpected synthetic method ${method}`);
      return result as T;
    }
  };
  const context = { extensionUri, workspaceState: { get: (key: string, fallback: unknown) => memory.get(key) ?? fallback, update: async (key: string, value: unknown) => { memory.set(key, value); } } } as unknown as vscode.ExtensionContext;
  const controller = new AgentController(context, host);
  try {
    controller.selectEntity({ kind: 'component', id: first, revision: 1 }); await controller.refresh();
    const sending = controller.handle({ schemaVersion: 1, requestId: randomUUID(), projectId, type: 'send', payload: { providerId: 'codex', modelId: 'synthetic-model', permissionProfileId: 'read-only', userText: 'Explain the originally selected component.' } });
    await preparing; controller.selectEntity({ kind: 'component', id: second, revision: 1 });
    await assert.rejects(controller.handle({ schemaVersion: 1, requestId: randomUUID(), projectId, type: 'send', payload: { providerId: 'codex', modelId: 'synthetic-model', permissionProfileId: 'read-only', userText: 'Competing writer' } }), /still being admitted/);
    release(); await sending;
    assert.equal((admitted!.selection as { id: string }).id, first); assert.equal(controller.getState().task?.taskId, record.task.taskId);
    return { passed: true, selectionFrozenAcrossSaveDialog: true, duplicateWriterRejected: true, realProviderUsed: false };
  } finally { release(); controller.dispose(); await rm(temp, { recursive: true, force: true }); }
}

async function checkNativeReview(root: string): Promise<unknown> {
  const saved = new Map<string, ReviewSnapshot>(); let confirmations = 0;
  const review = new TaskReview({ load: async id => structuredClone(saved.get(id) ?? null), save: async (id, snapshot) => { saved.set(id, structuredClone(snapshot)); } }, nativeReviewHost(async input => { assert.ok(input.baselineSha256); assert.ok(input.observedSha256); confirmations++; return true; }));
  try {
    const path = join(root, 'Closed.ino'), baseline = 'int value = 1;\n', changed = 'int value = 2;\n';
    await writeFile(path, baseline); const taskId = randomUUID(); await review.capture(taskId, root, vscode.workspace.textDocuments);
    await writeFile(path, changed); const row = (await review.list(taskId, root, vscode.workspace.textDocuments)).find(item => item.path === 'Closed.ino')!;
    assert.equal(row.effect, 'written'); await review.act(taskId, root, row.id, 'diff', vscode.workspace.textDocuments);
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputTextDiff);
    const input = tabs.at(-1)?.input as vscode.TabInputTextDiff; assert.ok(input);
    assert.match(input.original.scheme, /^robotics-review-/); assert.equal((await vscode.workspace.openTextDocument(input.original)).getText(), baseline); assert.equal((await vscode.workspace.openTextDocument(input.modified)).getText(), changed);
    await review.act(taskId, root, row.id, 'revert', vscode.workspace.textDocuments); assert.equal(await readFile(path, 'utf8'), baseline); assert.equal(confirmations, 1);
    const dirtyPath = join(root, 'Dirty.ino'); await writeFile(dirtyPath, baseline);
    const dirtyDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(dirtyPath)), dirtyTask = randomUUID();
    await review.capture(dirtyTask, root, vscode.workspace.textDocuments);
    const edit = new vscode.WorkspaceEdit(); edit.insert(dirtyDocument.uri, new vscode.Position(0, 0), '// user unsaved\n'); await vscode.workspace.applyEdit(edit);
    const visible = dirtyDocument.getText(); await writeFile(dirtyPath, changed);
    const conflict = (await review.list(dirtyTask, root, vscode.workspace.textDocuments)).find(item => item.path === 'Dirty.ino')!;
    assert.equal(conflict.effect, 'conflicted'); await assert.rejects(review.act(dirtyTask, root, conflict.id, 'revert', vscode.workspace.textDocuments), { code: 'REVISION_CONFLICT' });
    await review.act(dirtyTask, root, conflict.id, 'diff', vscode.workspace.textDocuments);
    const conflictDiff = vscode.window.tabGroups.all.flatMap(group => group.tabs).map(tab => tab.input).find(input => input instanceof vscode.TabInputTextDiff && input.original.path.endsWith('/current-editor'));
    assert.ok(conflictDiff instanceof vscode.TabInputTextDiff);
    assert.match(conflictDiff.modified.path, /\/retained-observed$/);
    assert.equal((await vscode.workspace.openTextDocument(conflictDiff.original)).getText(), visible);
    assert.equal((await vscode.workspace.openTextDocument(conflictDiff.modified)).getText(), changed);
    assert.equal(dirtyDocument.getText(), visible); assert.equal(await readFile(dirtyPath, 'utf8'), changed);
    await vscode.window.showTextDocument(dirtyDocument); await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    return { passed: true, exactRetainedNativeDiff: true, exactNativeConflictDiff: true, confirmedNativeMinimalRevert: true, dirtyUserAndExternalVersionsPreserved: true, hardwareUsed: false };
  } finally { review.dispose(); }
}



async function installedNative(extensionPath: string, temporaryRoot: string): Promise<unknown> {
  const inventory = JSON.parse(await readFile(join(extensionPath, 'dist/native-runtime.json'), 'utf8')) as { target: string; files: { path: string; sha256: string; sizeBytes: number }[] };
  assert.equal(inventory.target, 'win32-x64');
  const binary = inventory.files.find(item => item.path === 'vendor/node_modules/@serialport/bindings-cpp/prebuilds/win32-x64/@serialport+bindings-cpp.node');
  assert.ok(binary, 'Installed VSIX must include the exact platform native binary.');
  const bytes = await readFile(join(extensionPath, 'dist', binary.path));
  assert.equal(bytes.length, binary.sizeBytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), binary.sha256);
  const sentinel = join(temporaryRoot, 'owned-not-a-serial-port.txt'); await writeFile(sentinel, 'native binding negative-path sentinel');
  const probe = String.raw`
    const assert = require('node:assert/strict');
    const { createRequire } = require('node:module');
    const { readFileSync, realpathSync } = require('node:fs');
    const { relative, isAbsolute, sep } = require('node:path');
    const [root, ordinaryFile] = process.argv.slice(1);
    const requireInstalled = createRequire(root + '/package.json');
    const binding = requireInstalled(root + '/@serialport/bindings-cpp').autoDetect();
    (async () => {
      let rejected = false;
      try { const port = await binding.open({path:ordinaryFile,baudRate:9600,dataBits:8,parity:'none',stopBits:1}); await port.close(); }
      catch { rejected = true; }
      assert.equal(rejected, true, 'Owned ordinary file cannot be a serial port');
      assert.equal(readFileSync(ordinaryFile,'utf8'),'native binding negative-path sentinel');
      for (const file of Object.keys(require.cache)) {
        const local = relative(realpathSync(root), realpathSync(file));
        assert.ok(!isAbsolute(local) && local !== '..' && !local.startsWith('..' + sep), 'Native dependency escaped installed VSIX vendor');
      }
      process.stdout.write(JSON.stringify({serialBindingLoaded:true,serialOrdinaryFileRejected:true,allRuntimeModulesInsideInstalledVsix:true,physicalDeviceAccessed:false,nodeVersion:process.version}));
    })().catch(error => {process.stderr.write(String(error));process.exitCode=1;});
  `;
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
  const result = await promisify(execFile)(process.env.WORKBENCH_TEST_NODE_EXECUTABLE!, ['-e', probe, join(extensionPath, 'dist/vendor/node_modules'), sentinel], { windowsHide: true, timeout: 15000, maxBuffer: 65536, env });
  return { ...JSON.parse(result.stdout), nativeBinarySha256: binary.sha256 };
}
