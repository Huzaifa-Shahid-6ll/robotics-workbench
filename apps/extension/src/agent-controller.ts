import * as vscode from 'vscode';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentRecord } from '@robotics-workbench/agents';
import type { ContextPacket } from '@robotics-workbench/application';
import type { ContextViewItem, ProjectMethod, WorkbenchManifest, WorkbenchViewRequest, WorkbenchViewState, ProviderId, ProviderDescriptor, OperationReceipt } from '@robotics-workbench/contracts';
import { isRequestId, isDocumentExcerpt, isRecordingSelection, type RecordingSelection } from '@robotics-workbench/contracts';
import type { DocumentExcerpt } from '@robotics-workbench/contracts';
import { AgentViewProvider } from './agent-view';
import { buildContextView } from './context-view';
import { TaskReview, type ReviewRelocation, type ReviewSnapshot } from './task-review';

export type AgentProject = { root: string; manifest: WorkbenchManifest };
export interface AgentControllerHost {
  project(): Promise<AgentProject>;
  request<T>(bound: AgentProject, method: ProjectMethod, params?: Record<string, unknown>, revision?: number): Promise<T>;
  prepareSource(bound: AgentProject): Promise<string>;
  authorizeUpload(bound: AgentProject, taskId: string): Promise<void>;
  openDocument?(citation: DocumentExcerpt): Promise<void>;
  openRecording?(selection: RecordingSelection): Promise<void>;
}
const empty = (): WorkbenchViewState => ({ schemaVersion: 1, project: null, loading: false, error: null, trusted: vscode.workspace.isTrusted,
  providers: (['codex', 'opencode'] as const).map(providerId => ({ providerId, readiness: 'unknown', capabilities: [], detail: 'Choose an explicit provider/model. Account readiness is checked when its session opens.' })), tasks: [], task: null, context: [], changes: [], operations: [] });

