import * as vscode from 'vscode';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isExperimentProcedure, isRecordingSelection, isParserProfile, isTelemetryHash, type HashedParserProfile, type ExperimentParameter, type ExperimentProcedure, type ExperimentRun, type OperationReceipt, type ProjectMethod, type RecordingSelection, type TelemetryWindow } from '@robotics-workbench/contracts';
import { freezeTelemetrySelection, isTelemetryViewRequest, isTelemetryViewState, type TelemetryViewState } from '@robotics-workbench/webviews';
import type { AgentProject } from './agent-controller';
import { minimalReviewEdit, reviewHash, reviewPath, reviewText } from './review-files';

type Host = { project(): Promise<AgentProject>; request<T>(bound: AgentProject, method: ProjectMethod, params?: Record<string, unknown>, revision?: number): Promise<T>; wait(bound: AgentProject, receipt: OperationReceipt): Promise<OperationReceipt>; ask(selection: RecordingSelection): void };
type Snapshot = Pick<TelemetryViewState, 'project' | 'recordings' | 'profiles' | 'procedures' | 'runs'>;
const empty = (): TelemetryViewState => ({ schemaVersion: 1, trusted: vscode.workspace.isTrusted, loading: false, error: null, stale: false, project: null, recordings: [], profiles: [], selectedRecordingId: null, selectedProfileId: null, window: null, revealedSelection: null, live: null, procedures: [], runs: [], comparison: null });
const procedurePath = 'experiments/procedures.json', profilesPath = 'telemetry/parsers.json';
const pending = (receipt: OperationReceipt) => ['queued', 'running', 'awaiting-input'].includes(receipt.status);

