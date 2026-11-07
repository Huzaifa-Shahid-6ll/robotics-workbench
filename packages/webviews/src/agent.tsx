import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { ApprovalRequest, ContextViewItem, OperationStatus, ProviderId, ViewAction, WorkbenchViewRequest, WorkbenchViewState } from '@robotics-workbench/contracts';
import './workbench.css';
import './agent.css';

import { isWorkbenchViewResponse } from './protocol';
export { isWorkbenchViewResponse } from './protocol';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const emptyViewState: WorkbenchViewState = { schemaVersion: 1, project: null, loading: false, error: null, trusted: false, providers: [], tasks: [], task: null, context: [], changes: [], operations: [] };
export const statusLabel = (value: OperationStatus) => ({ queued: 'Queued', running: 'Running', 'awaiting-input': 'Waiting for input', succeeded: 'Succeeded', failed: 'Failed', cancelled: 'Cancelled', 'outcome-unknown': 'Outcome unknown' }[value]);
const active = (state: WorkbenchViewState) => !!state.task && ['queued', 'running', 'awaiting-input'].includes(state.task.status);
export type SendViewIntent = (type: ViewAction, payload?: Record<string, unknown>) => void;
const tabs = ['conversation', 'context', 'review'] as const;
type Tab = (typeof tabs)[number];
export interface AgentAppProps { state: WorkbenchViewState; send: SendViewIntent; draft: string; onDraft: (text: string) => void; initialTab?: Tab; onTab?: (tab: Tab) => void }

function Status({ value }: { value: OperationStatus }) {
  const symbol = { queued: '◷', running: '◌', 'awaiting-input': '?', succeeded: '✓', failed: '×', cancelled: '−', 'outcome-unknown': '!' }[value];
  return <span className={`status status-${value}`}><span aria-hidden="true">{symbol}</span> {statusLabel(value)}</span>;
}
function ContextItem({ item, send }: { item: ContextViewItem; send: SendViewIntent }) {
  const pinned = item.facets.includes('pinned');
  return <article className="context-item"><div className="row"><button className="link-button grow" onClick={() => send('openEvidence', { id: item.id })}>{item.title}</button><button aria-pressed={pinned} disabled={!uuid.test(item.id)} title={uuid.test(item.id) ? 'Include this evidence in later context preparation' : 'This context summary has no durable evidence ID and cannot be pinned'} onClick={() => send('pin', { id: item.id, pinned: !pinned })}>{pinned ? 'Unpin' : 'Pin'}</button></div>
    <p className="meta">Revision {item.revision} · {item.location}</p><p>{item.summary}</p><p className="meta">{item.reason}</p>
    <div className="chips">{item.facets.map(facet => <span className="chip" key={facet}>{facet.replaceAll('-', ' ')}</span>)}</div>
    <details><summary>Source details</summary><p className="break">{item.sourceUri}</p><p className="break mono">{item.sha256 ?? 'Digest unavailable'}</p></details>
  </article>;
}
function Approval({ item, state, send }: { item: ApprovalRequest; state: WorkbenchViewState; send: SendViewIntent }) {
  const valid = Date.parse(item.expiresAt) > Date.now() && item.expectedProjectRevision === state.project?.projectRevision && item.turn.session.taskId === state.task?.taskId;
  return <article className="approval"><h3>Permission requested</h3><p>{item.action}</p><pre>{item.targetSummary}</pre><p className="meta">Revision {item.expectedProjectRevision} · one-time response{!valid ? ' · expired or stale' : ''}</p>
    <div className="actions"><button disabled={!valid || !item.permittedScopes.includes('once')} onClick={() => valid && send('approval', { approvalId: item.approvalId, decision: 'allow' })}>Allow once</button><button disabled={!valid} onClick={() => valid && send('approval', { approvalId: item.approvalId, decision: 'deny' })}>Deny</button></div>
  </article>;
}

