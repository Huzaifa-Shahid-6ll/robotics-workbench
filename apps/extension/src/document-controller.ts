import * as vscode from 'vscode';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, relative } from 'node:path';
import type { DocumentExcerpt, OperationReceipt, ProjectMethod, WorkbenchManifest } from '@robotics-workbench/contracts';
import { isManifest } from '@robotics-workbench/contracts';
import { isDocumentViewRequest, isDocumentViewState, type DocumentLocation, type DocumentViewPage, type DocumentViewState } from '@robotics-workbench/webviews';
import { reviewHash, reviewPath, reviewText, minimalReviewEdit } from './review-files';
import type { AgentProject } from './agent-controller';

type Host = { project(): Promise<AgentProject>; request<T>(bound: AgentProject, method: ProjectMethod, params?: Record<string, unknown>, revision?: number): Promise<T>; wait(bound: AgentProject, receipt: OperationReceipt): Promise<OperationReceipt>; ask(citation: DocumentExcerpt): void };
const empty = (): DocumentViewState => ({ schemaVersion: 1, trusted: vscode.workspace.isTrusted, loading: false, error: null, project: null, documents: [], selection: null, page: null, results: [], query: '', queryTruncated: false });

export class DocumentController implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private state = empty();
  private bound?: AgentProject;
  private busy = false;
  private refreshing?: Promise<void>;
  private refreshAgain = false;
  private readonly seen = new Map<string, string>();
  constructor(private readonly context: vscode.ExtensionContext, private readonly host: Host) {}
  getState(): DocumentViewState { return structuredClone(this.state); }
  async reveal(citation: DocumentExcerpt): Promise<void> { await this.show(); await this.load({ documentId: citation.documentId, artifactSha256: citation.artifactSha256, extractorVersion: citation.extractorVersion, page: citation.page, ...(citation.region ? { region: citation.region } : {}), ...(citation.textRange ? { textRange: citation.textRange } : {}) }); await this.publish(); }
  async show(): Promise<void> {
    if (!this.panel) {
      this.seen.clear();
      const directory = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
      const panel = this.panel = vscode.window.createWebviewPanel('roboticsWorkbench.documents', 'Documents & Datasheets', vscode.ViewColumn.Active, { enableScripts: true, enableCommandUris: false, localResourceRoots: [directory], retainContextWhenHidden: true });
      const asset = (name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(directory, name)), nonce = randomBytes(16).toString('hex');
      panel.webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${panel.webview.cspSource}; style-src-attr 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none';"><link rel="stylesheet" href="${asset('documents.css')}"><title>Documents & Datasheets</title></head><body><div id="root"></div><script nonce="${nonce}" src="${asset('documents.js')}"></script></body></html>`;
      panel.webview.onDidReceiveMessage(value => { void this.handle(value); });
      panel.onDidDispose(() => { this.panel = undefined; });
    }
    this.panel.reveal(); await this.refresh();
  }
  private async publish(): Promise<void> { if (this.panel && isDocumentViewState(this.state)) await this.panel.webview.postMessage({ schemaVersion: 1, type: 'state', state: this.state }); }
  refresh(): Promise<void> {
    if (this.refreshing) { this.refreshAgain = true; return this.refreshing; }
    this.refreshing = (async () => {
      do { this.refreshAgain = false; await this.refreshOnce(); } while (this.refreshAgain);
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async refreshOnce(): Promise<void> {
    try {
      if (!vscode.workspace.isTrusted) { this.state = empty(); return; }
      this.bound ??= await this.host.project();
      const snapshot = await this.host.request<{ manifest: WorkbenchManifest }>(this.bound, 'project.snapshot');
      this.bound.manifest = snapshot.manifest;
      const documents = await this.host.request<DocumentViewState['documents']>(this.bound, 'document.list');
      const next = { ...this.state, project: { projectId: snapshot.manifest.projectId, projectRevision: snapshot.manifest.projectRevision, name: snapshot.manifest.name }, documents, trusted: true };
      if (!isDocumentViewState(next)) throw Error('Document list exceeds the bounded view contract. Existing view was retained.');
      this.state = next;
      if (this.state.selection) await this.load({ ...this.state.selection, ...(this.state.page?.citation.region ? { region: this.state.page.citation.region } : {}), ...(this.state.page?.citation.textRange ? { textRange: this.state.page.citation.textRange } : {}) });
    } catch (error) { this.fail(error); }
    finally { await this.publish(); }
  }
  private fail(error: unknown): void { this.state.error = (error instanceof Error ? error.message : 'Document action failed; originals remain retained.').slice(0, 4096); }
  private async load(citation: DocumentLocation & { region?: DocumentExcerpt['region']; textRange?: DocumentExcerpt['textRange'] }): Promise<void> {
    if (!this.bound) return;
    const page = await this.host.request<DocumentViewPage>(this.bound, 'document.page', { ...citation });
    const next = { ...this.state, selection: { documentId: citation.documentId, artifactSha256: citation.artifactSha256, extractorVersion: citation.extractorVersion, page: citation.page }, page };
    if (!isDocumentViewState(next)) throw Error('Page preview exceeded the bounded display contract. Original source was retained.');
    this.state = next;
  }
  async handle(value: unknown): Promise<void> {
    if (!isDocumentViewRequest(value, this.state.project?.projectId ?? null)) return;
    const digest = reviewHash(JSON.stringify(value));
    if (this.seen.has(value.requestId)) { if (this.seen.get(value.requestId) !== digest) { this.fail(Error('Request ID reused with different inputs.')); await this.publish(); } return; }
    if (this.seen.size >= 4096) { this.fail(Error('Reopen this document view to admit more requests.')); await this.publish(); return; }
    this.seen.set(value.requestId, digest);
    if (value.type === 'ready' || value.type === 'refresh') { if (value.type === 'refresh') this.state.error = null; await this.refresh(); return; }
    if (this.refreshing) await this.refreshing;
    if (this.busy) { this.fail(Error('Another document action is pending. Finish it before the next action.')); await this.publish(); return; }
    this.busy = true; this.state.loading = true; this.state.error = null; await this.publish();
    try {
      if (!vscode.workspace.isTrusted || !this.bound || !this.state.project) throw Error('Trust and select a local project first.');
      const bound = this.bound, p = value.payload;
      switch (value.type) {
        case 'selectDocument': {
          const doc = this.state.documents.find(item => item.documentId === p.documentId);
          const version = doc?.versions.filter(item => item.status !== 'extraction-failed').at(-1);
          if (version) await this.load({ documentId: doc!.documentId, artifactSha256: version.artifactSha256, extractorVersion: version.extractorVersion, page: 1 });
          else { this.state.selection = null; this.state.page = null; } break;
        }
        case 'ingest': {
          const document = this.state.documents.find(item => item.documentId === p.documentId);
          if (!document?.currentSha256) throw Error('The declared saved source is unavailable. Historical originals remain retained.');
          const path = reviewPath(bound.root, document.path);
          if (vscode.workspace.textDocuments.some(doc => doc.uri.scheme === 'file' && doc.uri.fsPath.toLowerCase() === path.toLowerCase() && doc.isDirty)) throw Error('Save or reconcile the dirty source buffer before indexing.');
          const admitted = await this.host.request<OperationReceipt>(bound, 'document.ingest', { documentId: p.documentId, expectedSha256: document.currentSha256 }, this.state.project.projectRevision);
          const completed = await this.host.wait(bound, admitted);
          if (completed.status !== 'succeeded') throw Error(completed.error?.message ?? `Document indexing ended as ${completed.status}.`);
          await this.refresh();
          const version = this.state.documents.find(doc => doc.documentId === p.documentId)?.versions.at(-1);
          if (version && version.status !== 'extraction-failed') await this.load({ documentId: String(p.documentId), artifactSha256: version.artifactSha256, extractorVersion: version.extractorVersion, page: 1 });
          break;
        }
        case 'search': {
          const result = await this.host.request<{ excerpts: DocumentExcerpt[]; omitted: number }>(bound, 'document.query', { query: p.query, ...(p.documentId ? { documentIds: [p.documentId] } : {}), limit: 20 });
          this.state.query = String(p.query); this.state.results = result.excerpts; this.state.queryTruncated = result.omitted > 0; break;
        }
        case 'page': await this.load(p as unknown as DocumentLocation); break;
        case 'navigate': case 'ask': {
          const supplied = p.citation as DocumentExcerpt;
          const location = { documentId: supplied.documentId, artifactSha256: supplied.artifactSha256, extractorVersion: supplied.extractorVersion, page: supplied.page, ...(supplied.region ? { region: supplied.region } : {}), ...(supplied.textRange ? { textRange: supplied.textRange } : {}) };
          if (value.type === 'navigate') await this.load(location);
          else {
            const exact = await this.host.request<DocumentExcerpt>(bound, 'document.excerpt', location);
            if (Object.keys(exact).length !== Object.keys(supplied).length || Object.entries(exact).some(([key, field]) => JSON.stringify(field) !== JSON.stringify(supplied[key as keyof DocumentExcerpt]))) throw Error('The selected excerpt differs from its exact retained citation; select it again.');
            this.host.ask(structuredClone(exact));
          } break;
        }
        case 'openOriginal': {
          const original = await this.host.request<{ path: string; sha256: string; mediaType: string }>(bound, 'document.original', p);
          const bytes = readFileSync(original.path);
          if (createHash('sha256').update(bytes).digest('hex') !== original.sha256 || original.sha256 !== p.artifactSha256) throw Error('Retained original failed exact hash verification.');
          const extension = original.mediaType === 'application/pdf' ? 'pdf' : 'txt';
          const destination = await vscode.window.showSaveDialog({ title: 'Save an exact copy of the retained original', defaultUri: vscode.Uri.file(`${bound.root}/${original.sha256}.${extension}`), filters: { Original: [extension] } });
          if (!destination) return;
          if (destination.scheme !== 'file' || existsSync(destination.fsPath)) throw Error('Select a new local filename; existing files were preserved.');
          writeFileSync(destination.fsPath, bytes, { flag: 'wx' });
          await vscode.commands.executeCommand('vscode.open', destination); break;
        }
      }
    } catch (error) { this.fail(error); }
    finally { await this.refresh(); this.busy = false; this.state.loading = false; await this.publish(); }
  }
  async attach(): Promise<void> {
    const bound = await this.host.project();
    const picked = await vscode.window.showOpenDialog({ title: 'Attach an existing project-local document', defaultUri: vscode.Uri.file(bound.root), canSelectMany: false, filters: { Documents: ['pdf', 'txt', 'md'] } });
    if (!picked?.[0] || picked[0].scheme !== 'file') return;
    const path = relative(bound.root, picked[0].fsPath).replaceAll('\\', '/');
    reviewPath(bound.root, path);
    const disk = reviewText(bound.root, 'workbench.json'); if (!disk) throw Error('Project manifest is unavailable.');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(reviewPath(bound.root, 'workbench.json')));
    const version = document.version, before = document.getText();
    if (document.isDirty || reviewHash(before) !== disk.sha256) throw Error('Save or reconcile the manifest before attaching a document.');
    const manifest = JSON.parse(before) as WorkbenchManifest;
    if (manifest.documents.some(item => item.path === path)) { await this.show(); return; }
    manifest.documents.push({ documentId: randomUUID(), path, title: basename(path) }); manifest.projectRevision++;
    if (!isManifest(manifest)) throw Error('Attachment would exceed the manifest contract.');
    const next = (JSON.stringify(manifest, null, 2) + '\n').replace(/\r?\n/g, document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
    const editor = await vscode.window.showTextDocument(document, { preserveFocus: true }), delta = minimalReviewEdit(before, next);
    if (document.version !== version || document.isDirty || reviewText(bound.root, 'workbench.json')?.sha256 !== disk.sha256) throw Error('Concurrent manifest edit was preserved; refresh before attaching.');
    if (!await editor.edit(edit => edit.replace(new vscode.Range(document.positionAt(delta.start), document.positionAt(delta.end)), delta.text))) throw Error('Native manifest patch conflicted.');
    if (document.getText() !== next || reviewText(bound.root, 'workbench.json')?.sha256 !== disk.sha256) throw Error('Concurrent source was preserved in the native buffer and disk. Reconcile before saving.');
    if (!await document.save() || document.isDirty || document.getText() !== next || reviewText(bound.root, 'workbench.json')?.sha256 !== reviewHash(next)) throw Error('Attachment save was not confirmed. Inspect the native manifest before continuing.');
    await this.show();
  }
  dispose(): void { this.panel?.dispose(); }
}
