import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join, relative, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { isManifest, WorkbenchError, type OperationReceipt, type ProjectRequest, type WorkbenchManifest } from '@robotics-workbench/contracts';
import { CompanionClient } from './companion-client';
import { SourcePolicy, codexArguments, manifestForSketch } from './source-policy';
import { AgentController } from './agent-controller';
import { WiringController } from './wiring-controller';
import { ArduinoLanguageService } from './language-service';
import { DocumentController } from './document-controller';
import { TelemetryController } from './telemetry-controller';
import { EngineeringController } from './engineering-controller';
import { RecoveryController } from './recovery-controller';

let client: CompanionClient | undefined;
let languageService: ArduinoLanguageService | undefined;
type Build = { buildId: string; operationId: string; sourceSnapshotId: string; targetId: string; fqbn: string; succeeded: boolean; sourceCurrent: boolean; uploadArtifact?: OperationReceipt['artifacts'][number] };
type Snapshot = { manifest: WorkbenchManifest; builds: Build[] };
type Device = { observation: { deviceId: string; observationId: string; transportPath: string; connected: boolean; identityStatus: string; identity?: { serialNumber?: string } }; state: string };

function executable(setting: string, filename: string, fallback?: string): string {
  const configured = vscode.workspace.getConfiguration('roboticsWorkbench').get<string>(setting, '');
  if (configured) {
    if (!isAbsolute(configured) || !existsSync(configured) || !configured.toLowerCase().endsWith('.exe')) throw new Error(`Set Robotics Workbench: ${setting} to an existing absolute executable.`);
    return configured;
  }
  for (const directory of (process.env.PATH ?? '').split(delimiter)) if (isAbsolute(directory) && existsSync(join(directory, filename))) return join(directory, filename);
  if (fallback && existsSync(fallback)) return fallback;
  throw new Error(`TOOL_UNAVAILABLE: ${filename} was not found. Set Robotics Workbench: ${setting}.`);
}