export function AgentApp({ state, send, draft, onDraft, initialTab = 'conversation', onTab }: AgentAppProps) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [providerId, setProvider] = useState<ProviderId>('codex');
  const [modelId, setModel] = useState('');
  const [profile, setProfile] = useState('read-only');
  const [pending, setPending] = useState<string | null>(null);
  const [pendingLoading, setPendingLoading] = useState(false);
  const submitLock = useRef(false);
  const baselineMessages = useRef(new Set<string>());
  const taskDetails = useRef<HTMLElement>(null);
  const stopButton = useCallback((button: HTMLButtonElement | null) => {
    if (button) return () => { if (document.activeElement === button) taskDetails.current?.focus(); };
  }, []);
  const running = active(state);
  const selectedProvider = state.providers.find(item => item.providerId === providerId);
  const task = state.task;
  const taskProvider = state.providers.find(item => item.providerId === task?.providerId);
  const canSend = state.trusted && !!state.project && !state.loading && !running && pending === null && !!draft.trim() && !!modelId.trim() && selectedProvider?.readiness === 'ready';
  useEffect(() => {
    if (pending !== null && state.task?.messages.some(message => message.role === 'user' && message.text === pending && !baselineMessages.current.has(message.messageId))) {
      if (draft === pending) onDraft('');
      setPending(null); setPendingLoading(false); submitLock.current = false;
    }
    else if (pending !== null && state.loading) setPendingLoading(true);
    else if (pendingLoading && !state.loading && state.error) { setPending(null); setPendingLoading(false); submitLock.current = false; }
  }, [pending, pendingLoading, state.task?.messages, state.loading, state.error, draft, onDraft]);
  useEffect(() => { if (task) { setProvider(task.providerId); setModel(task.modelId); } }, [task?.taskId]);
  const selectTab = (next: Tab) => { setTab(next); onTab?.(next); };
  return <div className="agent-app">
    <header className="project-header"><div><h1>Agent</h1><p className="meta">{state.project ? `${state.project.name} · revision ${state.project.projectRevision}` : 'Open a robotics project'}</p></div><button onClick={() => send('refresh')} disabled={state.loading}>Refresh</button></header>
    {!state.trusted && <p className="notice" role="note">Restricted Mode: trust this workspace before starting an agent or executing tools.</p>}
    {state.error && <div className="error" role="alert"><strong>Action failed</strong><p>{state.error}</p><button onClick={() => send('refresh')}>Refresh view</button></div>}
    {state.loading && <p className="meta" role="status">Refreshing retained state…</p>}
    <div className="task-header"><label>Task<select value={task?.taskId ?? ''} onChange={event => event.target.value && send('selectTask', { taskId: event.target.value })}><option value="" disabled>Select a retained task</option>{state.tasks.map(item => <option value={item.taskId} key={item.taskId}>{item.summary} · {statusLabel(item.status)}</option>)}</select></label>
      {task && <><div className="row"><div role="status" className="task-status"><span className="sr-only">Agent task: </span><Status value={task.status} /></div><p className="meta break">{task.providerId} · {task.modelId}</p></div>
        {task.problem && <p className="error-text">{task.problem}</p>}
        {running && <div className="actions"><button ref={stopButton} onClick={() => send('stop')} disabled={!state.trusted || !taskProvider?.capabilities.includes('interrupt')} aria-describedby={!taskProvider?.capabilities.includes('interrupt') ? 'agent-interrupt-unavailable' : undefined}>Stop agent</button>{!taskProvider?.capabilities.includes('interrupt') && <p id="agent-interrupt-unavailable" className="meta">Provider interruption is unavailable.</p>}</div>}
        <details className="task-details"><summary ref={taskDetails}>Task details and actions</summary><div className="task-tools"><p className="meta break mono">Task ID: {task.taskId}</p>
          {task.providerOutcome && <p className="meta">Provider turn: {statusLabel(task.providerOutcome)}. Tool and hardware receipts are separate.</p>}
          <div className="actions"><button onClick={() => send('reconcile')} disabled={!state.trusted || state.loading}>Reconnect / reconcile</button><button onClick={() => send('handoff')} disabled={!state.trusted}>Prepare handoff</button></div></div></details>
      </>}
      {!!state.operations.length && <details className="operation-list" open={state.operations.some(item => ['queued', 'running', 'awaiting-input'].includes(item.status))}><summary>Tool / hardware operations ({state.operations.length}){state.operations.some(item => item.status === 'failed') ? ' · failed receipt' : ''}{state.operations.some(item => item.status === 'outcome-unknown') ? ' · outcome unknown' : ''}</summary>{state.operations.map(item => <div className="operation" key={item.operationId}><span>{item.kind}</span><Status value={item.status} /><span className="meta break">{item.operationId}</span></div>)}</details>}
    </div>
    <nav className="tabs" aria-label="Agent views">{tabs.map(item => <button key={item} aria-current={tab === item ? 'page' : undefined} onClick={() => selectTab(item)}>{item === 'conversation' ? 'Conversation' : item === 'context' ? `Context (${state.context.length})` : `Changes (${state.changes.length})`}</button>)}</nav>
    <main className="content">
      {tab === 'conversation' && <section aria-label="Conversation"><h2 className="sr-only">Conversation</h2>
        {!task?.messages.length && <div className="empty"><h2>Work from identified project facts</h2><p>Describe a task below. Review context and source changes here; compile and upload retain their own receipts.</p></div>}
        {task?.messages.map(message => <article className={`message message-${message.role}`} key={message.messageId}><h3>{message.role === 'user' ? 'You' : 'Agent'}</h3><pre>{message.text || (message.complete ? 'No text returned.' : 'Waiting for text…')}</pre>{!message.complete && <p className="meta">Response in progress</p>}{message.artifactRef && <p className="meta">Full response artifact: <span className="mono">{message.artifactRef}</span></p>}</article>)}
        {!!task?.activities.length && <details><summary>Observable tool activity ({task.activities.length})</summary>{task.activities.map(item => <details className="activity" key={item.id}><summary>{item.title}</summary><pre>{item.summary}</pre></details>)}</details>}
        {task?.pendingApprovals.map(item => <Approval key={item.approvalId} item={item} state={state} send={send} />)}
      </section>}
      {tab === 'context' && <section aria-label="Context inspector"><h2>Context inspector</h2><p className="meta">Supplied and observed retrieval describe visible application activity. Provider-managed internal context may be unobservable.</p>
        {!state.context.length && <p>No application context is available for this task.</p>}
        {([['pinned', 'Pinned'], ['supplied-this-turn', 'Supplied this turn'], ['observed-retrieved', 'Observed retrieval'], ['available', 'Available'], ['stale', 'Stale / unresolved']] as const).map(([facet, label]) => {
          const items = state.context.filter(item => item.facets.includes(facet)); return items.length ? <section key={facet} className="context-group"><h3>{label}</h3>{items.map(item => <ContextItem key={item.id} item={item} send={send} />)}</section> : null;
        })}
      </section>}
      {tab === 'review' && <section aria-label="Task change review"><h2>Task changes</h2><p className="meta">Accepting or reverting source does not upload firmware or change physical wiring.</p>
        {!state.changes.length && <p>No retained source changes for the selected task.</p>}
        {state.changes.map(item => <article className="review-item" key={item.id}><div className="row"><h3 className="break grow">{item.path}</h3><span className="chip">{item.effect}</span></div><p>{item.summary}</p>
          <details><summary>Version identities</summary><p className="break mono">Base: {item.baselineSha256 ?? 'No baseline file'}</p><p className="break mono">Saved source: {item.currentSha256 ?? 'File unavailable'}</p></details>
          <div className="actions"><button onClick={() => send('review', { id: item.id, action: 'diff' })}>Open diff</button>
            {item.effect === 'written' && <><button disabled={!state.trusted || running} onClick={() => send('review', { id: item.id, action: 'keep' })}>Keep edits</button><button disabled={!state.trusted || running} onClick={() => send('review', { id: item.id, action: 'revert' })}>Revert edits</button></>}
            {item.effect === 'proposed' && <><button disabled={!state.trusted || running} onClick={() => send('review', { id: item.id, action: 'apply' })}>Apply proposal</button><button disabled={!state.trusted || running} onClick={() => send('review', { id: item.id, action: 'dismiss' })}>Dismiss</button></>}
            {item.effect === 'conflicted' && <p className="error-text">Preserve both versions and resolve the conflict in the host.</p>}
          </div></article>)}
        {task && <button disabled={!state.trusted || !running} onClick={() => send('authorizeUpload')}>Authorize exact upload…</button>}
      </section>}
    </main>
    <footer className="composer"><details className="route-settings" open={!task}><summary>{providerId === 'codex' ? 'Codex' : 'OpenCode'} · {modelId || 'Choose model'} · {profile === 'read-only' ? 'Read only' : 'Workspace writes'}</summary><div className="composer-settings"><label>Provider<select value={providerId} disabled={running || pending !== null} onChange={event => { setProvider(event.target.value as ProviderId); setModel(''); }}>{(['codex', 'opencode'] as const).map(item => <option key={item} value={item}>{item === 'codex' ? 'Codex' : 'OpenCode'}</option>)}</select></label><label>Model<input value={modelId} maxLength={256} placeholder="Exact available model ID" disabled={running || pending !== null} onChange={event => setModel(event.target.value)} /></label><label>Source access<select value={profile} disabled={running || pending !== null} onChange={event => setProfile(event.target.value)}><option value="read-only">Read only</option><option value="workspace-write">Workspace writes with approvals</option></select></label></div>
      <p className="meta">{selectedProvider?.detail ?? 'Provider readiness has not been checked. Refresh to inspect it.'}</p></details>
      <label htmlFor="agent-message">Task or follow-up</label><textarea id="agent-message" value={draft} maxLength={8192} placeholder="Explain the problem and the evidence to inspect…" onChange={event => onDraft(event.target.value)} aria-describedby="composer-help" />
      <div className="row"><p id="composer-help" className="meta grow">Enter adds a line. Images and attachments are unavailable until validated for the selected model.</p><button className="primary" disabled={!canSend} onClick={() => { if (!canSend || submitLock.current) return; submitLock.current = true; baselineMessages.current = new Set(task?.messages.map(message => message.messageId) ?? []); setPending(draft); send('send', { providerId, modelId: modelId.trim(), permissionProfileId: profile, userText: draft }); }}>{pending !== null ? 'Submitting…' : 'Send'}</button></div>
      {running && <p className="meta">One writer is active. Stop or wait for it before submitting another task.</p>}
    </footer>
  </div>;
}

