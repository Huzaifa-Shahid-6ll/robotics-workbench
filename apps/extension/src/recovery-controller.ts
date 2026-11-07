import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, dirname } from 'node:path';
import type * as vscode from 'vscode';
import { isRequestId, isRecoverySnapshot, isDiagnosticPreview, isDiagnosticExportResult, validateOperation, WorkbenchError, type ProjectMethod, type RecoverySnapshot, type WorkbenchManifest } from '@robotics-workbench/contracts';

type Bound = { root: string; manifest: WorkbenchManifest };
type RecoveryAction = 'checkTools' | 'selectBoard' | 'reviewTaskChanges' | 'openTelemetry';
export interface RecoveryChoice { label: string; description?: string; detail?: string; operationId?: string; action?: RecoveryAction | 'inspect' | 'next' | 'refresh' | 'export' | 'restore' | 'acknowledge' | 'diagnostics' }
export interface RecoveryUi {
  pick(items: RecoveryChoice[], title: string, placeHolder: string): Promise<RecoveryChoice | undefined>;
  inspect(title: string, content: string): Promise<void>;
  path(title: string, value: string, existing?: boolean): Promise<string | undefined>;
  saveFile(title: string, value: string): Promise<string | undefined>;
  confirm(message: string, action: string, modal?: boolean): Promise<boolean>;
  input(prompt: string): Promise<string | undefined>;
  message(message: string): Promise<void>;
  action(action: RecoveryAction): Promise<void>;
  dispose(): void;
}
export interface RecoveryHost {
  project(): Promise<Bound>;
  request<T>(bound: Bound, method: ProjectMethod, params?: Record<string, unknown>, revision?: number): Promise<T>;
  prepareArchive(bound: Bound): Promise<{ manifestSha256: string; documentHashes: Record<string, string>; assertUnchanged(): void }>;
}
const safeLabel = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\$\(/g, '(');
const notice = 'Receipts describe recorded outcomes. Current firmware and physical wiring require separate observations. Unknown uploads are never replayed here.';