/** Frames emit scoped intents; only this native host opens files and asks for observations. */
export class TelemetryController implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private state = empty();
  private bound?: AgentProject;
  private busy = false;
  private polling = false;
  private refreshFlight?: Promise<void>;
  private refreshAgain = false;
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;
  private lastPublished?: string;
  private historicalDerivationId?: string;
  private readonly seen = new Map<string, string>();
  constructor(private readonly context: vscode.ExtensionContext, private readonly host: Host) {}
  getState(): TelemetryViewState { return structuredClone(this.state); }
  async reveal(selection: RecordingSelection): Promise<void> {
    await this.show();
    if (this.busy) throw Error('Finish the pending evidence action before navigating to historical context.');
    this.busy = true;
    try {
      const exact = await this.resolveSelection(selection);
      const retained = await this.host.request<{ profile: HashedParserProfile; recordingId: string; projectRevision: number }>(this.requireBound(), 'telemetry.inspect', { derivationId: exact.derivationId });
      if (!isParserProfile(retained.profile) || !isTelemetryHash((retained.profile as HashedParserProfile).configurationSha256) || retained.recordingId !== exact.recordingId || retained.projectRevision !== exact.projectRevision || retained.profile.parserVersion !== exact.parserVersion || retained.profile.configurationSha256 !== exact.configurationSha256) throw Error('Historical navigation differs from its retained parser or recording identity.');
      this.historicalDerivationId = exact.derivationId; this.state.selectedRecordingId = exact.recordingId; this.state.selectedProfileId = retained.profile.id;
      this.state.revealedSelection = exact; this.state.window = null; this.state.live = null; this.state.error = null;
      await this.refresh();
    } finally { this.busy = false; await this.publish(); }
  }
  private fail(error: unknown): void { this.state.error = (error instanceof Error ? error.message : 'Telemetry action failed; retained evidence is unchanged.').slice(0, 4096); this.state.stale = true; }
  private async publish(): Promise<void> {
    if (!this.panel?.visible || !isTelemetryViewState(this.state)) return;
    const digest = reviewHash(JSON.stringify(this.state)); if (digest === this.lastPublished) return;
    if (await this.panel.webview.postMessage({ schemaVersion: 1, type: 'state', state: this.state })) this.lastPublished = digest;
  }
  async show(): Promise<void> {
    if (!this.panel) {
      this.disposed = false; this.lastPublished = undefined; this.seen.clear();
      const directory = vscode.Uri.joinPath(this.context.extensionUri, 'dist'), nonce = randomBytes(16).toString('hex');
      const panel = this.panel = vscode.window.createWebviewPanel('roboticsWorkbench.telemetry', 'Telemetry & Experiments', vscode.ViewColumn.Active, { enableScripts: true, enableCommandUris: false, localResourceRoots: [directory] });
      const asset = (name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(directory, name));
      panel.webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${panel.webview.cspSource}; style-src-attr 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none';"><link rel="stylesheet" href="${asset('telemetry.css')}"><title>Telemetry & Experiments</title></head><body><div id="root"></div><script nonce="${nonce}" src="${asset('telemetry.js')}"></script></body></html>`;
      panel.webview.onDidReceiveMessage(value => { void this.handle(value); });
      panel.onDidChangeViewState(() => { this.updatePolling(); if (panel.visible) { this.lastPublished = undefined; void this.refresh(); } });
      panel.onDidDispose(() => { this.panel = undefined; this.updatePolling(); });
    }
    this.panel.reveal(); await this.refresh(); this.updatePolling();
  }
  private updatePolling(): void {
    if (this.timer) clearInterval(this.timer); this.timer = undefined;
    if (this.disposed || !this.panel?.visible) return;
    this.timer = setInterval(() => { if (!this.busy && !this.polling) void this.refresh(); }, 500);
  }
  refresh(): Promise<void> {
    if (this.refreshFlight) { this.refreshAgain = true; return this.refreshFlight; }
    this.refreshFlight = (async () => {
      do { this.refreshAgain = false; await this.refreshSnapshot(); } while (this.refreshAgain && !this.disposed);
    })().finally(() => { this.refreshFlight = undefined; });
    return this.refreshFlight;
  }
  private async refreshSnapshot(): Promise<void> {
    if (this.polling || this.disposed) return; this.polling = true;
    try {
      if (!vscode.workspace.isTrusted) { this.state = empty(); return; }
      this.bound ??= await this.host.project();
      const previous = this.state.recordings.find(r => r.recordingId === this.state.selectedRecordingId)?.completion;
      const snapshot = await this.host.request<Snapshot>(this.bound, 'telemetry.snapshot', this.historicalDerivationId ? { derivationId: this.historicalDerivationId } : {});
      const next = { ...this.state, ...snapshot, trusted: true, stale: false };
      if (this.historicalDerivationId) {
        const selected = next.recordings.find(r => r.recordingId === next.selectedRecordingId);
        if (selected) selected.limitations = [...selected.limitations, 'Historical parser pinned to the retained derivation. Current parser source edits cannot replace these values.'];
      }
      if (next.selectedRecordingId && !next.recordings.some(r => r.recordingId === next.selectedRecordingId)) { next.selectedRecordingId = null; next.window = null; next.live = null; }
      if (next.selectedProfileId && !next.profiles.some(p => p.id === next.selectedProfileId)) { next.selectedProfileId = null; next.window = null; }
      if (next.window && next.window.configurationSha256 !== next.profiles.find(p => p.id === next.selectedProfileId)?.configurationSha256) next.window = null;
      if (!isTelemetryViewState(next)) throw Error('Telemetry snapshot exceeds its bounded display contract. Retained view was preserved.');
      this.state = next;
      if (snapshot.project) this.bound.manifest.projectRevision = snapshot.project.projectRevision;
      const current = this.state.recordings.find(r => r.recordingId === this.state.selectedRecordingId);
      if (this.historicalDerivationId && !this.state.window) await this.loadSelection();
      else if (current?.completion === 'active') await this.loadLive();
      else if (previous === 'active' && current) { this.state.window = null; this.state.live = null; await this.loadSelection(); }
    } catch (error) { this.fail(error); }
    finally { this.polling = false; await this.publish(); }
  }
  private async loadLive(): Promise<void> {
    if (!this.bound || !this.state.selectedRecordingId || !this.state.selectedProfileId) return;
    const live = await this.host.request<Pick<TelemetryViewState, 'live' | 'window'>>(this.bound, 'telemetry.live', { recordingId: this.state.selectedRecordingId, profileId: this.state.selectedProfileId });
    const next = { ...this.state, ...live };
    if (!isTelemetryViewState(next)) throw Error('Live display exceeds its bound; raw capture continues independently.');
    this.state = next;
  }
  private async loadSelection(): Promise<void> {
    if (!this.bound || !this.state.project) return;
    const recording = this.state.recordings.find(r => r.recordingId === this.state.selectedRecordingId), profile = this.state.profiles.find(p => p.id === this.state.selectedProfileId);
    this.state.window = null; this.state.live = null;
    if (!recording || !profile || recording.completion === 'unavailable') return;
    if (this.historicalDerivationId && this.state.revealedSelection) {
      const selection = this.state.revealedSelection;
      this.state.window = await this.host.request<TelemetryWindow>(this.bound, 'telemetry.query', { derivationId: this.historicalDerivationId, channelIds: [...selection.channelIds], timeBasis: selection.timeBasis, start: selection.start, end: selection.end, ...(selection.deviceEpoch === undefined ? {} : { deviceEpoch: selection.deviceEpoch }) }); return;
    }
    if (recording.completion === 'active') { await this.loadLive(); return; }
    if (profile.mode === 'raw-text') {
      const raw = await this.host.request<{ text: string; truncated: boolean }>(this.bound, 'recording.query', { recordingId: recording.recordingId, channelIds: [], range: { timeBasis: 'host-receive', startMs: 0, endMs: Number.MAX_SAFE_INTEGER }, limit: 100 });
      this.state.live = { recordingId: recording.recordingId, text: raw.text.slice(0, 65536), omittedBytes: raw.truncated ? null : 0, captureActive: false }; return;
    }
    const receipt = await this.host.request<OperationReceipt>(this.bound, 'telemetry.derive', { recordingId: recording.recordingId, profileId: profile.id }, this.state.project.projectRevision);
    const completed = pending(receipt) ? await this.host.wait(this.bound, receipt) : receipt;
    if (completed.status !== 'succeeded' || typeof completed.result?.derivationId !== 'string') throw Error(completed.error?.message ?? `Derivation ended as ${completed.status}; raw evidence remains retained.`);
    const request = { derivationId: completed.result.derivationId, channelIds: profile.channels.map(c => c.channelId), timeBasis: 'host-receive', start: 0, end: Number.MAX_SAFE_INTEGER };
    const initial = await this.host.request<TelemetryWindow>(this.bound, 'telemetry.query', request);
    const end = Math.max(0, ...initial.samples.map(s => s.hostReceiveMs), ...initial.issues.map(s => s.hostReceiveMs), ...initial.gaps.flatMap(g => [g.startHostReceiveMs, g.endHostReceiveMs ?? g.startHostReceiveMs]));
    this.state.window = await this.host.request<TelemetryWindow>(this.bound, 'telemetry.query', { ...request, end });
  }
  private requireBound(): AgentProject { if (!vscode.workspace.isTrusted || !this.bound || !this.state.project) throw Error('Trust and select a local project first.'); return this.bound; }
  async handle(value: unknown): Promise<void> {
    if (!isTelemetryViewRequest(value, this.state.project?.projectId ?? null)) return;
    const hash = reviewHash(JSON.stringify(value)); if (value.type === 'ready') this.lastPublished = undefined;
    if (this.seen.has(value.requestId)) { if (this.seen.get(value.requestId) !== hash) { this.fail(Error('Request ID was reused with different inputs.')); await this.publish(); } return; }
    if (this.seen.size >= 4096) { this.fail(Error('Reopen this view to admit more requests.')); await this.publish(); return; }
    this.seen.set(value.requestId, hash);
    if (value.type === 'ready' || value.type === 'refresh') { if (value.type === 'refresh') this.state.error = null; await this.refresh(); return; }
    if (this.refreshFlight) await this.refreshFlight;
    if (this.busy) { this.fail(Error('Another evidence request is pending. Finish it before the next action.')); await this.publish(); return; }
    const baseline = structuredClone(this.state);
    this.busy = true; this.state.loading = true; this.state.error = null; await this.publish();
    try {
      const bound = this.requireBound(), p = value.payload;
      switch (value.type) {
        case 'selectRecording': {
          if (!this.state.recordings.some(r => r.recordingId === p.recordingId)) throw Error('Recording is unavailable in this project.');
          if (this.historicalDerivationId) { this.historicalDerivationId = undefined; this.state.revealedSelection = null; this.state.window = null; await this.refresh(); }
          this.state.selectedRecordingId = String(p.recordingId); await this.loadSelection(); break;
        }
        case 'selectProfile': {
          if (!this.state.recordings.some(r => r.recordingId === p.recordingId) || !this.state.profiles.some(profile => profile.id === p.profileId)) throw Error('Select a declared recording and explicit parser profile.');
          if (this.historicalDerivationId) { this.historicalDerivationId = undefined; this.state.revealedSelection = null; this.state.window = null; await this.refresh(); }
          if (!this.state.profiles.some(profile => profile.id === p.profileId)) throw Error('The historical profile is absent from current parser source. Edit parser profiles or select an available current profile.');
          this.state.selectedRecordingId = String(p.recordingId); this.state.selectedProfileId = String(p.profileId); await this.loadSelection(); break;
        }
        case 'editProfiles': await this.openProfiles(); break;
        case 'query': {
          if (p.recordingId !== this.state.selectedRecordingId || p.profileId !== this.state.selectedProfileId || !this.state.window) throw Error('Load the selected immutable derivation before querying an interval.');
          if (this.state.recordings.find(r => r.recordingId === p.recordingId)?.completion === 'active') throw Error('Finalize capture before querying immutable interval evidence. Live plots remain provisional.');
          const { recordingId, profileId, ...range } = p;
          const window = await this.host.request<TelemetryWindow>(bound, 'telemetry.query', { derivationId: this.state.window.derivationId, ...range });
          if (this.historicalDerivationId) {
            const selection = freezeTelemetrySelection({ ...this.state, window }, window.start, window.end, window.channelIds);
            if (!selection) throw Error('The queried historical interval could not be frozen against its original recording revision.');
            this.state.revealedSelection = await this.resolveSelection(selection);
          }
          this.state.window = window; break;
        }
        case 'ask': {
          const exact = await this.resolveSelection(p.selection as RecordingSelection);
          this.host.ask(exact); break;
        }
        case 'exportSelection': {
          const selection = await this.resolveSelection(p.selection as RecordingSelection);
          await this.exportFile(await this.host.request(bound, 'telemetry.exportSelection', { selection }), 'recording-interval.json'); break;
        }
        case 'stopCapture': {
          const receipt = await this.host.request<OperationReceipt>(bound, 'telemetry.stopCapture', p, this.state.project!.projectRevision);
          const done = pending(receipt) ? await this.host.wait(bound, receipt) : receipt;
          if (!['succeeded', 'cancelled'].includes(done.status)) throw Error(done.error?.message ?? `Capture ended as ${done.status}. Inspect retained partial evidence.`);
          break;
        }
        case 'createProcedure': await this.createProcedure(); break;
        case 'openProcedure': await this.openOrdinary(procedurePath, { schemaVersion: 1, procedures: [] }); break;
        case 'createRun': await this.createRun(String(p.procedureId), p.selection as RecordingSelection | undefined); break;
        case 'startRun': case 'finishRun': case 'appendNote': case 'judgeRun': await this.changeRun(value.type, String(p.experimentId), p.selection as RecordingSelection | undefined); break;
        case 'compare': this.state.comparison = await this.host.request(bound, 'experiment.compare', p); break;
        case 'exportRun': await this.exportFile(await this.host.request(bound, 'experiment.export', p), 'experiment-evidence.json'); break;
      }
      if (!isTelemetryViewState(this.state)) throw Error('Evidence action returned an invalid bounded display state. Refresh evidence to recover.');
    } catch (error) { if (!isTelemetryViewState(this.state)) this.state = baseline; this.fail(error); }
    finally { await this.refresh(); this.busy = false; this.state.loading = false; await this.publish(); }
  }
  private async resolveSelection(selection: RecordingSelection): Promise<RecordingSelection> {
    if (!isRecordingSelection(selection)) throw Error('Select an exact immutable interval.');
    const result = await this.host.request<{ selection: RecordingSelection }>(this.requireBound(), 'telemetry.selection', { selection });
    if (!isRecordingSelection(result.selection) || Object.keys(result.selection).length !== Object.keys(selection).length || Object.entries(result.selection).some(([key, v]) => JSON.stringify(v) !== JSON.stringify(selection[key as keyof RecordingSelection]))) throw Error('Retained interval differs from the supplied frozen reference; newer data was not substituted.');
    return structuredClone(result.selection);
  }
  private async exportFile(value: { path: string; sha256: string }, name: string): Promise<void> {
    if (typeof value.path !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) throw Error('Export result lacks a verified artifact identity.');
    const info = lstatSync(value.path); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 64 * 1024 * 1024) throw Error('Export is not an ordinary bounded evidence artifact.');
    const bytes = readFileSync(value.path); if (reviewHash(bytes) !== value.sha256) throw Error('Export failed exact SHA-256 verification.');
    const destination = await vscode.window.showSaveDialog({ title: 'Save exact evidence to a new file', defaultUri: vscode.Uri.file(join(this.requireBound().root, name)), filters: { Evidence: ['json'] } });
    if (!destination) return;
    if (destination.scheme !== 'file' || existsSync(destination.fsPath)) throw Error('Choose a new local filename; existing files remain preserved.');
    writeFileSync(destination.fsPath, bytes, { flag: 'wx' });
    await vscode.commands.executeCommand('vscode.open', destination);
  }
  private async openOrdinary(path: string, initial: unknown): Promise<vscode.TextDocument> {
    const bound = this.requireBound(), full = reviewPath(bound.root, path, true);
    if (!existsSync(full)) { mkdirSync(dirname(full), { recursive: true }); reviewPath(bound.root, path, true); writeFileSync(full, JSON.stringify(initial, null, 2) + '\n', { flag: 'wx' }); }
    reviewPath(bound.root, path); const document = await vscode.workspace.openTextDocument(vscode.Uri.file(full)); await vscode.window.showTextDocument(document); return document;
  }
  async openProfiles(): Promise<void> {
    if (!this.bound) { await this.refresh(); }
    await this.openOrdinary(profilesPath, { schemaVersion: 1, profiles: [{ schemaVersion: 1, id: randomUUID(), parserVersion: 'telemetry-v1', mode: 'raw-text', channels: [] }] });
  }
  private async createProcedure(): Promise<void> {
    const document = await this.openOrdinary(procedurePath, { schemaVersion: 1, procedures: [] }), bound = this.requireBound();
    const disk = reviewText(bound.root, procedurePath), version = document.version, before = document.getText();
    if (!disk || document.isDirty || reviewHash(before) !== disk.sha256) throw Error('Save or reconcile procedure edits first; dirty and external content were preserved.');
    const registry = JSON.parse(before) as { schemaVersion: number; procedures: ExperimentProcedure[] };
    if (registry.schemaVersion !== 1 || !Array.isArray(registry.procedures) || registry.procedures.length >= 100 || !registry.procedures.every(isExperimentProcedure)) throw Error('Repair the version-1 procedure registry before appending a procedure.');
    const procedure: ExperimentProcedure = { schemaVersion: 1, procedureId: randomUUID(), version: 1, purpose: 'TODO: name the test purpose', setup: ['TODO: declare required setup'], controlledInputs: ['TODO: declare controlled inputs'], instruments: ['TODO: declare instruments and uncertainty'], steps: ['TODO: declare ordered steps'], expectedOutputs: ['TODO: declare expected outputs'], tolerances: ['TODO: declare tolerances'], stopConditions: ['TODO: declare stop conditions'], decisionRules: ['TODO: declare decision rules before starting'] };
    registry.procedures.push(procedure);
    const next = JSON.stringify(registry, null, 2) + '\n', delta = minimalReviewEdit(before, next), editor = await vscode.window.showTextDocument(document);
    if (document.isDirty || document.version !== version || reviewText(bound.root, procedurePath)?.sha256 !== disk.sha256) throw Error('Concurrent procedure edit preserved; append again after reconciling.');
    if (!await editor.edit(edit => edit.replace(new vscode.Range(document.positionAt(delta.start), document.positionAt(delta.end)), delta.text))) throw Error('Native procedure patch conflicted.');
    if (document.getText() !== next || reviewText(bound.root, procedurePath)?.sha256 !== disk.sha256) throw Error('Concurrent procedure changes remain in the native buffer and disk. Reconcile before saving.');
    // Keep the draft unsaved: the user supplies the actual setup and criteria before admitting a run.
    await vscode.window.showTextDocument(document);
  }
  private async input(title: string, prompt: string, max: number, value?: string): Promise<string | undefined> {
    const result = await vscode.window.showInputBox({ title, prompt, value, ignoreFocusOut: true, validateInput: text => !text.trim() ? 'Enter an explicit value or cancel.' : text.length > max ? `Use at most ${max} characters.` : undefined });
    return result?.trim();
  }
  private procedure(id: string): { value: ExperimentProcedure; hash: string } {
    const bound = this.requireBound(), disk = reviewText(bound.root, procedurePath);
    if (!disk) throw Error('Declare and save an ordinary procedure first.');
    const full = reviewPath(bound.root, procedurePath);
    if (vscode.workspace.textDocuments.some(d => d.uri.scheme === 'file' && d.uri.fsPath.toLowerCase() === full.toLowerCase() && d.isDirty)) throw Error('Save or reconcile the dirty procedure buffer before creating a run.');
    const registry = JSON.parse(disk.text) as { schemaVersion: number; procedures: ExperimentProcedure[] }, value = registry.procedures?.find(p => p.procedureId === id);
    if (registry.schemaVersion !== 1 || !isExperimentProcedure(value) || /TODO:/.test(JSON.stringify(value))) throw Error('Complete and save all procedure setup and decision fields before creating a run.');
    return { value, hash: disk.sha256 };
  }
  private async createRun(procedureId: string, selection?: RecordingSelection): Promise<void> {
    const procedure = this.procedure(procedureId), setup = await this.input('Create experiment run', 'Describe actual setup, environment and unresolved identities. No physical action starts.', 8192);
    if (setup === undefined) return;
    const text = await vscode.window.showInputBox({ title: 'Declared run parameters', prompt: 'JSON object: each parameter has value (number/string/boolean) and unit (string/null). Use {} when none.', value: '{}', ignoreFocusOut: true, validateInput: text => { try { const value = JSON.parse(text); return !value || typeof value !== 'object' || Array.isArray(value) || text.length > 16384 ? 'Use a bounded JSON parameter object.' : undefined; } catch { return 'Enter valid JSON.'; } } });
    if (text === undefined) return;
    if (this.procedure(procedureId).hash !== procedure.hash) throw Error('Procedure changed during run preparation. Both versions remain preserved; review the latest procedure.');
    const acquisitionActive = this.state.recordings.find(r => r.recordingId === this.state.selectedRecordingId)?.completion === 'active';
    const exact = selection && !acquisitionActive ? await this.resolveSelection(selection) : undefined;
    let run = await this.host.request<ExperimentRun>(this.requireBound(), 'experiment.create', { procedureId, setup, parameters: JSON.parse(text) as Record<string, ExperimentParameter>, ...(exact ? { recordingId: exact.recordingId } : {}) }, this.state.project!.projectRevision);
    run = await this.transition(run, 'ready');
    if (exact) {
      if (exact.projectRevision !== run.projectRevision) throw Error('Run is ready, but the frozen historical interval belongs to another project revision and was not attached.');
      await this.attach(run, exact);
    }
  }
  private async transition(run: ExperimentRun, lifecycle: ExperimentRun['lifecycle']): Promise<ExperimentRun> { return this.host.request(this.requireBound(), 'experiment.transition', { experimentId: run.experimentId, expectedRevisionId: run.revisionId, lifecycle }, this.state.project!.projectRevision); }
  private async attach(run: ExperimentRun, selection: RecordingSelection): Promise<ExperimentRun> { return this.host.request(this.requireBound(), 'experiment.attach', { experimentId: run.experimentId, expectedRevisionId: run.revisionId, selection }, this.state.project!.projectRevision); }
  private async changeRun(type: 'startRun' | 'finishRun' | 'appendNote' | 'judgeRun', experimentId: string, selection?: RecordingSelection): Promise<void> {
    const summary = this.state.runs.find(r => r.experimentId === experimentId); if (!summary) throw Error('Run is unavailable in this project.');
    const bound = this.requireBound(), expectedRevisionId = summary.revisionId, revision = this.state.project!.projectRevision;
    if (type === 'startRun' || type === 'finishRun') {
      const choice = await vscode.window.showQuickPick(type === 'startRun' ? ['Start declared run record'] : ['Complete acquisition record', 'Abort run record'], { title: summary.title, placeHolder: 'This updates a run record; it does not start or stop capture, upload, or hardware.' });
      if (!choice) return;
      let run: Pick<ExperimentRun, 'experimentId' | 'revisionId'> = { experimentId, revisionId: expectedRevisionId };
      if (type === 'startRun' && summary.lifecycle === 'draft') run = await this.host.request(bound, 'experiment.transition', { experimentId, expectedRevisionId: run.revisionId, lifecycle: 'ready' }, revision);
      if (type === 'finishRun' && selection) run = await this.host.request(bound, 'experiment.attach', { experimentId, expectedRevisionId: run.revisionId, selection: await this.resolveSelection(selection) }, revision);
      await this.host.request(bound, 'experiment.transition', { experimentId, expectedRevisionId: run.revisionId, lifecycle: type === 'startRun' ? 'running' : choice === 'Abort run record' ? 'aborted' : 'completed' }, revision); return;
    }
    if (type === 'appendNote') {
      const kind = await vscode.window.showQuickPick(['Append observation or correction', ...(summary.lifecycle === 'running' ? ['Record configuration changed during run'] : [])], { title: summary.title, placeHolder: 'A configuration change records a new segment and makes whole-run comparisons unavailable.' });
      if (!kind) return;
      if (kind === 'Record configuration changed during run') {
        const reason = await this.input(summary.title, 'Reason for the configuration change during this run', 4096); if (reason === undefined) return;
        const configuration = await this.input(summary.title, 'Describe the new actual setup or configuration and where the change occurred', 8192); if (configuration === undefined) return;
        await this.host.request(bound, 'experiment.segment', { experimentId, expectedRevisionId, reason, configuration }, revision); return;
      }
      const text = await this.input(summary.title, 'Append an observation or correction. Original observations remain retained.', 4096); if (text === undefined) return;
      const reason = await this.input(summary.title, 'Reason for appending this note or correction', 4096); if (reason === undefined) return;
      await this.host.request(bound, 'experiment.note', { experimentId, expectedRevisionId, text, reason }, revision); return;
    }
    const outcome = await vscode.window.showQuickPick(['inconclusive', 'fail', ...(summary.lifecycle === 'completed' ? ['pass'] : [])], { title: `Review evidence judgment: ${summary.title}`, placeHolder: 'A plot or agent assertion is insufficient. Compare actual evidence against the declared procedure.' }); if (!outcome) return;
    const criterion = await this.input(summary.title, 'Cite the procedure criterion, actual evidence and limitations for this judgment', 4096); if (criterion === undefined) return;
    await this.host.request(bound, 'experiment.judge', { experimentId, expectedRevisionId, outcome, criterion }, revision);
  }
  dispose(): void { this.disposed = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; this.panel?.dispose(); }
}