export function activate(context: vscode.ExtensionContext) {
  let outputAvailable = true, binding: string | undefined;
  let lastRecoveryBinding: { root: string; manifest: WorkbenchManifest } | undefined;
  const output = vscode.window.createOutputChannel('Robotics Workbench');
  const diagnostics = vscode.languages.createDiagnosticCollection('roboticsWorkbench');
  const sources = new SourcePolicy();
  const language = languageService = new ArduinoLanguageService();
  for (const document of vscode.workspace.textDocuments) sources.remember(document);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  status.command = 'roboticsWorkbench.checkTools'; status.text = '$(circuit-board) Robotics: companion not started'; status.tooltip = 'Check local tool readiness'; status.show();
  const changes = new vscode.EventEmitter<void>();
  const tree: vscode.TreeDataProvider<vscode.TreeItem> = { onDidChangeTreeData: changes.event, getTreeItem: item => item,
    getChildren: () => [new vscode.TreeItem(!vscode.workspace.isTrusted ? 'Restricted Mode — execution disabled' : client?.pid ? 'Companion connected' : 'Companion starts on Check Tools'),
      ...[['Open project folder', 'openProject'], ['Import existing sketch', 'importSketch'], ['Check configured tools', 'checkTools'], ['Compile saved source', 'compile'], ['Select observed device', 'selectBoard'], ['Upload exact artifact', 'upload'], ['Open agent', 'openAgent'], ['Recovery center', 'openRecovery'], ['Components & Wiring', 'openWiring'], ['Documents & Datasheets', 'openDocuments'], ['Telemetry & Experiments', 'openTelemetry'], ['Schematic handoff', 'openSchematic'], ['CAD handoff', 'openCad'], ['Record raw serial', 'openSerial'], ['Inspect application context', 'inspectContext'], ['Review task changes', 'reviewTaskChanges'], ['Parser profiles', 'openParserProfiles'], ['Attach project document', 'attachDocument'], ['Start Arduino language service', 'startLanguageService'], ['Export project backup', 'exportProject'], ['Restore project backup', 'restoreProject'], ['Export diagnostic bundle', 'exportDiagnostics']].map(([label, command]) => {
        const item = new vscode.TreeItem(label); item.command = { command: `roboticsWorkbench.${command}`, title: label }; return item;
      })] };
  function trusted() {
    if (!vscode.workspace.isTrusted) throw new WorkbenchError('WORKSPACE_UNTRUSTED', 'Trust the workspace before executing tools.');
    if (process.platform !== 'win32' || process.arch !== 'x64' || vscode.env.remoteName || vscode.workspace.workspaceFolders?.some(folder => folder.uri.scheme !== 'file')) throw new WorkbenchError('UNSUPPORTED_ENVIRONMENT', 'Use a local Windows x64 workspace.');
  }
  async function project() {
    trusted();
    const roots = vscode.workspace.workspaceFolders ?? [];
    const root = roots.length === 1 ? roots[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Select the robotics project folder' });
    if (!root) throw new Error('Select a project folder first.');
    const path = join(root.uri.fsPath, 'workbench.json');
    if (!existsSync(path)) throw new Error('Use Robotics: Import Existing Sketch to create a manifest alongside ordinary source files.');
    if (statSync(path).size > 1024 * 1024) throw new Error('Manifest exceeds 1 MiB.');
    const manifest: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isManifest(manifest)) throw new Error('Repair workbench.json before running project operations.');
    return { root: realpathSync(root.uri.fsPath), manifest };
  }
  async function connect(bound?: Awaited<ReturnType<typeof project>>) {
    trusted();
    const next = bound ? `${bound.root}|${bound.manifest.projectId}` : undefined;
    if (client && binding !== next) {
      if (binding !== undefined) throw new WorkbenchError('PROJECT_BUSY', 'This window already owns another project. Close its workbench window before switching project ownership; background refresh cannot stop that project.');
      await client.stop(); client = undefined;
    }
    if (!client) {
      let arduinoPath: string | undefined;
      if (bound) try { arduinoPath = executable('arduinoPath', 'arduino-cli.exe', 'C:/Program Files/Arduino IDE/resources/app/lib/backend/resources/arduino-cli.exe'); } catch { /* Editing and scoped reads remain usable without Arduino. */ }
      const dataRoot = vscode.workspace.getConfiguration('roboticsWorkbench').get<string>('dataRoot', '') || join(context.globalStorageUri.fsPath, 'data');
      if (bound && !isAbsolute(dataRoot)) throw new Error('Robotics Workbench: Data Root must be absolute.');
      const nodePath = executable('nodePath', 'node.exe');
      const optionalProvider = (setting: string, filename: string, fallback: string) => { try { return executable(setting, filename, fallback); } catch { return undefined; } };
      const codexPath = optionalProvider('codexPath', 'codex.exe', join(nodePath, '..', 'node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe'));
      const opencodePath = optionalProvider('opencodePath', 'opencode.exe', join(process.env.USERPROFILE ?? '', 'scoop/apps/opencode/current/opencode.exe'));
      const kicadPath = optionalProvider('kicadPath', 'kicad-cli.exe', '');
      const cadSetting = vscode.workspace.getConfiguration('roboticsWorkbench').get<string>('cadPythonPath', '');
      const cadPythonPath = cadSetting ? optionalProvider('cadPythonPath', 'python.exe', '') : undefined;
      const kicadSha256 = vscode.workspace.getConfiguration('roboticsWorkbench').get<string>('kicadSha256', '');
      client = new CompanionClient(context.asAbsolutePath('dist/companion.js'), nodePath, line => { if (outputAvailable) output.appendLine(line); }, () => {
        if (outputAvailable) { status.text = '$(warning) Robotics: companion disconnected'; status.command = 'roboticsWorkbench.checkTools'; status.tooltip = 'Check local tool readiness'; changes.fire(); }
      },
        bound ? { projectRoot: bound.root, dataRoot, ...(arduinoPath ? { arduinoPath } : {}), ...(codexPath ? { codexPath } : {}), ...(opencodePath ? { opencodePath } : {}), ...(kicadPath ? { kicadPath } : {}), ...(kicadSha256 ? { kicadSha256 } : {}), ...(cadPythonPath ? { cadPythonPath } : {}) } : undefined);
      binding = next;
    }
    const hello = await client.start();
    if (bound) lastRecoveryBinding = { root: bound.root, manifest: structuredClone(bound.manifest) };
    changes.fire(); return hello;
  }
  async function recoveryProject() {
    try { return await project(); }
    catch (error) {
      trusted();
      const previous = lastRecoveryBinding;
      const sameWorkspace = previous && vscode.workspace.workspaceFolders?.some(folder => {
        try { return realpathSync(folder.uri.fsPath).toLowerCase() === previous.root.toLowerCase(); } catch { return false; }
      });
      if (!previous || !sameWorkspace || !client?.pid || binding !== `${previous.root}|${previous.manifest.projectId}`) throw error;
      return { root: previous.root, manifest: structuredClone(previous.manifest) };
    }
  }
  async function rpc<T>(bound: Awaited<ReturnType<typeof project>>, method: ProjectRequest['method'], params: Record<string, unknown> = {}, revision?: number): Promise<T> {
    await connect(bound);
    return await client!.requestProject({ schemaVersion: 1, requestId: randomUUID(), projectId: bound.manifest.projectId, method, params, ...(revision === undefined ? {} : { expectedProjectRevision: revision }) }) as T;
  }
  async function snapshot(bound: Awaited<ReturnType<typeof project>>) { return rpc<Snapshot>(bound, 'project.snapshot'); }
  async function checkTools() {
    if (!vscode.workspace.isTrusted) return { error: 'WORKSPACE_UNTRUSTED' };
    try {
      const root = vscode.workspace.workspaceFolders?.find(folder => existsSync(join(folder.uri.fsPath, 'workbench.json')));
      const bound = root ? await project() : undefined;
      const hello = await connect(bound);
      if (hello.state !== 'ready') throw new Error('Companion is stopping. Run Check Tools after it exits.');
      status.text = '$(plug) Robotics: companion ready'; status.command = 'roboticsWorkbench.checkTools'; status.tooltip = 'Check local tool readiness';
      output.appendLine(`Companion: ready · Node ${hello.runtimeVersion}`);
      if (bound) {
        try {
          const arduino = await rpc<{ version: string; executablePath: string; checkedAt: string; cores: { id: string; version: string }[]; capabilities: { supportedUploadFqbns: string[] } }>(bound, 'toolchain.inspect');
          output.appendLine(`Arduino CLI ${arduino.version} · checked ${arduino.checkedAt}\n  ${arduino.executablePath}`);
          output.appendLine(`Installed cores: ${arduino.cores.map(core => `${core.id} ${core.version}`).join(', ') || 'none reported'}`);
          output.appendLine(`Supported exact-artifact targets: ${arduino.capabilities.supportedUploadFqbns.join(', ') || 'none verified'}`);
        } catch (error) { output.appendLine(`Arduino CLI check unavailable: ${String(error)}\n  Check Robotics Workbench settings for the Arduino CLI path.`); }
      } else {
        output.appendLine('Arduino CLI: project check pending. Open or import an existing sketch, then run Check Tools again.');
      }
      output.appendLine('Open Agent to check provider readiness. Open Schematic or CAD handoff to inspect optional tools.');
      return hello;
    } catch (error) { status.text = '$(warning) Robotics: tool check unavailable'; status.command = 'roboticsWorkbench.checkTools'; status.tooltip = 'Check local tool readiness'; throw error; }
  }
  async function wait(bound: Awaited<ReturnType<typeof project>>, receipt: OperationReceipt): Promise<OperationReceipt> {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Robotics: ${receipt.kind}`, cancellable: true }, async (progress, token) => {
      let cancellation: Promise<unknown> | undefined;
      const subscription = token.onCancellationRequested(() => { cancellation ??= rpc(bound, 'operation.cancel', { operationId: receipt.operationId }).catch(error => output.appendLine(String(error))); });
      try {
        for (;;) {
          if (!outputAvailable) throw new Error('Host disposed; query the durable operation receipt after reconnecting.');
          progress.report({ message: receipt.kind === 'upload' && receipt.status === 'running' ? 'Running · interrupting may leave the firmware outcome unknown' : receipt.status });
          status.text = `$(circuit-board) Robotics: ${receipt.kind} ${receipt.status}`;
          status.command = 'roboticsWorkbench.openRecovery';
          status.tooltip = `${receipt.kind} ${receipt.status}\nReceipt ${receipt.operationId}${receipt.deviceId ? `\nDevice ${receipt.deviceId}` : ''}\nOpen Recovery Center to inspect retained evidence`;
          if (!['queued', 'running', 'awaiting-input'].includes(receipt.status)) { output.appendLine(JSON.stringify(receipt)); return receipt; }
          await new Promise(resolve => setTimeout(resolve, 250));
          receipt = await rpc(bound, 'operation.get', { operationId: receipt.operationId });
        }
      } finally { subscription.dispose(); changes.fire(); }
    });
  }
  async function diagnosticBuild(bound: Awaited<ReturnType<typeof project>>, build: Build) {
    type Page = { sourceCurrent: boolean; sourceSnapshotId: string; items: { path: string | null; line: number | null; column: number | null; severity: string; message: string }[]; nextCursor: string | null };
    const result = await rpc<Page>(bound, 'build.diagnostics', { buildId: build.buildId });
    let cursor = result.nextCursor, pages = 1;
    while (cursor && pages++ < 32) { const page = await rpc<Page>(bound, 'build.diagnostics', { buildId: build.buildId, cursor }); result.items.push(...page.items); result.sourceCurrent &&= page.sourceCurrent; cursor = page.nextCursor; }
    if (cursor) output.appendLine('Diagnostic preview limited; compiler log artifacts retain the full output.');
    diagnostics.clear();
    if (!result.sourceCurrent) { output.appendLine(`Historical diagnostics for snapshot ${result.sourceSnapshotId}; current source differs.`); return; }
    const mapped = new Map<string, vscode.Diagnostic[]>();
    for (const item of result.items) {
      output.appendLine(item.message);
      if (!item.path || item.line === null) continue;
      const path = isAbsolute(item.path) ? item.path : join(bound.root, item.path);
      let scoped: string; try { scoped = relative(bound.root, realpathSync(path)); } catch { continue; }
      if (isAbsolute(scoped) || scoped === '..' || scoped.startsWith(`..${sep}`)) continue;
      const row = Math.max(0, item.line - 1), col = Math.max(0, (item.column ?? 1) - 1);
      const diagnostic = new vscode.Diagnostic(new vscode.Range(row, col, row, col + 1), item.message,
        item.severity === 'error' ? vscode.DiagnosticSeverity.Error : item.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information);
      diagnostic.source = 'Arduino'; diagnostic.code = result.sourceSnapshotId;
      const values = mapped.get(path) ?? []; values.push(diagnostic); mapped.set(path, values);
    }
    for (const [path, values] of mapped) diagnostics.set(vscode.Uri.file(path), values);
  }
  async function selectBoard(bound?: Awaited<ReturnType<typeof project>>): Promise<Device | undefined> {
    bound ??= await project();
    const { devices } = await rpc<{ devices: Device[] }>(bound, 'device.discover');
    const choices = devices.filter(item => item.observation.connected).map(item => ({ label: item.observation.transportPath, description: `${item.observation.identityStatus === 'ambiguous' ? 'Ambiguous identity' : item.observation.identity?.serialNumber ?? 'No USB serial'} · ${item.state}`, detail: `Device ${item.observation.deviceId} · observed separately from the compiler target`, item }));
    if (!choices.length) throw new Error('No connected serial device was observed. Connect and identify the intended board. You can still edit and compile.');
    const picked = await vscode.window.showQuickPick(choices, { title: 'Robotics: Select Observed Device', placeHolder: 'Confirm the physical device. Choose the compiler target separately.', matchOnDescription: true, matchOnDetail: true });
    if (!picked) return;
    const selectedDevice = await rpc<Device>(bound, 'device.select', { deviceId: picked.item.observation.deviceId, expectedDeviceObservationId: picked.item.observation.observationId });
    status.text = `$(circuit-board) Robotics: ${selectedDevice.observation.transportPath} selected`;
    status.command = 'roboticsWorkbench.selectBoard'; status.tooltip = `Selected device ${selectedDevice.observation.deviceId}\nInspect observed devices`;
    return selectedDevice;
  }
  function register(name: string, command: () => Promise<unknown>) { return vscode.commands.registerCommand(`roboticsWorkbench.${name}`, async () => { try { return await command(); } catch (error) { output.appendLine(String(error)); output.show(true); await vscode.window.showErrorMessage(String(error)); } }); }
  const agent = new AgentController(context, { project, request: rpc, openDocument: citation => documents.reveal(citation), openRecording: selection => telemetry.reveal(selection), prepareSource: async bound => {
    const state = await snapshot(bound); bound.manifest = state.manifest;
    const target = state.manifest.targets.length === 1 ? state.manifest.targets[0] : (await vscode.window.showQuickPick(state.manifest.targets.map(target => ({ label: target.fqbn, target })), { placeHolder: 'Select the agent source/compiler target' }))?.target;
    if (!target) throw new Error('Select a source target before starting the task.');
    const frozen = await sources.save(bound.root, vscode.workspace.textDocuments, async paths => await vscode.window.showWarningMessage(`Save ${paths.length} changed project documents and prepare agent context?`, { modal: true }, 'Save and prepare context') === 'Save and prepare context');
    const prepared = await rpc<{ sourceSnapshotId: string }>(bound, 'project.prepareBuild', { targetId: target.targetId, documentHashes: frozen.map(({ path, sha256 }) => ({ path, sha256 })) }, state.manifest.projectRevision);
    sources.assertUnchanged(bound.root, frozen); return prepared.sourceSnapshotId;
  }, authorizeUpload: async (bound, taskId) => {
    const state = await snapshot(bound);
    const picked = await vscode.window.showQuickPick(state.builds.filter(build => build.succeeded && build.sourceCurrent && build.uploadArtifact).map(build => ({ label: build.fqbn, description: build.buildId, detail: `SHA256 ${build.uploadArtifact!.sha256}`, build })), { placeHolder: 'Authorize this exact artifact for the selected agent task' }); if (!picked) return;
    const device = await selectBoard(bound); if (!device) return;
    const frozen = await sources.save(bound.root, vscode.workspace.textDocuments, async () => false);
    const confirmed = await vscode.window.showWarningMessage(`Authorize agent task ${taskId} to upload\nSHA256 ${picked.build.uploadArtifact!.sha256}\nto ${device.observation.transportPath} · ${device.observation.deviceId}?\nThe grant permits this exact target/artifact while the task remains active. Firmware will be replaced only if the agent requests the operation; physical behavior remains unverified.`, { modal: true }, 'Authorize exact task upload');
    if (confirmed !== 'Authorize exact task upload') return; sources.assertUnchanged(bound.root, frozen);
    await rpc(bound, 'agent.authorizeUpload', { taskId, upload: { buildId: picked.build.buildId, artifactId: picked.build.uploadArtifact!.artifactId, artifactSha256: picked.build.uploadArtifact!.sha256, deviceId: device.observation.deviceId, expectedDeviceObservationId: device.observation.observationId, fqbn: picked.build.fqbn, resumeMonitoring: true } }, state.manifest.projectRevision);
  } });
  const wiring = new WiringController(context, { project, request: rpc, ask: selection => agent.selectEntity(selection) });
  const documents = new DocumentController(context, { project, request: rpc, wait, ask: citation => agent.selectCitation(citation, documents.getState().project!.projectRevision) });
  const telemetry = new TelemetryController(context, { project, request: rpc, wait, ask: selection => agent.selectInterval(selection, telemetry.getState().project!.projectRevision) });
  const engineering = new EngineeringController(context, { project, request: rpc, wait });
  const recovery = new RecoveryController({ project: recoveryProject, request: rpc, prepareArchive: async bound => {
    const frozen = await sources.save(bound.root, vscode.workspace.textDocuments, async paths => await vscode.window.showWarningMessage(`Save ${paths.length} changed project documents and export backup?`, { modal: true }, 'Save and export backup') === 'Save and export backup');
    sources.assertUnchanged(bound.root, frozen);
    const state = await rpc<{ manifest: WorkbenchManifest; manifestSha256: string }>(bound, 'project.snapshot');
    sources.assertUnchanged(bound.root, frozen);
    bound.manifest = state.manifest;
    return { manifestSha256: state.manifestSha256, documentHashes: Object.fromEntries(frozen.map(item => [item.path, item.sha256])), assertUnchanged: () => sources.assertUnchanged(bound.root, frozen) };
  } });
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{ino,h,hpp,c,cpp,json,yaml}');
  context.subscriptions.push({ dispose: () => { outputAvailable = false; } }, output, diagnostics, status, changes, watcher, agent, wiring, language, documents, telemetry, engineering, recovery,
    watcher.onDidChange(() => diagnostics.clear()), watcher.onDidDelete(() => diagnostics.clear()),
    vscode.workspace.onDidOpenTextDocument(document => sources.remember(document)),
    vscode.workspace.onDidSaveTextDocument(document => sources.remember(document)),
    vscode.workspace.onDidChangeTextDocument(() => diagnostics.clear()),
    vscode.window.registerTreeDataProvider('roboticsWorkbench.project', tree), vscode.workspace.onDidGrantWorkspaceTrust(() => changes.fire()),
    register('openRecovery', () => recovery.show()),
    register('exportProject', () => recovery.exportProject()),
    register('restoreProject', () => recovery.restoreProject()),
    register('exportDiagnostics', () => recovery.exportDiagnostics()),
    register('openProject', async () => { const selected = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false }); if (selected?.[0]) await vscode.commands.executeCommand('vscode.openFolder', selected[0], { forceNewWindow: true }); }),
    register('importSketch', async () => {
      trusted(); const folders = vscode.workspace.workspaceFolders ?? [];
      const selectedRoot = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Select project root for the imported sketch' });
      const root = selectedRoot?.uri.fsPath;
      if (!root) throw new Error('Open the folder containing the existing sketch first.');
      if (existsSync(join(root, 'workbench.json'))) throw new Error('A manifest already exists; edit it as an ordinary file to add sketches or compiler targets.');
      const folder = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: vscode.Uri.file(root), title: 'Select existing Arduino sketch folder' }); if (!folder?.[0]) return;
      if (!existsSync(join(folder[0].fsPath, `${basename(folder[0].fsPath)}.ino`))) throw new Error('Choose an ordinary sketch folder containing its matching primary .ino file.');
      const fqbn = await vscode.window.showInputBox({ prompt: 'Compiler target FQBN (separate from the observed physical device)', value: 'arduino:avr:uno' }); if (!fqbn) return;
      const manifest = manifestForSketch(root, folder[0].fsPath, fqbn);
      writeFileSync(join(root, 'workbench.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
      await vscode.window.showTextDocument(vscode.Uri.file(join(root, 'workbench.json'))); changes.fire(); return manifest;
    }),
    register('checkTools', async () => { const result = await checkTools(); if ('error' in result) output.appendLine('Restricted Mode: trust this workspace before checking tools.'); output.show(true); return result; }),
    register('selectBoard', async () => selectBoard()),
    register('compile', async () => {
      const bound = await project(); const state = await snapshot(bound);
      const picked = await vscode.window.showQuickPick(state.manifest.targets.map(target => ({ label: target.fqbn, description: target.targetId, target })), { placeHolder: 'Choose compiler target' }); if (!picked) return;
      const frozen = await sources.save(bound.root, vscode.workspace.textDocuments, async paths => await vscode.window.showWarningMessage(`Save ${paths.length} changed project documents and compile?`, { modal: true }, 'Save and compile') === 'Save and compile');
      const prepared = await rpc<{ sourceSnapshotId: string }>(bound, 'project.prepareBuild', { targetId: picked.target.targetId, documentHashes: frozen.map(({ path, sha256 }) => ({ path, sha256 })) }, state.manifest.projectRevision);
      sources.assertUnchanged(bound.root, frozen);
      const initial = await rpc<OperationReceipt>(bound, 'build.compile', { targetId: picked.target.targetId, sourceSnapshotId: prepared.sourceSnapshotId }, state.manifest.projectRevision);
      const receipt = await wait(bound, initial); const refreshed = await snapshot(bound); const build = refreshed.builds.find(item => item.operationId === receipt.operationId);
      if (build) await diagnosticBuild(bound, build);
      if (receipt.status !== 'succeeded') throw new Error(`${receipt.status}: ${receipt.error?.message ?? 'Compilation did not succeed; no upload was requested.'}`);
      output.show(true); return receipt;
    }),
    register('upload', async () => {
      const bound = await project(); const state = await snapshot(bound);
      const picked = await vscode.window.showQuickPick(state.builds.filter(build => build.succeeded && build.sourceCurrent && build.uploadArtifact).map(build => ({ label: build.fqbn, description: build.buildId, detail: `SHA256 ${build.uploadArtifact!.sha256}`, build })), { placeHolder: 'Select a current successful artifact; failed builds cannot substitute a previous binary' }); if (!picked) return;
      const device = await selectBoard(bound); if (!device) return;
      const frozen = await sources.save(bound.root, vscode.workspace.textDocuments, async () => false);
      const confirm = await vscode.window.showWarningMessage(`Upload build ${picked.build.buildId}\nSHA256 ${picked.build.uploadArtifact!.sha256}\nTo ${device.observation.transportPath} · ${device.observation.deviceId}\nCurrent firmware will be replaced. Physical behavior remains unverified.`, { modal: true }, 'Upload exact artifact'); if (confirm !== 'Upload exact artifact') return;
      sources.assertUnchanged(bound.root, frozen);
      const receipt = await rpc<OperationReceipt>(bound, 'firmware.upload', { buildId: picked.build.buildId, artifactId: picked.build.uploadArtifact!.artifactId, artifactSha256: picked.build.uploadArtifact!.sha256, deviceId: device.observation.deviceId, expectedDeviceObservationId: device.observation.observationId, fqbn: picked.build.fqbn, resumeMonitoring: true }, state.manifest.projectRevision);
      const result = await wait(bound, receipt);
      if (result.status !== 'succeeded') throw new Error(`${result.status}: ${result.error?.message ?? 'Inspect the upload receipt before any retry.'}`);
      output.appendLine('Uploader reported success. Capture and physical verification remain separate.'); return result;
    }),
    register('openSerial', async () => {
      const bound = await project(), device = await selectBoard(bound); if (!device) return;
      const baud = await vscode.window.showInputBox({ prompt: 'Raw serial baud rate (8N1)', value: '9600', validateInput: value => /^\d+$/.test(value) && +value >= 1 && +value <= 4000000 ? undefined : 'Enter 1–4000000' }); if (!baud) return;
      const seconds = await vscode.window.showInputBox({ prompt: 'Capture duration in seconds (opening the port may reset Uno)', value: '10', validateInput: value => /^\d+$/.test(value) && +value >= 1 && +value <= 3600 ? undefined : 'Enter 1–3600' }); if (!seconds) return;
      const receipt = await wait(bound, await rpc<OperationReceipt>(bound, 'serial.capture', { deviceId: device.observation.deviceId, baudRate: +baud, durationMs: +seconds * 1000 }));
      if (receipt.result?.recordingId) {
        let cursor: string | undefined, previewBytes = 0, pages = 0;
        const decoder = new StringDecoder('utf8');
        do {
          const window = await rpc<{ bytesBase64: string; gaps: unknown[]; omittedGaps: number; nextCursor?: string | null }>(bound, 'recording.query', { recordingId: receipt.result.recordingId, range: { startMs: 0, endMs: +seconds * 1000, timeBasis: 'host-receive' }, limit: 100, ...(cursor ? { cursor } : {}) });
          const text = decoder.write(Buffer.from(window.bytesBase64, 'base64'));
          output.append(Buffer.from(text).subarray(0, 65536 - previewBytes).toString('utf8')); previewBytes += Buffer.byteLength(text);
          if (!pages++ && window.gaps.length) output.appendLine(`\nCapture gaps: ${JSON.stringify(window.gaps)}; additional gaps omitted: ${window.omittedGaps}`);
          cursor = window.nextCursor ?? undefined;
        } while (cursor && previewBytes < 65536 && pages < 32);
        if (!cursor) output.append(decoder.end());
        if (cursor) output.appendLine(`\nPreview limited to 64 KiB; raw recording ${receipt.result.recordingId} remains retained. Continuation: ${cursor}`);
      }
      output.appendLine(`\nRaw capture ${receipt.status}; receipt ${receipt.operationId}`); output.show(true); return receipt;
    }),
    register('inspectContext', async () => { const bound = await project(); const supplied = await rpc<{ text: string }>(bound, 'project.context'); const document = await vscode.workspace.openTextDocument({ language: 'json', content: supplied.text }); await vscode.window.showTextDocument(document); return supplied; }),
    register('openAgent', async () => agent.show()),
    register('openWiring', async () => wiring.show()),
    register('openComponents', async () => wiring.show()),
    register('openDocuments', async () => documents.show()),
    register('attachDocument', async () => documents.attach()),
    register('openTelemetry', async () => telemetry.show()),
    register('openRuns', async () => telemetry.show()),
    register('openSchematic', async () => engineering.show('schematic')),
    register('openCad', async () => engineering.show('cad')),
    register('openParserProfiles', async () => telemetry.openProfiles()),
    register('startLanguageService', async () => {
      const bound = await project();
      const sketch = bound.manifest.sketches.length === 1 ? bound.manifest.sketches[0] : (await vscode.window.showQuickPick(bound.manifest.sketches.map(value => ({ label: value.path, value })), { title: 'Sketch for Arduino language features' }))?.value;
      if (!sketch) return;
      const target = bound.manifest.targets.find(value => value.targetId === sketch.targetId);
      if (!target) throw Error('The selected sketch has no explicit target.');
      const directory = 'C:/Program Files/Arduino IDE/resources/app/lib/backend/resources/';
      const config = vscode.workspace.getConfiguration('roboticsWorkbench').get<string>('arduinoConfigPath', '') || join(process.env.USERPROFILE ?? '', '.arduinoIDE/arduino-cli.yaml');
      await language.start(bound.root, sketch, target, { server: executable('arduinoLanguageServerPath', 'arduino-language-server.exe', directory + 'arduino-language-server.exe'), clangd: executable('clangdPath', 'clangd.exe', directory + 'clangd.exe'), cli: executable('arduinoPath', 'arduino-cli.exe', directory + 'arduino-cli.exe'), config });
      output.appendLine('Arduino language features started for the selected sketch/FQBN. Unsaved buffers are synchronized; compile and upload remain separate actions.');
    }),
    register('stopLanguageService', async () => language.stop()),
    register('reviewTaskChanges', async () => agent.showReview()),
    register('openAgentTerminal', async () => {
      const bound = await project(); const supplied = await rpc<{ text: string }>(bound, 'project.context');
      const terminal = vscode.window.createTerminal({ name: 'Robotics · Codex', cwd: bound.root, shellPath: executable('codexPath', 'codex.exe'), shellArgs: codexArguments(bound.root, supplied.text) });
      context.subscriptions.push(terminal); terminal.show(); output.appendLine('Supplied the bounded application snapshot to the existing Codex terminal. Later terminal edits and provider claims require separate review and validation.');
    })
  );
  return { checkTools, stop: deactivate, getCompanionPid: () => client?.pid, getAgentState: () => agent.getState(), agent, wiring, documents, language, telemetry, engineering, recovery };
}

export async function deactivate(): Promise<void> { await Promise.all([client?.stop(), languageService?.stop()]); client = undefined; }