/** Recovery offers explicit inspection and fresh actions; retained effects are never replayed. */
export class RecoveryController {
  private disposed = false;
  constructor(private readonly host: RecoveryHost, private readonly ui: RecoveryUi = nativeRecoveryUi()) {}
  async show(): Promise<void> {
    const bound = await this.host.project();
    let cursor: string | undefined;
    while (!this.disposed) {
      let state: RecoverySnapshot;
      try {
        state = await this.host.request<RecoverySnapshot>(bound, 'recovery.inspect', cursor ? { cursor } : {});
        if (!isRecoverySnapshot(state) || state.projectId !== bound.manifest.projectId) throw new WorkbenchError('INVALID_REQUEST', 'Recovery response has an invalid project or receipt summary.');
      } catch (error) {
        const choice = await this.ui.pick([{ label: 'Refresh recovery', action: 'refresh' }, { label: 'Check configured tools', action: 'checkTools' }], 'Robotics: Recovery unavailable', safeLabel(String(error)));
        if (choice?.action === 'refresh') { cursor = undefined; continue; }
        if (choice?.action === 'checkTools') await this.ui.action('checkTools');
        return;
      }
      const items: RecoveryChoice[] = [
        ...state.operations.map(item => ({ label: `${item.kind} · ${item.status}`, description: item.operationId, detail: `${item.artifactCount} retained artifacts · ${item.finishedAt ?? item.createdAt}${item.error ? ` · ${safeLabel(item.error.message)}` : ''}`, operationId: item.operationId })),
        ...state.operations.filter(item => item.kind === 'upload' && item.status === 'outcome-unknown').map(item => ({ label: 'Acknowledge stopped uploader', description: item.operationId, detail: 'Requires an operator check. The original upload outcome and firmware remain unknown.', operationId: item.operationId, action: 'acknowledge' as const })),
        ...(state.nextCursor ? [{ label: 'Next receipt page', action: 'next' as const }] : []),
        { label: 'Inspect recovery snapshot', action: 'inspect', detail: state.operations.length ? notice : `No operation receipts on this page. ${notice}` },
        { label: 'Refresh recovery', action: 'refresh', detail: 'Read retained state again; no operation is repeated.' },
        { label: 'Select observed device', action: 'selectBoard', detail: 'Explicitly inspect and select a target. No upload is started.' },
        { label: 'Review retained task changes', action: 'reviewTaskChanges', detail: 'Compare source versions and preserve conflicts.' },
        { label: 'Inspect recordings and experiments', action: 'openTelemetry', detail: 'Historical evidence remains inspectable without a device.' },
        { label: 'Check configured tools', action: 'checkTools' },
        { label: 'Export diagnostic bundle', action: 'diagnostics', detail: 'Preview a local snapshot of versions, receipt summaries and storage health.' },
        { label: 'Export project backup', action: 'export', detail: 'Snapshot saved ordinary files and finalized evidence to a new directory.' },
        { label: 'Restore backup to new directories', action: 'restore', detail: 'Preserve original files and history; observe devices again after restoration.' }
      ];
      const choice = await this.ui.pick(items, `Robotics: Recovery · revision ${state.projectRevision}`, 'Inspect a receipt or choose a specific recovery action');
      if (!choice || this.disposed) return;
      if (choice.operationId) { if (choice.action === 'acknowledge') await this.acknowledgeUnknownUpload(bound, choice.operationId); else await this.inspectOperation(bound, choice.operationId); return; }
      if (choice.action === 'refresh') { cursor = undefined; continue; }
      if (choice.action === 'next') { cursor = state.nextCursor ?? undefined; continue; }
      if (choice.action === 'inspect') await this.ui.inspect('Recovery snapshot', JSON.stringify(state, null, 2));
      else if (choice.action === 'export') await this.exportProject();
      else if (choice.action === 'restore') await this.restoreProject();
      else if (choice.action === 'diagnostics') await this.exportDiagnostics();
      else if (choice.action && choice.action !== 'acknowledge') await this.ui.action(choice.action);
      return;
    }
  }
  async inspectOperation(bound: Bound, operationId: string): Promise<void> {
    if (!isRequestId(operationId)) throw new WorkbenchError('INVALID_REQUEST', 'Select a recorded operation UUID.');
    const receipt = validateOperation(await this.host.request(bound, 'operation.get', { operationId }));
    if (receipt.projectId !== bound.manifest.projectId || receipt.operationId !== operationId) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Receipt does not belong to the selected project and operation.');
    await this.ui.inspect(`${receipt.kind} · ${receipt.status}`, JSON.stringify({ notice, receipt }, null, 2));
  }
  async acknowledgeUnknownUpload(bound: Bound, operationId: string): Promise<void> {
    const receipt = validateOperation(await this.host.request(bound, 'operation.get', { operationId }));
    if (receipt.projectId !== bound.manifest.projectId || receipt.operationId !== operationId || receipt.kind !== 'upload' || receipt.status !== 'outcome-unknown' || !receipt.deviceId) throw new WorkbenchError('INVALID_REQUEST', 'Select an outcome-unknown upload from this project.');
    type Device = { state: string; observation: { deviceId: string; observationId: string; connected: boolean; transportPath: string; identity?: { serialNumber?: string } } };
    const discovered = await this.host.request<{ devices: Device[] }>(bound, 'device.discover');
    if (!Array.isArray(discovered.devices)) throw new WorkbenchError('INVALID_REQUEST', 'Device discovery returned invalid observations.');
    const matching = discovered.devices.filter(item => item?.observation?.deviceId === receipt.deviceId && item.observation.connected === true);
    if (matching.length !== 1 || matching[0].state !== 'outcome-unknown' || !isRequestId(matching[0].observation.observationId) || typeof matching[0].observation.transportPath !== 'string') throw new WorkbenchError('TARGET_AMBIGUOUS', 'The original upload device is not uniquely connected in an unresolved state. Inspect its identity before any acknowledgment.');
    const observation = matching[0].observation;
    const note = await this.ui.input('Record how you confirmed the external uploader has terminated; firmware state remains unknown');
    if (!note?.trim()) return;
    const firmware = typeof receipt.result?.artifactSha256 === 'string' ? receipt.result.artifactSha256 : 'Unavailable in this receipt; firmware remains unknown';
    if (!await this.ui.confirm(`Confirm the external uploader has terminated for operation ${operationId}.\nDevice: ${observation.deviceId}\nCurrent observation: ${observation.observationId}\nPort: ${safeLabel(observation.transportPath)}\nUSB serial: ${safeLabel(observation.identity?.serialNumber ?? 'unknown')}\nFirmware artifact: ${firmware}\n\nThis releases the workbench's unresolved device reservation. It does not mark upload success, retry an upload, open serial, or verify hardware behavior.\nOperator note: ${note.trim()}`, 'Confirm uploader stopped')) return;
    const result = await this.host.request(bound, 'device.reconcile', { operationId, deviceId: observation.deviceId, expectedDeviceObservationId: observation.observationId, processTerminationConfirmed: true, note: note.trim() }, bound.manifest.projectRevision);
    await this.ui.inspect('Unknown upload acknowledgment', JSON.stringify({ notice, result }, null, 2));
  }
  async exportProject(): Promise<void> {
    const initial = await this.host.project();
    const destination = await this.ui.path('New project backup directory', join(dirname(initial.root), `${initial.manifest.name}-backup`));
    if (!destination || !await this.ui.confirm(`Export saved project files and finalized operational evidence to ${destination}? Active operations must finish first. Recognizable credentials block export.`, 'Export project backup')) return;
    const bound = await this.host.project();
    if (bound.manifest.projectId !== initial.manifest.projectId || bound.root !== initial.root) throw new WorkbenchError('REVISION_CONFLICT', 'Selected project changed during backup dialogs. No backup was requested.');
    const prepared = await this.host.prepareArchive(bound);
    const state = await this.host.request<{ manifest: WorkbenchManifest; manifestSha256: string }>(bound, 'project.snapshot');
    if (state.manifest.projectId !== bound.manifest.projectId || state.manifestSha256 !== prepared.manifestSha256) throw new WorkbenchError('REVISION_CONFLICT', 'Project changed after preparing backup. Saved files and editor versions remain intact.');
    prepared.assertUnchanged();
    const result = await this.host.request(bound, 'project.export', { destination, expectedManifestSha256: prepared.manifestSha256, documentHashes: prepared.documentHashes }, state.manifest.projectRevision);
    await this.ui.inspect('Project backup evidence', JSON.stringify(result, null, 2));
  }
  async exportDiagnostics(): Promise<void> {
    const initial = await this.host.project();
    const preview = await this.host.request<unknown>(initial, 'diagnostics.preview');
    if (!isDiagnosticPreview(preview) || preview.projectId !== initial.manifest.projectId || preview.projectRevision !== initial.manifest.projectRevision || Buffer.byteLength(preview.text) !== preview.byteLength || createHash('sha256').update(preview.text).digest('hex') !== preview.bundleSha256) throw new WorkbenchError('INVALID_REQUEST', 'Diagnostic preview identity or bytes are invalid.');
    await this.ui.inspect('Diagnostic bundle preview', preview.text);
    if (this.disposed || !await this.ui.confirm('Review the diagnostic preview, then choose Save to select a new local JSON file.', 'Save diagnostic bundle', false)) return;
    const destination = await this.ui.saveFile('New diagnostic JSON file', join(dirname(initial.root), 'robotics-workbench-diagnostics.json'));
    if (!destination || this.disposed) return;
    const bound = await this.host.project();
    if (bound.root !== initial.root || bound.manifest.projectId !== preview.projectId || bound.manifest.projectRevision !== preview.projectRevision) throw new WorkbenchError('REVISION_CONFLICT', 'Selected project changed while reviewing diagnostics. No file was exported.');
    const result = await this.host.request<unknown>(bound, 'diagnostics.export', { previewId: preview.previewId, expectedBundleSha256: preview.bundleSha256, destination }, preview.projectRevision);
    if (!isDiagnosticExportResult(result) || result.previewId !== preview.previewId || result.bundleSha256 !== preview.bundleSha256 || result.byteLength !== preview.byteLength) throw new WorkbenchError('INVALID_REQUEST', 'Diagnostic export response does not identify the reviewed snapshot.');
    await this.ui.message(`Diagnostic bundle saved locally to ${result.destination}.`);
  }
  async restoreProject(): Promise<void> {
    const initial = await this.host.project();
    const archiveDirectory = await this.ui.path('Select retained project backup', dirname(initial.root), true); if (!archiveDirectory) return;
    const newProjectRoot = await this.ui.path('New empty project directory', join(dirname(initial.root), `${initial.manifest.name}-restored`)); if (!newProjectRoot) return;
    const newDataRoot = await this.ui.path('New empty operational data directory', `${newProjectRoot}-data`); if (!newDataRoot) return;
    if (!await this.ui.confirm(`Restore ${archiveDirectory}\nProject: ${newProjectRoot}\nOperational data: ${newDataRoot}\nExisting files will be preserved. Restored device and firmware evidence is historical. This window keeps its current project ownership.`, 'Restore to new directories')) return;
    const bound = await this.host.project();
    if (bound.manifest.projectId !== initial.manifest.projectId || bound.root !== initial.root) throw new WorkbenchError('REVISION_CONFLICT', 'Selected project changed during restore dialogs. No restoration was requested.');
    const result = await this.host.request(bound, 'project.restore', { archiveDirectory, newProjectRoot, newDataRoot }, bound.manifest.projectRevision);
    await this.ui.inspect('Restored project evidence', JSON.stringify(result, null, 2));
    await this.ui.message('Restored evidence is historical. Close this workbench window before opening the restored project, set its new operational data directory, and explicitly observe/select the device again. No firmware or physical wiring was restored.');
  }
  dispose(): void { this.disposed = true; this.ui.dispose(); }
}