class RenderBoundary extends Component<{ children: ReactNode; refresh: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div className="error" role="alert"><h1>Agent view could not render</h1><p>Task records and operations remain in the companion.</p><button onClick={() => { this.setState({ failed: false }); this.props.refresh(); }}>Reload view</button></div> : this.props.children; }
}
interface VsCodeApi { postMessage(value: WorkbenchViewRequest): void; getState(): unknown; setState(value: unknown): void }
declare const acquireVsCodeApi: (() => VsCodeApi) | undefined;
function BrowserApp({ api }: { api: VsCodeApi }) {
  const [state, setState] = useState(emptyViewState);
  const [local, setLocal] = useState(() => {
    const saved = api.getState();
    return { draft: object(saved) && text(saved.draft, 8192) ? saved.draft : '', tab: tabs.find(tab => object(saved) && saved.tab === tab) ?? 'conversation' };
  });
  const send: SendViewIntent = (type, payload = {}) => api.postMessage({ schemaVersion: 1, requestId: crypto.randomUUID(), projectId: state.project?.projectId ?? null, type, payload });
  useEffect(() => { const receive = (event: MessageEvent<unknown>) => { if (isWorkbenchViewResponse(event.data)) setState(event.data.state); }; window.addEventListener('message', receive); api.postMessage({ schemaVersion: 1, requestId: crypto.randomUUID(), projectId: null, type: 'ready', payload: {} }); return () => window.removeEventListener('message', receive); }, [api]);
  const updateLocal = (next: Partial<typeof local>) => { const updated = { ...local, ...next }; setLocal(updated); api.setState(updated); };
  return <RenderBoundary refresh={() => send('refresh')}><AgentApp state={state} send={send} draft={local.draft} onDraft={draft => updateLocal({ draft })} initialTab={local.tab} onTab={tab => updateLocal({ tab })} /></RenderBoundary>;
}
if (typeof document !== 'undefined' && typeof acquireVsCodeApi === 'function') {
  const root = document.getElementById('root'); if (root) createRoot(root).render(<BrowserApp api={acquireVsCodeApi()} />);
}
