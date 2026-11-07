import * as vscode from 'vscode';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { PreparedWiringPlan, ReviewSnapshotV1, WiringOperation, WiringSnapshotData, WiringViewRequest, WiringViewState } from '@robotics-workbench/contracts';
import { isWiringViewRequest, isWiringViewState } from '@robotics-workbench/webviews';
import type { AgentControllerHost, AgentProject } from './agent-controller';
import { minimalReviewEdit, reviewHash, reviewPath, reviewText } from './review-files';

const empty = (): WiringViewState => ({ schemaVersion: 1, trusted: vscode.workspace.isTrusted, loading: false, error: null, project: null, manifest: null, catalog: [], pins: {}, rules: [], confirmations: [], layout: { revision: 0, sha256: null, positions: {} }, selection: null, preview: null });
const serialize = (value: unknown, baseline: string) => JSON.stringify(value, null, baseline.match(/\n([ \t]+)"/)?.[1] ?? '  ').replaceAll('\n', baseline.includes('\r\n') ? '\r\n' : '\n') + (baseline.endsWith('\n') ? baseline.includes('\r\n') ? '\r\n' : '\n' : '');
type Host = Pick<AgentControllerHost, 'project' | 'request'> & { ask(selection: { kind: 'component' | 'net'; id: string; revision: number }): void };

/** Design edits use the same native text buffers as hand edits; the frame only sends bounded intents. */
export class WiringController implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private state = empty();
  private bound?: AgentProject;
  private plan?: { value: PreparedWiringPlan; version: number };
  private last?: { inverse: WiringOperation[]; sha256: string };
  private readonly seen = new Map<string, string>();
  private timer?: NodeJS.Timeout;
  private acting = false;
  private refreshing?: Promise<void>;
  private refreshAgain = false;
  private sourceValid = false;
  private disposed = false;
  private readonly listeners: vscode.Disposable[] = [];
  constructor(private readonly context: vscode.ExtensionContext, private readonly host: Host) {
    this.listeners.push(vscode.window.onDidChangeTextEditorSelection(event => {
      if (!this.bound || !this.state.manifest) return;
      const bindings = this.state.manifest.codeBindings.filter(binding => { try { return vscode.Uri.file(reviewPath(this.bound!.root, binding.path, true)).toString() === event.textEditor.document.uri.toString() && binding.line === event.selections[0]?.active.line + 1; } catch { return false; } });
      if (bindings.length === 1) { this.state.selection = { kind: 'component', id: bindings[0]!.componentId }; void this.publish(); }
      else if (bindings.length > 1) { this.state.error = 'This code location has several explicit component bindings. Select the intended component in the table; no target was guessed.'; void this.publish(); }
    }));
  }
  getState(): WiringViewState { return structuredClone(this.state); }
  async show(): Promise<void> {
    if (this.disposed) return;
    if (!this.panel) {
      this.seen.clear();
      const directory = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
      const panel = this.panel = vscode.window.createWebviewPanel('roboticsWorkbench.wiring', 'Components & Wiring', vscode.ViewColumn.Active, { enableScripts: true, enableCommandUris: false, enableForms: false, localResourceRoots: [directory], retainContextWhenHidden: true });
      const asset = (name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(directory, name)).toString();
      const nonce = randomBytes(16).toString('hex');
      // React Flow sets bounded position styles; scripts and network remain restricted to this bundle.
      panel.webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${panel.webview.cspSource}; style-src-attr 'unsafe-inline'; font-src ${panel.webview.cspSource}; connect-src 'none'; base-uri 'none'; form-action 'none';"><link rel="stylesheet" href="${asset('wiring.css')}"><title>Components & Wiring</title></head><body><div id="root"></div><script nonce="${nonce}" src="${asset('wiring.js')}"></script></body></html>`;
      this.listeners.push(panel.webview.onDidReceiveMessage(value => { void this.handle(value); }), panel.onDidChangeViewState(() => this.poll()), panel.onDidDispose(() => { this.panel = undefined; this.poll(); }));
    }
    this.panel.reveal(); this.poll(); await this.refresh();
  }
  private poll(): void {
    if (this.timer) clearInterval(this.timer); this.timer = undefined;
    if (this.panel?.visible) this.timer = setInterval(() => { if (!this.acting) void this.refresh(); }, 1500);
  }
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.refreshing) { this.refreshAgain = true; return this.refreshing; }
    this.refreshing = (async () => {
      do { this.refreshAgain = false; await this.refreshOnce(); } while (this.refreshAgain && !this.disposed);
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async refreshOnce(): Promise<void> {
    try {
      if (!vscode.workspace.isTrusted) { this.state = empty(); return; }
      this.bound ??= await this.host.project();
      const data = await this.host.request<WiringSnapshotData>(this.bound, 'wiring.snapshot');
      const selection = this.state.selection && (this.state.selection.kind === 'component' ? data.manifest.components.some(c => c.componentId === this.state.selection!.id) : data.manifest.nets.some(n => n.netId === this.state.selection!.id)) ? this.state.selection : null;
      const next: WiringViewState = { ...this.state, ...data, schemaVersion: 1, trusted: true, project: { projectId: data.manifest.projectId, projectRevision: data.manifest.projectRevision, name: data.manifest.name, manifestSha256: data.manifestSha256 }, selection };
      // Hash is transport metadata, not another mutable authority in view state.
      delete (next as unknown as Record<string, unknown>).manifestSha256;
      if (!isWiringViewState(next)) throw Error('Design state exceeds the supported preview contract. Inspect the ordinary manifest/catalog; existing view content was retained.');
      this.state = next; this.bound.manifest = data.manifest; this.sourceValid = true;
    } catch (error) { this.sourceValid = false; this.state.error = `Last valid design shown read-only. ${this.message(error)}`.slice(0, 4096); }
    finally { await this.publish(); }
  }
  private message(error: unknown): string { return (error instanceof Error ? error.message : 'Design action failed. Inspect source before retrying.').slice(0, 4096); }
  private async publish(): Promise<void> { if (this.panel?.visible && isWiringViewState(this.state)) await this.panel.webview.postMessage({ schemaVersion: 1, type: 'state', state: this.state }); }
  async handle(value: unknown): Promise<void> {
    if (this.disposed || !isWiringViewRequest(value, this.state.project?.projectId ?? null)) return;
    const digest = reviewHash(JSON.stringify(value));
    if (this.seen.has(value.requestId)) { if (this.seen.get(value.requestId) !== digest) { this.state.error = 'Request ID reused with changed inputs.'; await this.publish(); } return; }
    if (this.seen.size >= 4096) { this.state.error = 'Reopen this editor to admit more requests.'; await this.publish(); return; }
    this.seen.set(value.requestId, digest);
    if (value.type === 'ready' || value.type === 'refresh') { this.state.error = null; await this.refresh(); return; }
    if (this.acting) { this.state.error = 'Another design action is pending. Your draft is retained.'; await this.publish(); return; }
    if (!vscode.workspace.isTrusted || !this.bound || !this.state.project || !this.state.manifest) return;
    if (!this.sourceValid && !['select', 'openManifest', 'openCatalog', 'openCode', 'openDocument'].includes(value.type)) { this.state.error = 'Design/catalog input is invalid. Repair the ordinary source and refresh before applying changes.'; await this.publish(); return; }
    this.acting = true; this.state.loading = true; this.state.error = null;
    const bound = this.bound, snapshot = structuredClone(this.state), request = value;
    await this.publish();
    try {
      const p = request.payload;
      switch (request.type) {
        case 'select': {
          const kind = p.kind as 'component' | 'net', id = String(p.id);
          if (!(kind === 'component' ? snapshot.manifest!.components.some(c => c.componentId === id) : snapshot.manifest!.nets.some(n => n.netId === id))) throw Error('Selection is absent from the current design.');
          this.state.selection = { kind, id }; break;
        }
        case 'propose': await this.prepare(bound, p.operations as WiringOperation[], snapshot); break;
        case 'commit': await this.commit(bound, String(p.previewId)); break;
        case 'discard': this.plan = undefined; this.state.preview = null; break;
        case 'undo':
          if (!this.last || this.last.sha256 !== snapshot.project!.manifestSha256) throw Error('Undo requires the exact last accepted design bytes. Preserve later edits and reconcile them in the native editor.');
          await this.prepare(bound, this.last.inverse, snapshot); break;
        case 'layout': await this.layout(bound, p.positions as WiringViewState['layout']['positions'], snapshot); break;
        case 'ask': if (!snapshot.selection) throw Error('Select a component or net first.'); this.host.ask({ ...snapshot.selection, revision: snapshot.project!.projectRevision }); break;
        case 'observe': await this.observe(bound, snapshot); break;
        case 'openCode': {
          const binding = snapshot.manifest!.codeBindings.find(b => b.bindingId === p.bindingId); if (!binding) throw Error('Code binding is unavailable.');
          const document = await vscode.workspace.openTextDocument(vscode.Uri.file(reviewPath(bound.root, binding.path)));
          if (binding.line && binding.line > document.lineCount) throw Error('The explicit code binding line is stale; reconcile it before navigation.');
          await vscode.window.showTextDocument(document, binding.line ? { selection: new vscode.Range(binding.line - 1, 0, binding.line - 1, 0) } : {}); break;
        }
        case 'openDocument': {
          const document = snapshot.manifest!.documents.find(d => d.documentId === p.documentId); if (!document) throw Error('Document reference is unavailable.');
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(reviewPath(bound.root, document.path))); break;
        }
        case 'openManifest': await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(reviewPath(bound.root, 'workbench.json')))); break;
        case 'openCatalog': {
          const path = reviewPath(bound.root, 'components/catalog.json', true);
          if (!existsSync(path)) {
            const edit = new vscode.WorkspaceEdit(); edit.createFile(vscode.Uri.file(path), { ignoreIfExists: false }); edit.insert(vscode.Uri.file(path), new vscode.Position(0, 0), '{\n  "schemaVersion": 1,\n  "definitions": []\n}\n');
            if (!await vscode.workspace.applyEdit(edit)) throw Error('Catalog creation conflicted with another edit.');
          }
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(path))); break;
        }
      }
    } catch (error) { this.state.error = this.message(error); }
    finally { await this.refresh(); this.acting = false; this.state.loading = false; await this.publish(); }
  }
  private async document(bound: AgentProject, path: string, expected: string | null): Promise<vscode.TextDocument> {
    const disk = reviewText(bound.root, path), uri = vscode.Uri.file(reviewPath(bound.root, path, true));
    if ((disk?.sha256 ?? null) !== expected) throw Error('Saved source changed; preserve the draft and refresh the preview.');
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.isDirty || reviewHash(document.getText()) !== (disk?.sha256 ?? reviewHash(''))) throw Error('Native editor contains other changes. Save or reconcile them before applying this design.');
    return document;
  }
  private async prepare(bound: AgentProject, operations: WiringOperation[], snapshot: WiringViewState): Promise<void> {
    const document = await this.document(bound, 'workbench.json', snapshot.project!.manifestSha256);
    const version = document.version;
    const plan = await this.host.request<PreparedWiringPlan>(bound, 'wiring.plan', { expectedManifestSha256: snapshot.project!.manifestSha256, operations }, snapshot.project!.projectRevision);
    if (document.version !== version || document.isDirty || reviewText(bound.root, 'workbench.json')?.sha256 !== plan.manifestSha256) throw Error('Source changed during preview. Both source and draft were preserved.');
    this.plan = { value: plan, version }; this.state.preview = { previewId: plan.previewId, changes: plan.changes, rules: plan.rules, confirmationInvalidated: plan.confirmationInvalidated };
  }
  private async replace(bound: AgentProject, path: string, document: vscode.TextDocument, before: string, next: string, version: number): Promise<void> {
    if (document.version !== version || document.isDirty || document.getText() !== before) throw Error('A concurrent native edit prevents this patch.');
    if (reviewText(bound.root, path)?.sha256 !== reviewHash(before)) throw Error('External source changed before apply; both versions were preserved.');
    const delta = minimalReviewEdit(before, next), editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
    if (document.version !== version || document.isDirty || reviewText(bound.root, path)?.sha256 !== reviewHash(before)) throw Error('Source changed while preparing the native editor.');
    if (!await editor.edit(builder => builder.replace(new vscode.Range(document.positionAt(delta.start), document.positionAt(delta.end)), delta.text), { undoStopBefore: true, undoStopAfter: true })) throw Error('Native editor rejected the design patch.');
    if (document.getText() !== next) throw Error('Another editor changed this file during apply. Both versions are retained; reconcile the native buffer.');
    if (reviewText(bound.root, path)?.sha256 !== reviewHash(before)) throw Error('External source changed during apply. The proposed native buffer and external bytes were preserved; reconcile before saving.');
    if (!await document.save()) throw Error('Design patch remains in the native editor; save failed. No acceptance was recorded.');
    if (document.isDirty || document.getText() !== next) throw Error('Source changed during save; no acceptance was recorded.');
  }
  private async commit(bound: AgentProject, previewId: string): Promise<void> {
    const prepared = this.plan;
    if (!prepared || prepared.value.previewId !== previewId) throw Error('Preview expired. Review a fresh patch.');
    const plan = prepared.value;
    if (plan.rules.some(rule => rule.severity === 'error' && rule.outcome === 'fail')) throw Error('Known design errors block acceptance. Resolve the reported rules first.');
    const document = await this.document(bound, 'workbench.json', plan.manifestSha256);
    if (document.version !== prepared.version) throw Error('Native document changed after preview; prepare a fresh patch.');
    await this.host.request(bound, 'wiring.check', { previewId, expectedManifestSha256: plan.manifestSha256 }, plan.expectedProjectRevision);
    if (plan.next.projectRevision === plan.expectedProjectRevision) {
      await this.host.request(bound, 'wiring.accept', { previewId, manifestSha256: plan.manifestSha256 }, plan.expectedProjectRevision);
      this.plan = undefined; this.state.preview = null; return;
    }
    const before = document.getText(), next = serialize(plan.next, before).replace(/\r?\n/g, document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
    if (Buffer.byteLength(before) > 128 * 1024 || Buffer.byteLength(next) > 128 * 1024) throw Error('Design exceeds the bounded native review size; edit and review its ordinary source explicitly.');
    const retained: ReviewSnapshotV1 = { schemaVersion: 1, taskId: previewId, root: bound.root, files: [{ id: randomUUID(), path: 'workbench.json', baselineText: before, baselineSha256: reviewHash(before), baselineHost: { version: document.version, dirty: false, textSha256: reviewHash(before) }, proposedText: next, effect: 'proposed', conflict: null }], omitted: [] };
    await this.host.request(bound, 'review.save', { taskId: previewId, snapshot: retained });
    await this.host.request(bound, 'wiring.check', { previewId, expectedManifestSha256: plan.manifestSha256 }, plan.expectedProjectRevision);
    await this.document(bound, 'workbench.json', plan.manifestSha256);
    await this.replace(bound, 'workbench.json', document, before, next, prepared.version);
    const saved = reviewText(bound.root, 'workbench.json');
    if (!saved || saved.sha256 !== reviewHash(next)) throw Error('External write raced the save. Acceptance was not recorded; retained baseline/proposal remain available.');
    try { await this.host.request(bound, 'wiring.accept', { previewId, manifestSha256: saved.sha256 }, plan.next.projectRevision); }
    catch (error) { throw Error(`Design bytes were saved; history acceptance was not confirmed. Inspect the saved manifest and retained preview before another edit. ${this.message(error)}`); }
    this.last = { inverse: plan.inverseOperations, sha256: saved.sha256 }; this.plan = undefined; this.state.preview = null;
  }
  private async layout(bound: AgentProject, positions: WiringViewState['layout']['positions'], snapshot: WiringViewState): Promise<void> {
    if (Object.keys(positions).some(id => !snapshot.manifest!.components.some(c => c.componentId === id))) throw Error('Layout references an absent component.');
    const path = '.workbench-layout.json', disk = reviewText(bound.root, path);
    if ((disk?.sha256 ?? null) !== snapshot.layout.sha256) throw Error('Layout changed in another editor. Refresh before moving components.');
    const before = disk?.text ?? '', previous = disk ? JSON.parse(before) : { schemaVersion: 1, revision: 0, positions: {} };
    let next = serialize({ ...previous, revision: snapshot.layout.revision + 1, positions: { ...previous.positions, ...positions } }, before || '\n');
    if (!disk) {
      const uri = vscode.Uri.file(reviewPath(bound.root, path, true));
      if (vscode.workspace.textDocuments.some(doc => doc.uri.toString() === uri.toString() && doc.isDirty)) throw Error('A dirty layout buffer must be reconciled first.');
      const edit = new vscode.WorkspaceEdit(); edit.createFile(uri, { ignoreIfExists: false });
      if (!await vscode.workspace.applyEdit(edit)) throw Error('Layout creation conflicted.');
      const doc = await vscode.workspace.openTextDocument(uri);
      next = next.replace(/\r?\n/g, doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
      await this.replace(bound, path, doc, '', next, doc.version);
    } else { const doc = await this.document(bound, path, snapshot.layout.sha256); next = next.replace(/\r?\n/g, doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n'); await this.replace(bound, path, doc, before, next, doc.version); }
  }
  private async observe(bound: AgentProject, snapshot: WiringViewState): Promise<void> {
    if (!snapshot.selection) throw Error('Select the exact component or net being reported.');
    const procedure = await vscode.window.showInputBox({ title: 'Report a wiring observation', prompt: 'Describe the actual procedure you performed. This records a user report, not an inferred measurement.', validateInput: value => value.trim() && value.length <= 2048 ? null : 'Enter a procedure of at most 2048 characters.' }); if (!procedure) return;
    const note = await vscode.window.showInputBox({ title: 'Observation evidence', prompt: 'Record what you observed, including instrument or uncertainty when relevant.', validateInput: value => value.trim() && value.length <= 4096 ? null : 'Enter evidence of at most 4096 characters.' }); if (!note) return;
    const result = await vscode.window.showQuickPick(['inconclusive', 'passed', 'failed'], { title: 'Reported result', placeHolder: 'This does not assert measured electrical safety' }); if (!result) return;
    await this.host.request(bound, 'wiring.observe', { subjectIds: [snapshot.selection.id], procedure, note, result, observedAt: new Date().toISOString(), expectedManifestSha256: snapshot.project!.manifestSha256 }, snapshot.project!.projectRevision);
  }
  dispose(): void { this.disposed = true; if (this.timer) clearInterval(this.timer); for (const listener of this.listeners) listener.dispose(); this.panel?.dispose(); }
}
