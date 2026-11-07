import { createHash, randomBytes } from 'node:crypto';
import type * as vscode from 'vscode';
import type { WorkbenchViewRequest, WorkbenchViewState } from '@robotics-workbench/contracts';
import { isWorkbenchViewRequest, isWorkbenchViewState } from '@robotics-workbench/webviews';

export { isWorkbenchViewRequest, isWorkbenchViewState, isWorkbenchViewResponse } from '@robotics-workbench/webviews';
export interface AgentViewCallbacks {
  getState(): WorkbenchViewState;
  onRequest(request: WorkbenchViewRequest): void | Promise<void>;
  onVisibility?(visible: boolean): void;
}
const attribute = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export function agentViewHtml(cspSource: string, nonce: string, scriptUri: string, styleUri: string): string {
  if (!/^[a-f0-9]{32}$/.test(nonce)) throw Error('Invalid webview nonce.');
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${attribute(cspSource)}; font-src ${attribute(cspSource)}; connect-src 'none'; base-uri 'none'; form-action 'none';"><link rel="stylesheet" href="${attribute(styleUri)}"><title>Robotics Agent</title></head><body><div id="root"></div><script nonce="${nonce}" src="${attribute(scriptUri)}"></script></body></html>`;
}

/** The view owns presentation/listeners only; hiding or disposing it never cancels a task. */
export class AgentViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private listeners: vscode.Disposable[] = [];
  private readonly seen = new Map<string, string>();
  private disposed = false;
  constructor(private readonly extensionUri: vscode.Uri, private readonly callbacks: AgentViewCallbacks) {}
  get visible(): boolean { return !this.disposed && !!this.view?.visible; }
  resolveWebviewView(view: vscode.WebviewView): void {
    if (this.disposed) return;
    this.releaseListeners(); this.view = view;
    const directory = this.extensionUri.with({ path: this.extensionUri.path.replace(/\/$/, '') + '/dist' });
    view.webview.options = { enableScripts: true, enableCommandUris: false, enableForms: false, localResourceRoots: [directory] };
    const asset = (name: string) => view.webview.asWebviewUri(directory.with({ path: `${directory.path}/${name}` })).toString();
    view.webview.html = agentViewHtml(view.webview.cspSource, randomBytes(16).toString('hex'), asset('agent.js'), asset('agent.css'));
    this.listeners = [view.webview.onDidReceiveMessage((value: unknown) => { void this.receive(view, value).catch(() => {}); }),
      view.onDidChangeVisibility(() => { if (this.view === view) { this.callbacks.onVisibility?.(view.visible); if (view.visible) void this.update(this.callbacks.getState()).catch(() => {}); } }),
      view.onDidDispose(() => { if (this.view === view) { this.view = undefined; this.releaseListeners(); this.callbacks.onVisibility?.(false); } })];
    this.callbacks.onVisibility?.(view.visible);
  }
  async update(state: WorkbenchViewState): Promise<boolean> {
    if (!isWorkbenchViewState(state)) throw Error('Invalid or oversized agent view state.');
    if (!this.visible || !this.view) return false;
    return this.view.webview.postMessage({ schemaVersion: 1, type: 'state', state });
  }
  reveal(preserveFocus = false): void { this.view?.show(preserveFocus); }
  private async receive(view: vscode.WebviewView, value: unknown): Promise<void> {
    if (this.disposed || this.view !== view) return;
    const state = this.callbacks.getState();
    if (!isWorkbenchViewState(state) || !isWorkbenchViewRequest(value, state.project?.projectId ?? null)) return;
    if (!this.inScope(value, state)) return;
    const hash = createHash('sha256').update(JSON.stringify(value)).digest('hex');
    if (this.seen.has(value.requestId)) { if (this.seen.get(value.requestId) !== hash) await this.update({ ...state, error: 'A request ID was reused with different inputs. Refresh the view before continuing.' }); return; }
    if (this.seen.size >= 4096) { await this.update({ ...state, error: 'View request limit reached. Reopen the workspace to establish a fresh view connection.' }); return; }
    this.seen.set(value.requestId, hash);
    try {
      await this.callbacks.onRequest(value);
      if (this.view === view) await this.update(this.callbacks.getState());
    } catch {
      if (this.view === view) await this.update({ ...this.callbacks.getState(), error: 'The requested action failed. Refresh state and inspect the host output before repeating an effect.' });
    }
  }
  private inScope(request: WorkbenchViewRequest, state: WorkbenchViewState): boolean {
    if (!state.trusted && (['send', 'stop', 'reconcile', 'approval', 'authorizeUpload'].includes(request.type) || request.type === 'review' && request.payload.action !== 'diff')) return false;
    if (['stop', 'reconcile', 'approval', 'handoff', 'authorizeUpload'].includes(request.type) && !state.task) return false;
    if (request.type === 'selectTask') return state.tasks.some(task => task.taskId === request.payload.taskId);
    if (request.type === 'pin' || request.type === 'openEvidence') return state.context.some(item => item.id === request.payload.id);
    if (request.type === 'approval') return !!state.task?.pendingApprovals.some(item => item.approvalId === request.payload.approvalId && item.expectedProjectRevision === state.project?.projectRevision && Date.parse(item.expiresAt) > Date.now());
    if (request.type === 'review') return state.changes.some(item => item.id === request.payload.id && (request.payload.action === 'diff' || item.effect === 'proposed' && ['apply', 'dismiss'].includes(String(request.payload.action)) || item.effect === 'written' && ['keep', 'revert'].includes(String(request.payload.action))));
    return true;
  }
  private releaseListeners(): void { for (const listener of this.listeners.splice(0)) listener.dispose(); }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.releaseListeners(); this.view = undefined; this.callbacks.onVisibility?.(false); }
}
