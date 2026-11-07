import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative } from 'node:path';
import type { CadAssetStatus, CadExport, CadSnapshot, CadViewer, KicadExport, KicadPreview, KicadSnapshot, OperationReceipt, ProjectMethod, WorkbenchManifest } from '@robotics-workbench/contracts';
import { isCadSnapshot, isKicadSnapshot } from '@robotics-workbench/contracts';
import { isEngineeringRequest, isEngineeringState, type EngineeringScreen, type EngineeringViewState } from '@robotics-workbench/webviews';
import { reviewHash, reviewPath } from './review-files';
import type { AgentProject } from './agent-controller';

export interface EngineeringHost {
  project(): Promise<AgentProject>;
  request<T>(bound: AgentProject, method: ProjectMethod, params?: Record<string, unknown>, revision?: number): Promise<T>;
  wait(bound: AgentProject, receipt: OperationReceipt): Promise<OperationReceipt>;
}
const empty = (): EngineeringViewState => ({ schemaVersion: 1, trusted: vscode.workspace.isTrusted, loading: false, error: null, project: null, screen: 'schematic', mappingPath: null, schematic: null, cad: null, preview: null, notice: null });
const cadInputs = (asset: CadAssetStatus) => ['workbench.json', 'mechanical/assets.json', asset.scriptRelativePath, asset.parameterRelativePath, asset.environmentLockRelativePath, ...asset.localModulePaths, ...asset.dimensionEvidenceRefs.map(item => item.path)];
export class EngineeringController implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private state = empty();
  private actionError: string | null = null;
  private bound?: AgentProject;
  private sourcePath?: string;
  private busy = false;
  private disposed = false;
  private refreshing?: Promise<void>;
  private refreshAgain = false;
  private refreshTimer?: NodeJS.Timeout;
  private watchedPaths = new Set<string>();
  private readonly watchers = new Map<string, vscode.FileSystemWatcher>();
  private readonly seen = new Map<string, string>();
  private readonly disposables: vscode.Disposable[] = [];
  constructor(private readonly context: vscode.ExtensionContext, private readonly host: EngineeringHost) {
    this.disposables.push(vscode.workspace.onDidSaveTextDocument(document => {
      if (this.panel?.visible && document.uri.scheme === 'file' && this.watchedPaths.has(document.uri.fsPath.toLowerCase())) void this.refresh();
    }));
  }
  getState(): EngineeringViewState { return structuredClone(this.state); }
  async show(screen: EngineeringScreen = 'schematic'): Promise<void> {
    this.state.screen = screen;
    if (!this.panel) {
      this.seen.clear();
      const directory = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
      const panel = this.panel = vscode.window.createWebviewPanel('roboticsWorkbench.engineering', 'Engineering artifacts', vscode.ViewColumn.Active, { enableScripts: true, enableCommandUris: false, enableForms: false, localResourceRoots: [directory], retainContextWhenHidden: true });
      const asset = (name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(directory, name)), nonce = randomBytes(16).toString('hex');
      panel.webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${panel.webview.cspSource}; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';"><link rel="stylesheet" href="${asset('engineering.css')}"><title>Engineering artifacts</title></head><body><div id="root"></div><script nonce="${nonce}" src="${asset('engineering.js')}"></script></body></html>`;
      panel.webview.onDidReceiveMessage(value => { void this.handle(value); });
      panel.onDidDispose(() => { this.panel = undefined; });
    }
    this.panel.reveal(); await this.refresh();
  }
  private async publish(): Promise<void> { if (this.panel && isEngineeringState(this.state)) await this.panel.webview.postMessage({ schemaVersion: 1, type: 'state', state: this.state }); }
  private fail(error: unknown, inspection = false): void {
    const message = (error instanceof Error ? error.message : 'Engineering action failed; retained artifacts remain available.').slice(0, 4096);
    if (!inspection) this.actionError = message;
    this.state.error = [this.actionError, ...(inspection ? [message] : [])].filter(Boolean).join('\n').slice(0, 4096);
  }
  private watchSources(): void {
    if (!this.bound || this.disposed) return;
    const relativePaths = ['workbench.json', 'components/catalog.json', 'mechanical/assets.json', ...(this.state.mappingPath ? [this.state.mappingPath] : []), ...(this.sourcePath ? [this.sourcePath] : []), ...(this.state.cad?.assets.flatMap(cadInputs) ?? [])];
    const paths: string[] = [];
    for (const path of relativePaths) {
      // Invalid declared inputs are reported by their service and must not break unrelated source watchers.
      try { paths.push(reviewPath(this.bound.root, path, true)); } catch { /* Not authorized to watch this path. */ }
    }
    for (const generation of this.state.schematic?.generations ?? []) paths.push(generation.nativePath);
    if (this.sourcePath) {
      const source = reviewPath(this.bound.root, this.sourcePath, true);
      paths.push(...['sym-lib-table', 'Workbench.kicad_sym', `${basename(source, '.kicad_sch')}.kicad_pro`].map(name => `${dirname(source)}/${name}`));
    }
    this.watchedPaths = new Set(paths.map(path => vscode.Uri.file(path).fsPath.toLowerCase()));
    const directories = new Set(paths.map(path => dirname(path)));
    for (const [directory, watcher] of this.watchers) if (!directories.has(directory)) { watcher.dispose(); this.watchers.delete(directory); }
    for (const directory of directories) if (!this.watchers.has(directory)) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(directory), '*'));
      const changed = (uri: vscode.Uri) => {
        if (!this.watchedPaths.has(uri.fsPath.toLowerCase())) return;
        if (this.state.preview) this.state.preview.stale = true;
        this.state.schematic?.generations.forEach(item => { item.stale = true; });
        this.state.cad?.assets.forEach(item => { item.stale = true; });
        void this.publish();
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        if (this.panel?.visible) this.refreshTimer = setTimeout(() => { this.refreshTimer = undefined; void this.refresh(); }, 150);
      };
      watcher.onDidChange(changed); watcher.onDidCreate(changed); watcher.onDidDelete(changed); this.watchers.set(directory, watcher);
    }
  }
  refresh(): Promise<void> {
    if (this.refreshing) { this.refreshAgain = true; return this.refreshing; }
    this.refreshing = (async () => {
      do { this.refreshAgain = false; await this.refreshOnce(); } while (this.refreshAgain && !this.disposed);
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async refreshOnce(): Promise<void> {
    try {
      if (!vscode.workspace.isTrusted) { this.state = { ...empty(), screen: this.state.screen }; return; }
      this.bound ??= await this.host.project();
      const snapshot = await this.host.request<{ manifest: WorkbenchManifest }>(this.bound, 'project.snapshot');
      this.bound.manifest = snapshot.manifest;
      const [schematicRead, cadRead] = await Promise.allSettled([
        this.host.request<unknown>(this.bound, 'kicad.snapshot', this.sourcePath ? { sourcePath: this.sourcePath } : {}).then(value => { if (!isKicadSnapshot(value) || value.projectRevision !== snapshot.manifest.projectRevision) throw Error('Schematic snapshot changed revision or exceeded its display contract. Refresh saved evidence.'); return value; }),
        this.host.request<unknown>(this.bound, 'cad.snapshot').then(value => { if (!isCadSnapshot(value) || value.projectRevision !== snapshot.manifest.projectRevision) throw Error('CAD snapshot changed revision or exceeded its display contract. Refresh saved evidence.'); return value; })
      ]);
      const errors: string[] = [];
      let schematic = this.state.schematic && structuredClone(this.state.schematic), cad = this.state.cad && structuredClone(this.state.cad);
      if (schematicRead.status === 'fulfilled') schematic = schematicRead.value;
      else {
        const reason = `KiCad inspection unavailable: ${schematicRead.reason instanceof Error ? schematicRead.reason.message : 'Refresh the saved schematic source.'}`;
        errors.push(reason); if (schematic) { schematic.readiness = { available: false, reason }; schematic.generations.forEach(item => { item.stale = true; }); }
      }
      if (cadRead.status === 'fulfilled') cad = cadRead.value;
      else {
        errors.push(`CAD inspection unavailable: ${cadRead.reason instanceof Error ? cadRead.reason.message : 'Repair mechanical/assets.json and refresh.'}`);
        if (cad) { cad.capabilities.configured = false; cad.assets.forEach(item => { item.stale = true; }); }
      }
      const next = { ...this.state, trusted: true, project: { projectId: snapshot.manifest.projectId, projectRevision: snapshot.manifest.projectRevision, name: snapshot.manifest.name }, schematic, cad, error: [this.actionError, ...errors].filter(Boolean).join('\n').slice(0, 4096) || null };
      if (next.preview) {
        const generation = schematic?.generations.find(item => item.generationId === next.preview?.generationId);
        if (!generation) next.preview = null;
        else next.preview = { ...next.preview, stale: generation.stale };
      }
      if (!isEngineeringState(next)) throw Error('Engineering snapshot exceeds the bounded view contract. The previous evidence was retained.');
      this.state = next;
      this.watchSources();
    } catch (error) { this.fail(error, true); }
    finally { await this.publish(); }
  }
  private clean(paths: string[]): void {
    if (!this.bound) throw Error('Select a project first.');
    for (const path of paths) {
      const full = reviewPath(this.bound.root, path);
      if (vscode.workspace.textDocuments.some(doc => doc.uri.scheme === 'file' && doc.uri.fsPath.toLowerCase() === full.toLowerCase() && doc.isDirty)) throw Error(`Save or reconcile the dirty ${path} buffer first. User and provider changes were preserved.`);
    }
  }
  private async choose(kind: 'mapping' | 'schematic'): Promise<void> {
    const picked = await vscode.window.showOpenDialog({ title: kind === 'mapping' ? 'Choose reviewed KiCad generation mapping' : 'Choose saved native KiCad schematic', defaultUri: vscode.Uri.file(this.bound!.root), canSelectMany: false, filters: kind === 'mapping' ? { Mapping: ['json'] } : { KiCad: ['kicad_sch'] } });
    if (!picked?.[0] || picked[0].scheme !== 'file') return;
    const path = relative(this.bound!.root, picked[0].fsPath).replaceAll('\\', '/'); reviewPath(this.bound!.root, path);
    if (kind === 'mapping') this.state.mappingPath = path; else this.sourcePath = path;
  }
  private async completed(receipt: OperationReceipt): Promise<OperationReceipt> {
    const result = await this.host.wait(this.bound!, receipt);
    if (result.status !== 'succeeded') throw Error(result.error?.message ?? `Generation ended as ${result.status}. Previous successful artifacts remain retained.`);
    return result;
  }
  async handle(value: unknown): Promise<void> {
    if (!isEngineeringRequest(value, this.state.project?.projectId ?? null)) return;
    const digest = reviewHash(JSON.stringify(value));
    if (this.seen.has(value.requestId)) {
      if (this.seen.get(value.requestId) !== digest) { this.fail(Error('Request ID reused with different inputs.')); await this.publish(); }
      else if (['ready', 'refresh'].includes(value.type) && this.refreshing) await this.refreshing;
      return;
    }
    if (this.seen.size >= 4096) { this.fail(Error('Reopen the engineering view to admit more requests.')); await this.publish(); return; }
    this.seen.set(value.requestId, digest);
    if (value.type === 'ready' || value.type === 'refresh') {
      if (value.type === 'refresh') { this.actionError = null; this.state.notice = null; }
      await this.refresh(); await this.publish(); return;
    }
    if (this.refreshing) await this.refreshing;
    if (this.busy) { this.fail(Error('Another engineering action is pending. Finish it before the next action.')); await this.publish(); return; }
    this.busy = true; this.state.loading = true; this.state.error = this.actionError; this.state.notice = null; await this.publish();
    try {
      if (!vscode.workspace.isTrusted || !this.bound || !this.state.project) throw Error('Trust and select a local project first.');
      const bound = this.bound, p = value.payload, revision = this.state.project.projectRevision;
      const generation = () => { const item = this.state.schematic?.generations.find(item => item.generationId === p.generationId); if (!item) throw Error('Refresh and select a retained schematic generation.'); return item; };
      const cadAsset = () => { const item = this.state.cad?.assets.find(item => item.assetId === p.assetId); if (!item) throw Error('Refresh and select a declared CAD asset.'); return item; };
      switch (value.type) {
        case 'screen': this.state.screen = p.screen as EngineeringScreen; break;
        case 'chooseMapping': await this.choose('mapping'); break;
        case 'chooseSchematic': await this.choose('schematic'); break;
        case 'generateSchematic': case 'validateSchematic': {
          const schematic = this.state.schematic;
          if (!schematic) throw Error('Inspect KiCad readiness first.');
          const source = schematic.source;
          this.clean(['workbench.json', ...(source ? [source.path] : []), ...(value.type === 'generateSchematic' && this.state.mappingPath ? [this.state.mappingPath] : [])]);
          const prefix = source && dirname(source.path) !== '.' ? `${dirname(source.path).replaceAll('\\', '/')}/` : '';
          this.clean(['components/catalog.json', ...(source ? [`${prefix}sym-lib-table`, `${prefix}Workbench.kicad_sym`, `${prefix}${basename(source.path, '.kicad_sch')}.kicad_pro`] : [])].filter(path => existsSync(reviewPath(bound.root, path, true))));
          if (value.type === 'generateSchematic' && !this.state.mappingPath) throw Error('Choose a reviewed generation mapping first.');
          if (value.type === 'validateSchematic' && !source?.sha256) throw Error('Choose a saved native schematic first.');
          const admitted = await this.host.request<OperationReceipt>(bound, value.type === 'generateSchematic' ? 'kicad.generate' : 'kicad.validate', value.type === 'generateSchematic' ? { mappingPath: this.state.mappingPath, expectedManifestSha256: schematic.manifestSha256, ...(source ? { sourcePath: source.path, expectedSourceSha256: source.sha256 } : {}) } : { sourcePath: source!.path, expectedSourceSha256: source!.sha256 }, revision);
          const result = await this.completed(admitted); await this.refresh();
          const id = result.result?.generationId;
          const next = this.state.schematic?.generations.find(item => item.generationId === id), sheet = next?.sheets[0];
          if (next && sheet) this.state.preview = await this.host.request<KicadPreview>(bound, 'kicad.preview', { generationId: next.generationId, sheetId: sheet.sheetId });
          break;
        }
        case 'previewSheet': { const item = generation(); if (!item.sheets.some(sheet => sheet.sheetId === p.sheetId)) throw Error('Sheet is outside the selected generation.'); this.state.preview = await this.host.request<KicadPreview>(bound, 'kicad.preview', p); break; }
        case 'openSchematic': {
          const item = generation();
          if (reviewHash(readFileSync(item.nativePath)) !== item.sourceSha256) throw Error('Retained schematic bytes changed; native handoff refused.');
          const opened = await vscode.env.openExternal(vscode.Uri.file(item.nativePath));
          this.state.notice = opened ? 'Staged native KiCad file handed to the configured OS application. Export to a new project-local directory before independent editing, then choose that saved schematic to check it. Launch does not establish validation.' : 'Native application handoff failed. Configure the .kicad_sch OS association to KiCad, then open the retained file explicitly.';
          break;
        }
        case 'exportSchematic': {
          generation(); this.clean(['workbench.json', ...(this.sourcePath ? [this.sourcePath] : [])]);
          const destination = await vscode.window.showSaveDialog({ title: 'Export native KiCad project into a new directory', defaultUri: vscode.Uri.file(`${bound.root}/kicad-export`) });
          if (!destination) break;
          const path = relative(bound.root, destination.fsPath).replaceAll('\\', '/');
          reviewPath(bound.root, path, true);
          if (destination.scheme !== 'file' || existsSync(destination.fsPath)) throw Error('Choose a new project-local directory. Existing native files were preserved.');
          const source = this.state.schematic?.source;
          const result = await this.host.request<KicadExport>(bound, 'kicad.export', { generationId: p.generationId, destinationPath: path, ...(source ? { sourcePath: source.path, expectedSourceSha256: source.sha256 } : {}) }, revision);
          this.state.notice = `Native export created at ${result.path}. ${result.files.length} files retain their exact SHA-256 identities. Source files were preserved.`;
          break;
        }
        case 'openCadSource': { const asset = cadAsset(); const path = p.source === 'script' ? asset.scriptRelativePath : asset.parameterRelativePath; await vscode.window.showTextDocument(vscode.Uri.file(reviewPath(bound.root, path)), { preview: false, viewColumn: vscode.ViewColumn.Beside }); break; }
        case 'generateCad': {
          const asset = cadAsset();
          this.clean(cadInputs(asset));
          if (!asset.currentFingerprint) throw Error('Resolve declared CAD input issues before generation.');
          await this.completed(await this.host.request<OperationReceipt>(bound, 'cad.generate', { assetId: asset.assetId, expectedFingerprint: asset.currentFingerprint, mode: p.mode, assumptions: p.assumptions }, revision)); break;
        }
        case 'exportCad': {
          const asset = cadAsset(); if (asset.lastGood?.operationId !== p.operationId) throw Error('Select the retained successful geometry receipt.');
          this.clean(cadInputs(asset));
          const result = await this.host.request<CadExport>(bound, 'cad.export', p);
          const bytes = readFileSync(result.path);
          if (reviewHash(bytes) !== result.sha256 || result.unit !== 'mm') throw Error('Selected CAD artifact failed digest or millimeter unit checks.');
          const approved = await vscode.window.showInformationMessage(`Export ${String(p.format).toUpperCase()} in millimeters (mm)`, { modal: true, detail: `SHA-256 ${result.sha256}\n${result.productionAllowed ? 'Production export permitted for the recorded dimensional evidence.' : 'Exploratory geometry only; physical fit is unverified.'}\n${asset.stale ? 'This artifact is outdated relative to current inputs.' : 'Review the exact recorded generation before manufacturing.'}` }, 'Export exact artifact');
          if (!approved) break;
          const destination = await vscode.window.showSaveDialog({ title: 'Save exact CAD artifact under a new filename', defaultUri: vscode.Uri.file(`${bound.root}/${basename(result.path)}.${String(p.format)}`), filters: { CAD: [String(p.format)] } });
          if (!destination) break;
          if (destination.scheme !== 'file' || existsSync(destination.fsPath) || vscode.workspace.textDocuments.some(doc => doc.uri.fsPath.toLowerCase() === destination.fsPath.toLowerCase() && doc.isDirty)) throw Error('Choose a new local filename. Existing buffers and files were preserved.');
          this.clean(cadInputs(asset));
          const current = await this.host.request<CadExport>(bound, 'cad.export', p);
          if (current.sha256 !== result.sha256 || current.unit !== result.unit || !current.productionAllowed) throw Error('CAD export applicability changed during review. Refresh and review the exact artifact again.');
          if (reviewHash(readFileSync(result.path)) !== result.sha256) throw Error('Selected output changed during review; refresh before export.');
          writeFileSync(destination.fsPath, bytes, { flag: 'wx' }); this.state.notice = `Exported exact ${String(p.format).toUpperCase()} artifact in mm: ${destination.fsPath}\nSHA-256 ${result.sha256}`; break;
        }
        case 'cadViewer': {
          const asset = cadAsset(); if (asset.lastGood?.operationId !== p.operationId) throw Error('Select a retained successful geometry receipt.');
          const handoff = await this.host.request<CadViewer>(bound, 'cad.viewer', p);
          await vscode.window.showTextDocument(vscode.Uri.file(handoff.path), { preview: false, viewColumn: vscode.ViewColumn.Beside });
          this.state.notice = ['Viewer handoff required. Valid geometry receipt remains unchanged.', ...handoff.instructions].join('\n').slice(0, 8192); break;
        }
      }
    } catch (error) { this.fail(error); }
    finally { await this.refresh(); this.busy = false; this.state.loading = false; await this.publish(); }
  }
  dispose(): void { this.disposed = true; this.panel?.dispose(); if (this.refreshTimer) clearTimeout(this.refreshTimer); for (const watcher of this.watchers.values()) watcher.dispose(); this.watchers.clear(); for (const disposable of this.disposables) disposable.dispose(); }
}