/** Host-side composition: the renderer sends intents, never arbitrary RPC or file paths. */
export class AgentController implements vscode.Disposable {
  readonly view: AgentViewProvider;
  private state = empty();
  private bound?: AgentProject;
  private selectedTask?: string;
  private handoffTask?: string;
  private selection: ContextPacket['selection'] = null;
  private timer?: NodeJS.Timeout;
  private refreshing?: Promise<void>;
  private refreshAgain = false;
  private disposed = false;
  private generation = 0;
  private acting = false;
  private actionError: string | null = null;
  private lastPublished = empty();
  private readonly reviews: TaskReview;
  private readonly disposables: vscode.Disposable[] = [];
  constructor(private readonly context: vscode.ExtensionContext, private readonly host: AgentControllerHost) {
    this.reviews = new TaskReview({
      load: async taskId => this.bound ? this.host.request<ReviewSnapshot | null>(this.bound, 'review.load', { taskId }) : null,
      save: async (taskId, snapshot) => { if (!this.bound) throw Error('No review project is selected.'); await this.host.request(this.bound, 'review.save', { taskId, snapshot }); },
      relocation: async taskId => this.bound ? this.host.request<ReviewRelocation | null>(this.bound, 'review.relocation', { taskId }) : null
    });
    this.view = new AgentViewProvider(context.extensionUri, { getState: () => this.state, onRequest: request => this.handle(request), onVisibility: visible => {
      if (this.timer) clearInterval(this.timer); this.timer = undefined;
      if (visible && !this.disposed) { void this.refresh(); this.timer = setInterval(() => { void this.refresh(); }, 1000); }
    } });
    this.disposables.push(vscode.window.registerWebviewViewProvider('roboticsWorkbench.agent', this.view));
  }
  getState(): WorkbenchViewState { return structuredClone(this.state); }
  async show(): Promise<void> { await vscode.commands.executeCommand('roboticsWorkbench.agent.focus'); this.view.reveal(); await this.refresh(); }
  selectEntity(selection: ContextPacket['selection']): void { this.selection = selection; void this.show(); }
  selectCitation(citation: DocumentExcerpt, projectRevision: number): void {
    this.selectEntity({ kind: 'document-page', documentId: citation.documentId, artifactSha256: citation.artifactSha256, extractorVersion: citation.extractorVersion, page: citation.page, ...(citation.region ? { region: [...citation.region] } : {}), ...(citation.textRange ? { textRange: [...citation.textRange] } : {}), projectRevision });
  }
  selectInterval(selection: RecordingSelection, projectRevision: number): void {
    this.selectEntity({ kind: 'recording-range', recordingId: selection.recordingId, derivationId: selection.derivationId, configurationSha256: selection.configurationSha256, channelIds: [...selection.channelIds], parserVersion: selection.parserVersion, timeBasis: selection.timeBasis, startMs: selection.start, endMs: selection.end, projectRevision, recordingProjectRevision: selection.projectRevision, ...(selection.deviceEpoch !== undefined ? { deviceEpoch: selection.deviceEpoch } : {}) });
  }
  private pinned(): Set<string> { const value = this.context.workspaceState.get<unknown>(`agent.pinned.${this.bound?.manifest.projectId}`, []); return new Set(Array.isArray(value) ? value.filter(isRequestId).slice(-100) : []); }
  private async bind(): Promise<AgentProject> {
    if (!vscode.workspace.isTrusted) throw Error('Trust the workspace before starting a provider or reading executable configuration.');
    if (!this.bound) {
      this.bound = await this.host.project();
      this.selectedTask = this.context.workspaceState.get<string>(`agent.selected.${this.bound.manifest.projectId}`);
    }
    return this.bound;
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
    const generation = this.generation;
    try {
      if (!vscode.workspace.isTrusted) { this.state = empty(); return; }
      const bound = await this.bind();
      const snapshot = await this.host.request<{ manifest: WorkbenchManifest }>(bound, 'project.snapshot');
      const tasks = await this.host.request<{ task: AgentRecord['task']; updatedAt: string; lastProblem: string | null }[]>(bound, 'agent.list');
      if (!this.selectedTask && tasks.length) this.selectedTask = tasks.at(-1)!.task.taskId;
      const selectedTask = this.selectedTask;
      const record = selectedTask ? await this.host.request<AgentRecord & { sourceCurrent?: boolean }>(bound, 'agent.get', { taskId: selectedTask }) : null;
      let missingBaseline = false, relocationRequired = false;
      const allChanges = selectedTask ? await this.reviews.list(selectedTask, bound.root, vscode.workspace.textDocuments).catch(error => { if (error?.code === 'NOT_FOUND') { missingBaseline = true; return []; } if (error?.code === 'REVIEW_RELOCATION_REQUIRED') { relocationRequired = true; return []; } throw error; }) : [];
      const changes = allChanges.slice(0, 200);
      const operations = record ? await Promise.all(record.task.operationIds.slice(-32).map(operationId => this.host.request<OperationReceipt>(bound, 'operation.get', { operationId }))) : [];
      if (generation !== this.generation || selectedTask !== this.selectedTask || this.disposed) return;
      bound.manifest = snapshot.manifest;
      const available: ContextViewItem[] = snapshot.manifest.components.slice(0, 100).map(component => ({ id: component.componentId, title: component.label, sourceUri: vscode.Uri.file(`${bound.root}/workbench.json`).toString(), revision: snapshot.manifest.projectRevision, location: 'Intended component', facets: ['available'], summary: 'Available component intent; selecting or pinning does not submit it.', reason: this.selection && 'id' in this.selection && this.selection.id === component.componentId ? 'Selected for the next submitted task.' : 'Available by stable component identity.', sha256: null }));
      const context = buildContextView(record, snapshot.manifest.projectRevision, this.pinned(), available);
      if (record?.task.sourceSnapshotId) context.unshift({ id: record.task.sourceSnapshotId, title: 'Saved source snapshot reference', sourceUri: `snapshot://${record.task.sourceSnapshotId}`, revision: record.task.projectRevision, location: record.task.sourceSnapshotId, facets: record.sourceCurrent === true ? ['supplied-this-turn'] : ['supplied-this-turn', 'stale'], summary: 'The application supplied this immutable reference. Provider-managed source retrieval may not be observable.', reason: 'Keeping edits does not refresh this historical snapshot.', sha256: null });
      if (record && missingBaseline) context.push({ id: record.task.taskId, title: 'Source review baseline unavailable', sourceUri: `task://${record.task.taskId}`, revision: record.task.projectRevision, location: 'Historical task', facets: ['stale'], summary: 'Transcript retained; automatic revert unavailable without a source baseline.', reason: 'No retained source baseline exists.', sha256: null });
      if (record && relocationRequired) context.push({ id: `relocated:${record.task.taskId}`, title: 'Restored source review needs rebinding', sourceUri: `task://${record.task.taskId}`, revision: record.task.projectRevision, location: 'Historical task review', facets: ['stale'], summary: 'Transcript and original review remain retained. Use Robotics: Review Task Changes to verify unchanged restored files and explicitly rebind.', reason: 'Original absolute project location differs from this restored project.', sha256: null });
      const descriptor = record?.events.find(event => event.type === 'agent.session.opened');
      if (descriptor?.type === 'agent.session.opened') this.provider(descriptor.payload.descriptor);
      this.state = { ...this.state, trusted: true, error: this.actionError, project: { projectId: snapshot.manifest.projectId, projectRevision: snapshot.manifest.projectRevision, name: snapshot.manifest.name },
        tasks: tasks.map(item => ({ taskId: item.task.taskId, providerId: item.task.providerId, status: item.task.status, summary: `${item.task.providerId} · ${item.task.status}` })),
        task: record ? { taskId: record.task.taskId, providerId: record.task.providerId, modelId: record.open.model.modelId, status: record.task.status, providerOutcome: record.providerOutcome, contextPacketId: record.packet.packetId, sourceSnapshotId: record.task.sourceSnapshotId,
          messages: record.messages.slice(-20).map(message => ({ ...message, text: message.text.length > 8192 ? message.text.slice(0, 8192) + '\n[Display excerpt; full message remains in the task journal.]' : message.text })), pendingApprovals: record.pendingApprovals,
          activities: record.events.filter(event => ['agent.tool.started', 'agent.tool.finished', 'agent.connection.changed'].includes(event.type)).slice(-20).map(event => ({ id: event.eventId, title: event.type, summary: event.type === 'agent.tool.started' ? `${event.payload.displayName}: ${event.payload.redactedInputSummary}` : event.type === 'agent.tool.finished' ? `${event.payload.outcome}: ${event.payload.summary}` : event.type === 'agent.connection.changed' ? event.payload.connection : '' })), problem: record.lastProblem } : null,
        context: context.slice(0, 200), changes, operations: operations.map(operation => ({ operationId: operation.operationId, kind: operation.kind, status: operation.status })) };
      if (allChanges.length > changes.length) this.state.error = `Showing ${changes.length} of ${allChanges.length} observed changes; the remaining records are retained.`;
    } catch (error) { if (generation === this.generation) this.state = { ...this.state, error: this.actionError ?? this.error(error), loading: false }; }
    finally { await this.publish(); }
  }
  private provider(descriptor: ProviderDescriptor): void { this.state.providers = this.state.providers.map(item => item.providerId === descriptor.providerId ? { providerId: descriptor.providerId, readiness: descriptor.readiness, capabilities: descriptor.capabilities, detail: `${descriptor.executableVersion}; protocol checked. Account/model capability is verified when opening a session.` } : item); }
  private error(error: unknown): string { return (error instanceof Error ? error.message : 'Agent view action failed. Inspect retained state before retrying.').slice(0, 2048); }
  private async publish(): Promise<void> {
    if (this.disposed) return;
    let omitted = false;
    while (Buffer.byteLength(JSON.stringify(this.state)) > 900 * 1024) {
      omitted = true;
      if (this.state.context.length) this.state.context.pop();
      else if (this.state.changes.length) this.state.changes.pop();
      else if ((this.state.task?.messages.length ?? 0) > 1) this.state.task!.messages.shift();
      else break;
    }
    if (omitted) this.state.error = 'The view preview is bounded; omitted content remains in the task journal and retained source snapshots.';
    try { await this.view.update(this.state); this.lastPublished = structuredClone(this.state); }
    catch { this.state = { ...structuredClone(this.lastPublished), loading: false, error: 'View data exceeded supported bounds. Existing content was retained; refresh or inspect task evidence.' }; await this.view.update(this.state); }
  }
  async handle(request: WorkbenchViewRequest): Promise<void> {
    if (this.disposed) return;
    if (request.type === 'ready' || request.type === 'refresh') { if (request.type === 'refresh') this.actionError = null; await this.refresh(); return; }
    if (this.acting) throw Error('Another view action is still being admitted.');
    this.acting = true;
    const selectedTask = this.selectedTask, selection = structuredClone(this.selection), pinnedIds = [...this.pinned()], handoffTask = this.handoffTask;
    const approval = request.type === 'approval' ? structuredClone(this.state.task?.pendingApprovals.find(item => item.approvalId === request.payload.approvalId)) : undefined;
    try {
    const bound = await this.bind();
    if (request.projectId !== bound.manifest.projectId) throw Error('The view belongs to another project.');
    this.generation++; this.actionError = null; this.state = { ...this.state, loading: true, error: null }; await this.publish();
    try {
      const payload = request.payload;
      if (request.type === 'send') {
        const taskId = randomUUID(), sourceSnapshotId = await this.host.prepareSource(bound);
        await this.reviews.capture(taskId, bound.root, vscode.workspace.textDocuments);
        const record = await this.host.request<AgentRecord>(bound, 'agent.start', { taskId, clientTurnId: request.requestId, providerId: payload.providerId, modelId: payload.modelId, permissionProfileId: payload.permissionProfileId, userText: payload.userText, sourceSnapshotId, selection, pinnedIds, ...(handoffTask ? { handoffTaskId: handoffTask } : {}) }, bound.manifest.projectRevision);
        this.selectedTask = record.task.taskId; this.handoffTask = undefined;
        await this.context.workspaceState.update(`agent.selected.${bound.manifest.projectId}`, this.selectedTask);
      } else if (request.type === 'selectTask') {
        this.selectedTask = String(payload.taskId); await this.context.workspaceState.update(`agent.selected.${bound.manifest.projectId}`, this.selectedTask);
      } else if (request.type === 'pin') {
        if (!isRequestId(payload.id)) throw Error('This omission handle cannot be pinned. Open its available source or pin a stable project object.');
        const pinned = this.pinned(); if (payload.pinned) pinned.add(String(payload.id)); else pinned.delete(String(payload.id));
        await this.context.workspaceState.update(`agent.pinned.${bound.manifest.projectId}`, [...pinned].slice(-100));
      } else if (request.type === 'openEvidence') await this.openEvidence(String(payload.id));
      else {
        if (!selectedTask) throw Error('Select a task first.');
        if (request.type === 'review') await this.reviews.act(selectedTask, bound.root, String(payload.id), payload.action as 'diff' | 'keep' | 'revert' | 'apply' | 'dismiss', vscode.workspace.textDocuments);
        else if (request.type === 'stop') await this.host.request(bound, 'agent.interrupt', { taskId: selectedTask });
        else if (request.type === 'reconcile') await this.host.request(bound, 'agent.reconcile', { taskId: selectedTask });
        else if (request.type === 'authorizeUpload') await this.host.authorizeUpload(bound, selectedTask);
        else if (request.type === 'approval') {
          if (!approval || !approval.permittedScopes.includes('once')) throw Error('Approval expired or does not support one-time scope.');
          await this.host.request(bound, 'agent.approval', { taskId: selectedTask, answer: { approvalId: approval.approvalId, providerRequestId: approval.providerRequestId, turn: approval.turn, decision: payload.decision, scope: 'once', expectedProjectRevision: approval.expectedProjectRevision, deviceId: approval.deviceId, artifactSha256: approval.artifactSha256 } });
        } else if (request.type === 'handoff') {
          const handoff = await this.host.request(bound, 'agent.handoff', { taskId: selectedTask });
          this.handoffTask = selectedTask;
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(handoff, null, 2) }), { preview: true, preserveFocus: false });
        }
      }
    } catch (error) { this.actionError = this.error(error); this.state.error = this.actionError; }
    finally { await this.refresh(); this.state.loading = false; await this.publish(); }
    } finally { this.acting = false; }
  }
  private async openEvidence(id: string): Promise<void> {
    const item = this.state.context.find(row => row.id === id); if (!item || !this.bound) throw Error('Context item is unavailable.');
    if (item.sourceUri.startsWith('document://') && this.host.openDocument) {
      const citation: unknown = JSON.parse(item.summary);
      if (!isDocumentExcerpt(citation) || citation.artifactSha256 !== item.sha256) throw Error('Exact retained document citation is unavailable.');
      await this.host.openDocument(citation); return;
    }
    if (item.sourceUri.startsWith('recording://') && this.host.openRecording) {
      const selection: unknown = JSON.parse(item.summary).selection;
      if (!isRecordingSelection(selection)) throw Error('Exact retained recording selection is unavailable.');
      await this.host.openRecording(selection); return;
    }
    if (item.sourceUri.startsWith('artifact://')) {
      const artifactId = item.sourceUri.slice('artifact://'.length);
      const preview = await this.host.request<{ text: string; truncated: boolean }>(this.bound, 'artifact.preview', { artifactId });
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: preview.text + (preview.truncated ? '\n[Preview truncated; retained artifact is unchanged.]' : '') })); return;
    }
    if (item.sourceUri.startsWith('file:') && !item.facets.includes('stale')) {
      const path = realpathSync(fileURLToPath(item.sourceUri)), scoped = relative(this.bound.root, path);
      if (isAbsolute(scoped) || scoped === '..' || scoped.startsWith(`..${sep}`)) throw Error('Evidence source leaves the active project.');
      if (item.sha256 && createHash('sha256').update(readFileSync(path)).digest('hex') !== item.sha256) throw Error('Source bytes changed; inspect the retained context instead.');
      await vscode.window.showTextDocument(vscode.Uri.file(path)); return;
    }
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify({ notice: 'Historical source may be unavailable. This is the exact retained context excerpt and provenance, not a navigation to newer text.', item }, null, 2) }));
  }
  async showReview(): Promise<void> {
    await this.show();
    if (this.bound && this.selectedTask) {
      try { await this.reviews.list(this.selectedTask, this.bound.root, vscode.workspace.textDocuments); }
      catch (error) {
        if ((error as { code?: string }).code !== 'REVIEW_RELOCATION_REQUIRED') throw error;
        await this.reviews.rebind(this.selectedTask, this.bound.root, vscode.workspace.textDocuments); await this.refresh();
      }
    }
    if (!this.state.changes.length) return;
    const picked = await vscode.window.showQuickPick(this.state.changes.map(item => ({ label: item.path, description: item.effect, id: item.id })), { title: 'Robotics: Review Task Changes', placeHolder: 'Open retained task diff' });
    if (picked && this.bound && this.selectedTask) await this.reviews.act(this.selectedTask, this.bound.root, picked.id, 'diff', vscode.workspace.textDocuments);
  }
  dispose(): void { this.disposed = true; this.generation++; if (this.timer) clearInterval(this.timer); this.view.dispose(); this.reviews.dispose(); for (const disposable of this.disposables) disposable.dispose(); }
}