export function nativeRecoveryUi(): RecoveryUi {
  const api: typeof vscode = require('vscode');
  const contents = new Map<string, string>();
  const scheme = `robotics-recovery-${randomUUID()}`;
  const provider = api.workspace.registerTextDocumentContentProvider(scheme, { provideTextDocumentContent: uri => contents.get(uri.toString()) ?? 'This retained inspection is no longer open. Use Robotics: Recovery Center to inspect current receipts.' });
  const closed = api.workspace.onDidCloseTextDocument(document => { if (document.uri.scheme === scheme) contents.delete(document.uri.toString()); });
  return {
    pick: async (items, title, placeHolder) => api.window.showQuickPick(items, { title, placeHolder, matchOnDescription: true, matchOnDetail: true }),
    inspect: async (title, content) => {
      const uri = api.Uri.from({ scheme, path: `/${randomUUID()}/${safeLabel(title)}.json` });
      contents.set(uri.toString(), content);
      try { await api.window.showTextDocument(await api.workspace.openTextDocument(uri), { preview: true, preserveFocus: false }); }
      catch (error) { contents.delete(uri.toString()); throw error; }
    },
    path: async (title, value, existing) => existing
      ? (await api.window.showOpenDialog({ title, defaultUri: api.Uri.file(value), canSelectFiles: false, canSelectFolders: true, canSelectMany: false }))?.[0].fsPath
      : api.window.showInputBox({ title, prompt: 'Absolute local path for a new or empty directory', value, validateInput: input => isAbsolute(input) && !/^\\\\|^\/\//.test(input) ? undefined : 'Enter an absolute local directory path.' }),
    saveFile: async (title, value) => (await api.window.showSaveDialog({ title, defaultUri: api.Uri.file(value), filters: { JSON: ['json'] } }))?.fsPath,
    confirm: async (message, action, modal = true) => (modal ? await api.window.showWarningMessage(message, { modal: true }, action) : await api.window.showInformationMessage(message, action)) === action,
    input: async prompt => api.window.showInputBox({ title: 'Robotics: Acknowledge Stopped Uploader', prompt, validateInput: value => value.trim().length > 0 && value.length <= 2048 ? undefined : 'Enter an operator note of 1–2048 characters.' }),
    message: async message => { await api.window.showInformationMessage(message); },
    action: async action => { await api.commands.executeCommand(`roboticsWorkbench.${action}`); },
    dispose: () => { provider.dispose(); closed.dispose(); contents.clear(); }
  };
}
