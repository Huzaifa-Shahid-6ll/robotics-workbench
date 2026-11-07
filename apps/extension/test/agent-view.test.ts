import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type * as vscode from 'vscode';
import type { AgentEvent, WorkbenchViewRequest, WorkbenchViewState } from '@robotics-workbench/contracts';
import type { ContextPacket } from '@robotics-workbench/application';
import { AgentViewProvider, agentViewHtml, isWorkbenchViewRequest, isWorkbenchViewState, isWorkbenchViewResponse } from '../src/agent-view';
import { buildContextView } from '../src/context-view';

function state(): WorkbenchViewState {
  return { schemaVersion: 1, project: { projectId: randomUUID(), projectRevision: 1, name: 'Synthetic project' }, loading: false, error: null, trusted: true,
    providers: [{ providerId: 'codex', readiness: 'unknown', capabilities: [], detail: 'Not inspected' }], tasks: [], task: null, context: [], changes: [], operations: [] };
}
const request = (snapshot: WorkbenchViewState, type: WorkbenchViewRequest['type'], payload: Record<string, unknown> = {}): WorkbenchViewRequest => ({ schemaVersion: 1, requestId: randomUUID(), projectId: snapshot.project?.projectId ?? null, type, payload });
class Signal<T> {
  readonly listeners = new Set<(value: T) => unknown>();
  on = (listener: (value: T) => unknown): vscode.Disposable => { this.listeners.add(listener); return { dispose: () => { this.listeners.delete(listener); } }; };
  fire(value: T): void { for (const listener of [...this.listeners]) listener(value); }
}
function uri(path: string): vscode.Uri { return { path, with: (change: { path?: string }) => uri(change.path ?? path), toString: () => `file://${path}` } as unknown as vscode.Uri; }
function view() {
  const messages = new Signal<unknown>(), visibility = new Signal<void>(), disposed = new Signal<void>();
  const sent: unknown[] = [];
  const result = { visible: true, show: () => {}, webview: { options: {} as vscode.WebviewOptions, html: '', cspSource: 'vscode-webview://fixture', asWebviewUri: (value: vscode.Uri) => value,
    onDidReceiveMessage: messages.on, postMessage: async (value: unknown) => { sent.push(structuredClone(value)); return true; } }, onDidChangeVisibility: visibility.on, onDidDispose: disposed.on };
  return { value: result as unknown as vscode.WebviewView, raw: result, messages, visibility, disposed, sent };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('webview protocol rejects malformed, oversized, cross-project and arbitrary RPC requests', () => {
  const snapshot = state(), valid = request(snapshot, 'send', { providerId: 'codex', modelId: 'selected-model', permissionProfileId: 'read-only', userText: 'Explain source' });
  assert.ok(isWorkbenchViewRequest(valid, snapshot.project!.projectId));
  for (const changed of [ { ...valid, projectId: randomUUID() }, { ...valid, schemaVersion: 2 }, { ...valid, requestId: 'invalid' }, { ...valid, type: 'firmware.upload' },
    { ...valid, payload: { ...valid.payload, executable: 'hostile.exe' } }, { ...valid, payload: { ...valid.payload, userText: 'x'.repeat(8193) } }, { ...valid, payload: { ...valid.payload, userText: '  ' } }, { ...valid, arbitrary: true } ]) assert.equal(isWorkbenchViewRequest(changed, snapshot.project!.projectId), false);
  assert.ok(isWorkbenchViewRequest({ ...request(snapshot, 'ready'), projectId: null }, snapshot.project!.projectId));
  assert.equal(isWorkbenchViewRequest({ ...valid, projectId: null }, snapshot.project!.projectId), false);
  assert.equal(isWorkbenchViewRequest(request(snapshot, 'review', { id: 'known', action: 'shell' })), false);
  assert.equal(isWorkbenchViewRequest(request(snapshot, 'approval', { approvalId: randomUUID(), decision: 'allow', scope: 'global' })), false);
});

test('state validator requires bounded typed status, references and no unexpected credential fields', () => {
  const snapshot = state(); assert.ok(isWorkbenchViewState(snapshot)); assert.ok(isWorkbenchViewResponse({ schemaVersion: 1, type: 'state', state: snapshot }));
  assert.equal(isWorkbenchViewState({ ...snapshot, trusted: 'yes' }), false);
  assert.equal(isWorkbenchViewState({ ...snapshot, token: 'synthetic-secret' }), false);
  assert.equal(isWorkbenchViewState({ ...snapshot, operations: [{ operationId: randomUUID(), kind: 'upload', status: 'done' }] }), false);
  assert.equal(isWorkbenchViewState({ ...snapshot, providers: [{ ...snapshot.providers[0], capabilities: ['invented'] }] }), false);
  assert.equal(isWorkbenchViewResponse({ schemaVersion: 1, type: 'state', state: snapshot, execute: 'hostile' }), false);
});

test('host ignores stale views and duplicate effects, preserves state on hide, and recreates without turn replay', async () => {
  const snapshot = state(), handled: WorkbenchViewRequest[] = [], changes: boolean[] = [];
  const provider = new AgentViewProvider(uri('/extension'), { getState: () => snapshot, onRequest: message => { handled.push(message); }, onVisibility: visible => changes.push(visible) });
  const first = view(); provider.resolveWebviewView(first.value);
  assert.equal(first.raw.webview.options.enableScripts, true); assert.equal(first.raw.webview.options.enableCommandUris, false);
  assert.match(first.raw.webview.html, /default-src 'none'/); assert.match(first.raw.webview.html, /connect-src 'none'/); assert.match(first.raw.webview.html, /agent\.js/);
  const ready = { ...request(snapshot, 'ready'), projectId: null }; first.messages.fire(ready); await flush();
  assert.equal(handled[0].type, 'ready'); assert.equal(first.sent.length, 1);
  const send = request(snapshot, 'send', { providerId: 'codex', modelId: 'model', permissionProfileId: 'read-only', userText: 'Explain' });
  first.messages.fire(send); first.messages.fire(send); await flush(); assert.equal(handled.filter(item => item.type === 'send').length, 1);
  first.raw.visible = false; first.visibility.fire(); assert.equal(provider.visible, false); assert.equal(await provider.update(snapshot), false);
  const second = view(); provider.resolveWebviewView(second.value); assert.equal(first.messages.listeners.size, 0);
  first.messages.fire({ ...send, requestId: randomUUID() }); second.messages.fire(ready); await flush();
  assert.equal(handled.filter(item => item.type === 'send').length, 1); assert.equal(handled.filter(item => item.type === 'ready').length, 1, 'Same ready ID is observation deduplicated across recreation.');
  second.messages.fire({ ...ready, requestId: randomUUID() }); await flush(); assert.equal(handled.filter(item => item.type === 'ready').length, 2);
  provider.dispose(); assert.equal(second.messages.listeners.size, 0); assert.equal(second.visibility.listeners.size, 0); assert.equal(changes.at(-1), false);
});

test('host validates task, context, review and trust scope before invoking callbacks', async () => {
  const snapshot = state(), handled: WorkbenchViewRequest[] = [], panel = view();
  const provider = new AgentViewProvider(uri('/extension'), { getState: () => snapshot, onRequest: message => { handled.push(message); } }); provider.resolveWebviewView(panel.value);
  panel.messages.fire(request(snapshot, 'selectTask', { taskId: randomUUID() })); panel.messages.fire(request(snapshot, 'openEvidence', { id: 'missing' })); panel.messages.fire(request(snapshot, 'review', { id: 'missing', action: 'revert' }));
  snapshot.trusted = false; panel.messages.fire(request(snapshot, 'send', { providerId: 'codex', modelId: 'model', permissionProfileId: 'workspace-write', userText: 'Edit source' })); await flush();
  assert.equal(handled.length, 0); provider.dispose();
});

test('HTML attributes cannot insert a second script or remote access policy', () => {
  const html = agentViewHtml('vscode-webview://fixture', 'a'.repeat(32), 'local://agent.js" onload="bad()', 'local://agent.css');
  assert.equal((html.match(/<script /g) ?? []).length, 1); assert.ok(html.includes('&quot; onload=&quot;bad()')); assert.equal(html.includes("'unsafe-inline'"), false); assert.equal(html.includes('https:'), false);
  assert.throws(() => agentViewHtml('x', 'untrusted nonce', 'x', 'x'));
});

test('approval state binds project/provider/task and stale approval answers are not forwarded', async () => {
  const snapshot = state(), taskId = randomUUID(), approvalId = randomUUID();
  const session = { providerId: 'codex' as const, projectId: snapshot.project!.projectId, taskId, providerSessionId: 'native-session', workspaceUri: 'file:///C:/fixture/' };
  const approval = { approvalId, providerRequestId: 'native-request', turn: { session, clientTurnId: randomUUID(), providerTurnId: 'native-turn' }, action: 'read', targetSummary: 'Known source', expectedProjectRevision: 1, deviceId: null, artifactSha256: null, permittedScopes: ['once' as const], expiresAt: new Date(Date.now() + 60000).toISOString() };
  snapshot.task = { taskId, providerId: 'codex', modelId: 'model', status: 'awaiting-input', providerOutcome: null, contextPacketId: randomUUID(), sourceSnapshotId: null, messages: [], pendingApprovals: [approval], activities: [], problem: null };
  assert.ok(isWorkbenchViewState(snapshot));
  const wrongProvider = structuredClone(snapshot); wrongProvider.task!.pendingApprovals[0].turn.session.providerId = 'opencode'; assert.equal(isWorkbenchViewState(wrongProvider), false);
  const wrongProject = structuredClone(snapshot); wrongProject.task!.pendingApprovals[0].turn.session.projectId = randomUUID(); assert.equal(isWorkbenchViewState(wrongProject), false);
  const tooLarge = structuredClone(snapshot); tooLarge.task!.messages = [{ messageId: 'message', role: 'assistant', text: '界'.repeat(24000), artifactRef: null, complete: false }]; assert.equal(isWorkbenchViewState(tooLarge), false);
  const handled: WorkbenchViewRequest[] = [], panel = view();
  const provider = new AgentViewProvider(uri('/extension'), { getState: () => snapshot, onRequest: value => { handled.push(value); } }); provider.resolveWebviewView(panel.value);
  snapshot.project!.projectRevision = 2; panel.messages.fire(request(snapshot, 'approval', { approvalId, decision: 'allow' })); await flush(); assert.equal(handled.length, 0);
  snapshot.project!.projectRevision = 1; panel.messages.fire(request(snapshot, 'approval', { approvalId, decision: 'deny' })); await flush(); assert.equal(handled.length, 1); provider.dispose();
});

test('context mapping keeps availability, supplied, observed and stale facets separate', () => {
  const projectId = randomUUID(), evidenceId = randomUUID(), artifactId = randomUUID();
  const packet: ContextPacket = { schemaVersion: 1, packetId: randomUUID(), projectId, projectRevision: 1, sourceSnapshotId: null, assembledAt: new Date().toISOString(), task: 'Explain', selection: null,
    current: { targetFqbn: null, deviceId: null, connectionState: 'disconnected', latestBuildId: null, lastUploadReceiptId: null, physicalConfirmation: 'unconfirmed', activeOperationIds: [] }, constraints: [], conflicts: [], unknowns: [], omitted: [{ reason: 'budget', ref: 'large-log', expansionHandle: 'evidence:large-log' }],
    evidenceRefs: [{ evidenceId, artifactId, sha256: 'a'.repeat(64), basis: 'planned', sourceUri: 'file:///C:/project/workbench.json', location: { kind: 'whole', start: null, end: null, timeBasis: null }, projectRevision: 1, observedAt: null, applicability: 'current', summary: 'Intended wiring' }] };
  const availableId = randomUUID();
  const available = { id: availableId, title: 'Available source', sourceUri: 'file:///C:/project/code.ino', revision: 2, location: 'Whole source', facets: [] as [], summary: '', reason: '', sha256: null };
  const rows = buildContextView({ packet, events: [] }, 2, new Set([evidenceId]), [available]);
  const supplied = rows.find(item => item.id === evidenceId)!; assert.deepEqual(supplied.facets, ['supplied-this-turn', 'stale', 'pinned']); assert.ok(supplied.reason.includes('historical'));
  assert.deepEqual(rows.find(item => item.id === availableId)!.facets, ['available']); assert.equal(rows.some(item => item.facets.includes('observed-retrieved')), false);
  assert.ok(rows.find(item => item.id === 'large-log')!.reason.includes('Excluded: budget'));
  assert.equal(packet.evidenceRefs[0].applicability, 'current', 'Mapping does not mutate historical context.');
  const event: AgentEvent = { schemaVersion: 1, eventId: randomUUID(), sequence: 1, projectId, projectRevision: 1, occurredAt: new Date().toISOString(), type: 'agent.tool.finished', payload: { turn: { clientTurnId: randomUUID(), providerTurnId: 'turn', session: { providerId: 'codex', projectId, taskId: randomUUID(), providerSessionId: 'session', workspaceUri: 'file:///C:/project/' } }, toolCallId: 'tool', outcome: 'succeeded', artifactRefs: [availableId], summary: 'Returned reference' } };
  const observed = buildContextView({ packet, events: [event] }, 2, new Set(), [available]);
  assert.deepEqual(observed.find(item => item.id === availableId)!.facets, ['available', 'observed-retrieved']);
  assert.equal(observed.find(item => item.id === availableId)!.facets.includes('supplied-this-turn'), false);
});
