import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ExperimentRepository, assertSafeAgentText, type ContextCandidate } from '@robotics-workbench/application';
import { createParserProfile, queryTelemetry, StreamingTelemetryParser, type RawRecord } from '@robotics-workbench/serial';
import { canonicalJson } from '@robotics-workbench/persistence';
import { isExperimentProcedure, isRecordingSelection, isProjectRequest, isProjectResponse, WorkbenchError, type ExperimentAssociations, type ExperimentLifecycle, type ExperimentParameter, type ExperimentProcedure, type ExperimentRun, type HashedParserProfile, type OperationReceipt, type ProjectRequest, type ProjectResponse, type RecordingSelection, type RetainedTelemetryDerivation, type TelemetryBatch, type TelemetryDerivation, type TelemetryRange, type TelemetryWindow, type WorkbenchManifest } from '@robotics-workbench/contracts';
import type { TelemetryViewState } from '@robotics-workbench/webviews';
import type { ProjectService } from './project-service';
import type { BuildRecord, CaptureEvent, HardwareService, StoredRecording } from './hardware-service';
import { deriveTelemetryInWorker } from './derive-telemetry';

const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const artifactRef = ({ artifactId, sha256, mediaType, relativePath }: OperationReceipt['artifacts'][number]) => ({ artifactId, sha256, mediaType, relativePath });
type Live = { records: RawRecord[]; bytes: number; omittedBytes: number; profileSha: string | null; parser: StreamingTelemetryParser | null; batch: TelemetryBatch; count: number; id: string; error: string | null };

/** All parsing is read-only; capture continues through the one existing hardware owner. */
export class TelemetryService {
  readonly repository: ExperimentRepository;
  private readonly agentRepository: ExperimentRepository;
  private readonly live = new Map<string, Live>();
  private readonly defaultProfile: HashedParserProfile;
  constructor(private readonly project: ProjectService, private readonly hardware: HardwareService) {
    this.repository = new ExperimentRepository(project.store, 'local-host');
    this.agentRepository = new ExperimentRepository(project.store, 'agent');
    const prior = project.store.listRecords<{ kind: string; profile?: unknown }>('sessions', project.projectId).find(record => record.kind === 'telemetry-default-profile');
    this.defaultProfile = createParserProfile(prior?.profile ?? { schemaVersion: 1, id: randomUUID(), parserVersion: 'telemetry-v1', mode: 'raw-text', channels: [] });
    if (!prior) project.store.putRecord('sessions', randomUUID(), project.projectId, { kind: 'telemetry-default-profile', profile: this.defaultProfile });
    this.repository.recover(project.projectId);
    hardware.setCaptureObserver(event => this.observe(event)); project.telemetry = this;
  }
  supports(method: string): boolean { return method.startsWith('telemetry.') || method.startsWith('experiment.'); }
  private current(request?: ProjectRequest): WorkbenchManifest {
    const result = this.project.handle({ schemaVersion: 1, requestId: randomUUID(), projectId: this.project.projectId, method: 'project.snapshot', params: {} }, { includeBuilds: false });
    if (result.error) throw new WorkbenchError(result.error.code, result.error.message);
    const manifest = this.project.files.inspectManifest().manifest;
    if (request?.expectedProjectRevision !== undefined && manifest.projectRevision !== request.expectedProjectRevision) throw new WorkbenchError('REVISION_CONFLICT', 'Refresh the current project before changing experiment records.');
    const stamp = this.project.files.inspectManifest().sha256;
    const starts = this.project.store.listRecords<{ kind: string; experimentId?: string; manifestSha256?: string }>('sessions', this.project.projectId).filter(item => item.kind === 'experiment-start-intent');
    for (const run of this.repository.list(this.project.projectId).filter(run => run.lifecycle === 'running')) {
      const start = starts.filter(item => item.experimentId === run.experimentId).at(-1);
      const configuration = canonicalJson({ projectRevision: manifest.projectRevision, manifestSha256: stamp });
      if (start && start.manifestSha256 !== stamp && !run.changes.some(change => change.configuration === configuration)) this.repository.changeSegment(this.project.projectId, run.experimentId, run.revisionId, 'Design intent changed while this run was active; physical setup requires reconciliation.', configuration);
    }
    return manifest;
  }
  private config(path: string): unknown | null {
    const file = this.project.files.resolvePath(path, true); if (!existsSync(file)) return null;
    if (statSync(file).size > 256 * 1024) throw new WorkbenchError('INVALID_REQUEST', 'Telemetry configuration exceeds 256 KiB.');
    const bytes = readFileSync(file); if (bytes.length > 256 * 1024) throw new WorkbenchError('REVISION_CONFLICT', 'Configuration grew while being read.');
    const text = bytes.toString('utf8'); assertSafeAgentText(text);
    try { return JSON.parse(text); } catch { throw new WorkbenchError('INVALID_REQUEST', `Repair the ordinary ${path} source; its bytes were preserved.`); }
  }
  private profiles(): HashedParserProfile[] {
    const input = this.config('telemetry/parsers.json') as { schemaVersion?: unknown; profiles?: unknown[] } | null;
    if (!input) return [this.defaultProfile];
    if (input.schemaVersion !== 1 || Object.keys(input).sort().join(',') !== 'profiles,schemaVersion' || !Array.isArray(input.profiles) || !input.profiles.length || input.profiles.length > 64) throw new WorkbenchError('INVALID_REQUEST', 'Parser source requires schemaVersion1 and 1–64 explicit profiles.');
    const profiles = input.profiles.map(createParserProfile);
    if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) throw new WorkbenchError('INVALID_REQUEST', 'Parser profile IDs must be unique.');
    return profiles;
  }
  private profile(id: string): HashedParserProfile { const profile = this.profiles().find(item => item.id === id); if (!profile) throw new WorkbenchError('NOT_FOUND', 'The explicit parser profile is unavailable.'); return profile; }
  private procedures(): ExperimentProcedure[] {
    const input = this.config('experiments/procedures.json') as { schemaVersion?: unknown; procedures?: unknown[] } | null;
    if (!input) return [];
    if (input.schemaVersion !== 1 || Object.keys(input).sort().join(',') !== 'procedures,schemaVersion' || !Array.isArray(input.procedures) || input.procedures.length > 100 || !input.procedures.every(isExperimentProcedure)) throw new WorkbenchError('INVALID_REQUEST', 'Procedure source requires a versioned procedures array with all declared setup/criteria fields.');
    const procedures = input.procedures as ExperimentProcedure[];
    if (new Set(procedures.map(procedure => procedure.procedureId)).size !== procedures.length) throw new WorkbenchError('INVALID_REQUEST', 'Procedure IDs must be unique.');
    return procedures;
  }
  private recording(recordingId: string): StoredRecording {
    const record = this.project.store.getRecord<StoredRecording>('recordings', recordingId, this.project.projectId);
    if (record.recordingId !== recordingId || record.projectId !== this.project.projectId || !Number.isSafeInteger(record.projectRevision) || record.projectRevision < 1 || !Array.isArray(record.segments) || record.segments.length > 256) throw new WorkbenchError('ARTIFACT_MISMATCH', 'Recording metadata does not identify this project and bounded source segments.');
    return record;
  }
  private data(selection: RecordingSelection) {
    if (!isRecordingSelection(selection)) throw new WorkbenchError('INVALID_REQUEST', 'Freeze an exact finalized recording interval first.');
    const record = this.recording(selection.recordingId);
    if (record.projectRevision !== selection.projectRevision) throw new WorkbenchError('REVISION_CONFLICT', 'The selected recording belongs to a different design revision.');
    const metrics = this.repository.metrics(this.project.projectId, selection);
    return { record, metrics, derivation: this.repository.derivation(this.project.projectId, selection.derivationId) };
  }
  private observe(event: CaptureEvent): void {
    const id = event.recording.recordingId;
    if (event.type === 'start') { this.live.set(id, { records: [], bytes: 0, omittedBytes: 0, profileSha: null, parser: null, batch: { samples: [], gaps: [], issues: [] }, count: 0, id: randomUUID(), error: null }); return; }
    const live = this.live.get(id); if (!live) return;
    if (event.type === 'finish') { this.live.delete(id); return; }
    try {
      let batch: TelemetryBatch | undefined;
      if (event.type === 'record') {
        const bytes = Buffer.from(event.record.bytesBase64, 'base64').length;
        live.records.push(event.record); live.bytes += bytes;
        while (live.bytes > 1024 * 1024 && live.records.length) { const removed = live.records.shift()!; const count = Buffer.from(removed.bytesBase64, 'base64').length; live.bytes -= count; live.omittedBytes += count; }
        batch = live.parser?.push(event.record);
      } else if (event.type === 'gap') batch = live.parser?.gap(event.gap);
      if (batch) this.appendLive(live, batch);
    } catch (error) { live.error = error instanceof Error ? error.message : 'Live parser failed; raw capture continues.'; live.parser = null; }
  }
  private appendLive(live: Live, batch: TelemetryBatch): void {
    live.count += batch.samples.length;
    live.batch.samples = [...live.batch.samples, ...batch.samples].slice(-2000);
    live.batch.issues = [...live.batch.issues, ...batch.issues].slice(-100);
    live.batch.gaps = [...live.batch.gaps, ...batch.gaps].slice(-100);
  }
  private liveWindow(recordingId: string, profileId: string) {
    const active = this.hardware.liveRecordings().find(item => item.recording.recordingId === recordingId);
    if (!active) throw new WorkbenchError('NOT_FOUND', 'Capture has finalized. Select its retained recording to derive immutable evidence.');
    const live = this.live.get(recordingId), profile = this.profile(profileId);
    if (!live) return { live: { recordingId, text: active.preview.text, omittedBytes: active.recording.rawBytes, captureActive: true }, window: null };
    if (live.profileSha !== profile.configurationSha256) {
      live.parser = new StreamingTelemetryParser(profile); live.profileSha = profile.configurationSha256; live.batch = { samples: [], gaps: [], issues: [] }; live.count = 0;
      const gaps = [...active.recording.gaps].sort((a, b) => BigInt(a.startElapsedNs) < BigInt(b.startElapsedNs) ? -1 : BigInt(a.startElapsedNs) > BigInt(b.startElapsedNs) ? 1 : 0);
      let gap = 0;
      for (const record of live.records) {
        while (gap < gaps.length && BigInt(gaps[gap]!.startElapsedNs) <= BigInt(record.hostElapsedNs)) this.appendLive(live, live.parser.gap(gaps[gap++]!));
        this.appendLive(live, live.parser.push(record));
      }
      while (gap < gaps.length) this.appendLive(live, live.parser.gap(gaps[gap++]!));
      live.id = randomUUID(); live.error = null;
    }
    const captureGaps = active.recording.gaps.map(gap => ({ cause: gap.cause, connectionSessionId: gap.connectionSessionId, startHostReceiveMs: Number(BigInt(gap.startElapsedNs) / 1000n) / 1000, endHostReceiveMs: gap.endElapsedNs === null ? null : Number(BigInt(gap.endElapsedNs) / 1000n) / 1000, lostBytes: gap.lostBytes }));
    const key = (gap: TelemetryBatch['gaps'][number]) => `${gap.cause}:${gap.connectionSessionId}:${gap.startHostReceiveMs}`;
    const captureKeys = new Set(captureGaps.map(key));
    live.batch.gaps = [...live.batch.gaps.filter(gap => !captureKeys.has(key(gap))), ...captureGaps].sort((a, b) => a.startHostReceiveMs - b.startHostReceiveMs).slice(-100);
    let window: TelemetryWindow | null = null;
    if (profile.channels.length && live.batch.samples.length) {
      const start = live.batch.samples[0]!.hostReceiveMs, end = live.batch.samples.at(-1)!.hostReceiveMs;
      const transient: TelemetryDerivation = { schemaVersion: 1, ...live.batch, recordingId, derivationId: live.id, derivationSha256: sha(canonicalJson(live.batch)), rawSha256: active.recording.rawSha256, segmentSha256s: active.recording.segments.map(segment => segment.sha256), parserVersion: profile.parserVersion, configurationSha256: profile.configurationSha256, profile };
      window = queryTelemetry(transient, { channelIds: profile.channels.map(channel => channel.channelId), timeBasis: 'host-receive', start, end, limit: 500 });
      window.displayResolution = `Transient live window: latest ${live.batch.samples.length} parsed samples and up to 100 gap/issue markers. Full raw capture remains separate; finalization is required before freezing evidence. ${live.omittedBytes ? `${live.omittedBytes} earlier bytes left the display ring.` : ''} ${live.error ?? ''}`;
      window.totalSamples = Math.max(window.totalSamples, live.count); window.downsampled ||= live.count > window.samples.length;
    }
    return { live: { recordingId, text: active.preview.text, omittedBytes: live.omittedBytes, captureActive: true }, window };
  }
  private async derive(request: ProjectRequest): Promise<OperationReceipt> {
    try {
      const existing = this.project.store.getOperationByRequest(request.projectId, request.requestId), { startedAt, finishedAt, result, error, ...queued } = existing;
      return this.project.store.createOperation({ ...queued, status: 'queued', artifacts: [] }, request);
    } catch (error) { if (!(error instanceof WorkbenchError) || error.code !== 'NOT_FOUND') throw error; }
    const manifest = this.current(request), record = this.recording(String(request.params.recordingId)), profile = this.profile(String(request.params.profileId));
    const receipt: OperationReceipt = { schemaVersion: 1, requestId: request.requestId, operationId: randomUUID(), projectId: request.projectId, kind: 'experiment-record', status: 'queued', expectedProjectRevision: manifest.projectRevision, createdAt: new Date().toISOString(), tool: { name: 'telemetry-derive', version: profile.parserVersion }, artifacts: [] };
    return this.project.jobs.submit({ receipt, payload: request, heavy: true, execute: async ({ signal }) => {
      const derivation = await deriveTelemetryInWorker(this.project.store, record, profile, signal);
      const rawArtifacts = record.segments.map(segment => this.project.store.getArtifact(request.projectId, segment.artifactId));
      const retained = this.repository.retainDerivation(request.projectId, derivation, rawArtifacts, { ...record, segments: record.segments.map(({ path, ...segment }) => segment) });
      const artifact = this.project.store.getArtifact(request.projectId, retained.parsedArtifact.artifactId);
      return { artifacts: [artifactRef(artifact)], result: { derivationId: retained.derivationId, recordingId: retained.recordingId, configurationSha256: retained.configurationSha256 } };
    } });
  }
  private associations(record?: StoredRecording): ExperimentAssociations {
    const unknown = (reason: string) => ({ id: null, reason }), known = (id: string) => ({ id, reason: null });
    const result: ExperimentAssociations = { sourceSnapshotId: unknown('No exact recorded source snapshot.'), buildId: unknown('No exact recorded build.'), uploadOperationId: record?.uploadReceiptId ? known(record.uploadReceiptId) : unknown('Recording has no matching upload receipt.'), deviceId: record ? known(record.deviceId) : unknown('No recorded device observation.'), deviceObservationId: unknown('Device observation is unavailable.'), firmwareSha256: record?.firmwareSha256 ? known(record.firmwareSha256) : unknown('Firmware identity is unknown.') };
    if (!record) return result;
    const observations = this.project.store.listRecords<{ kind?: string; recordingId?: string; recording?: { recordingId: string }; observation?: { observationId: string } }>('observations', this.project.projectId);
    const observation = observations.find(item => item.kind === 'capture-intent' && item.recording?.recordingId === record.recordingId)?.observation;
    if (observation?.observationId) result.deviceObservationId = known(observation.observationId);
    if (record.gaps.some(gap => gap.cause === 'upload') || observations.some(item => item.kind === 'capture-firmware-transition' && item.recordingId === record.recordingId)) {
      const reason = 'Firmware may have changed during this recording; whole-record upload/build/source identity is unknown until exact segment binding is supplied.';
      result.uploadOperationId = unknown(reason); result.firmwareSha256 = unknown(reason); result.buildId = unknown(reason); result.sourceSnapshotId = unknown(reason); return result;
    }
    const upload = this.project.store.listRecords<{ operationId: string; buildId: string }>('uploads', this.project.projectId).find(item => item.operationId === record.uploadReceiptId);
    if (upload) { result.buildId = known(upload.buildId); try { const build = this.project.store.getRecord<BuildRecord>('builds', upload.buildId, this.project.projectId); result.sourceSnapshotId = known(build.sourceSnapshotId); } catch { result.sourceSnapshotId = unknown('The matching build source snapshot is unavailable.'); } }
    return result;
  }
  private export(bytes: Uint8Array) {
    const artifact = this.project.store.storeArtifact(this.project.projectId, bytes, 'application/json');
    return { path: join(this.project.store.dataRoot, artifact.relativePath), sha256: artifact.sha256 };
  }
  context(selection: RecordingSelection): ContextCandidate {
    const { record, metrics, derivation } = this.data(selection);
    const summary = JSON.stringify({ selection, derivationSha256: derivation.derivationSha256, statistics: metrics, gaps: derivation.gaps.slice(0, 16), parseIssues: derivation.issues.slice(0, 16), omittedGaps: Math.max(0, derivation.gaps.length - 16), omittedIssues: Math.max(0, derivation.issues.length - 16), notice: 'Historical recording evidence. Receive time is not acquisition time; no physical judgment follows from plotting.' });
    if (Buffer.byteLength(summary) > 7000) throw new WorkbenchError('INVALID_REQUEST', 'Narrow the selected channels or interval; exact diagnostic context exceeds its bounded excerpt.');
    const retained = this.project.store.listRecords<RetainedTelemetryDerivation>('experiments', this.project.projectId).find(item => item.kind === 'telemetry-derivation' && item.derivationId === selection.derivationId)!;
    return { entityIds: [selection.recordingId], expansionHandle: `telemetry:${selection.derivationId}`, evidence: { evidenceId: selection.derivationId, artifactId: retained.parsedArtifact.artifactId, sha256: retained.parsedArtifact.sha256, basis: 'reported', sourceUri: `recording://${selection.recordingId}/${selection.derivationId}`, location: { kind: 'recording-range', start: selection.start, end: selection.end, timeBasis: selection.timeBasis }, projectRevision: record.projectRevision, observedAt: record.finishedAt ?? record.startedAt, applicability: 'historical', summary } };
  }
  private snapshot(manifest: WorkbenchManifest, derivationId?: string) {
    const records = this.project.store.listRecords<StoredRecording>('recordings', this.project.projectId).slice(-100);
    const transitions = new Set(this.project.store.listRecords<{ kind?: string; recordingId?: string }>('observations', this.project.projectId).filter(item => item.kind === 'capture-firmware-transition').map(item => item.recordingId));
    if (derivationId) { const recordingId = this.repository.derivation(this.project.projectId, derivationId).recordingId; if (!records.some(record => record.recordingId === recordingId)) records.push(this.recording(recordingId)); }
    const recordings: TelemetryViewState['recordings'] = records.map(record => {
      const available = record.segments.every(segment => { try { const artifact = this.project.store.getArtifact(this.project.projectId, segment.artifactId), info = lstatSync(join(this.project.store.dataRoot, artifact.relativePath)); return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size === artifact.sizeBytes; } catch { return false; } });
      const changed = transitions.has(record.recordingId) || record.gaps.some(gap => gap.cause === 'upload');
      return { recordingId: record.recordingId, projectRevision: record.projectRevision, startedAt: record.startedAt, completion: !available ? 'unavailable' : record.status === 'completed' ? 'complete' : 'partial', device: record.deviceId, artifactSha256: changed ? null : record.firmwareSha256 ?? null, limitations: [!available ? 'Raw evidence is missing or incomplete. Prior capture status is historical.' : 'Raw file presence checked; exact checksums are verified on derivation/query.', record.status !== 'completed' ? `Retained ${record.status} acquisition; partial evidence.` : 'Uploader identity and physical behavior remain separate.', ...(!record.firmwareSha256 || changed ? ['Whole-record firmware identity unknown.'] : [])] };
    });
    for (const active of this.hardware.liveRecordings()) recordings.push({ recordingId: active.recording.recordingId, projectRevision: active.recording.projectRevision, startedAt: active.recording.startedAt, completion: 'active', device: active.recording.deviceId, artifactSha256: null, limitations: ['Capture active; live display is provisional.'] });
    const runs: TelemetryViewState['runs'] = this.repository.list(this.project.projectId).slice(-100).map(run => ({ experimentId: run.experimentId, revisionId: run.revisionId, title: run.procedure.purpose.slice(0, 512), procedureId: run.procedure.procedureId, procedureVersion: run.procedure.version, projectRevision: run.projectRevision, lifecycle: run.lifecycle, outcome: run.judgment.outcome, recordingIds: [...new Set(run.selections.map(selection => selection.recordingId))], parameters: Object.entries(run.parameters).slice(0, 8).map(([name, parameter]) => ({ name, value: String(parameter.value).slice(0, 256), unit: parameter.unit })), limitations: ['Historical judgment; exact evidence integrity is rechecked on query, comparison, judgment and export.', ...(Object.keys(run.parameters).length > 8 || Object.values(run.parameters).some(parameter => String(parameter.value).length > 256) ? ['Parameter preview shows up to 8 values of 256 characters. Export the run for complete retained parameters.'] : []), ...(run.comparable ? [] : ['Configuration changed during this run.']), ...Object.entries(run.associations).filter(([, value]) => value.id === null).map(([name, value]) => `${name}: ${value.reason}`)] }));
    let profiles: HashedParserProfile[];
    try { profiles = this.profiles(); } catch (error) { if (!derivationId) throw error; profiles = []; recordings.forEach(record => record.limitations.push('Current parser source is invalid; this historical view uses its exact retained configuration.')); }
    if (derivationId) { const historical = this.repository.derivation(this.project.projectId, derivationId).profile; profiles = [...profiles.filter(profile => profile.id !== historical.id), historical]; }
    let procedures: ExperimentProcedure[];
    try { procedures = this.procedures(); } catch { procedures = []; recordings.forEach(record => record.limitations.push('Procedure source is invalid; existing recording and run history remain retained. Open the ordinary procedure file to repair it.')); }
    return { project: { projectId: manifest.projectId, projectRevision: manifest.projectRevision, name: manifest.name }, recordings, profiles, procedures: procedures.map(procedure => ({ procedureId: procedure.procedureId, version: procedure.version, title: procedure.purpose.slice(0, 512) })), runs };
  }
  async handle(value: unknown): Promise<ProjectResponse> {
    if (!isProjectRequest(value) || value.projectId !== this.project.projectId || !this.supports(value.method)) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Invalid telemetry request scope.');
    try {
      if (value.method === 'telemetry.derive') return { schemaVersion: 1, requestId: value.requestId, result: await this.derive(value) };
      const mutation = value.method.startsWith('experiment.') && !['experiment.compare', 'experiment.export'].includes(value.method);
      if (mutation) {
        let previous: { kind: string; payloadSha256: string; result: unknown } | undefined;
        try { previous = this.project.store.getRecord('sessions', value.requestId, value.projectId); } catch (error) { if (!(error instanceof WorkbenchError) || error.code !== 'NOT_FOUND') throw error; }
        if (previous) {
          if (previous.kind !== 'experiment-request-result' || previous.payloadSha256 !== sha(canonicalJson(value))) throw new WorkbenchError('REQUEST_ID_CONFLICT', 'Request ID already identifies different experiment intent.');
          return { schemaVersion: 1, requestId: value.requestId, result: previous.result };
        }
      }
      const manifest = this.current(value), p = value.params;
      let result: unknown;
      if (value.method === 'telemetry.snapshot') result = this.snapshot(manifest, p.derivationId as string | undefined);
      else if (value.method === 'telemetry.inspect') { const data = this.repository.derivation(value.projectId, String(p.derivationId)); result = { profile: data.profile, recordingId: data.recordingId, projectRevision: this.recording(data.recordingId).projectRevision }; }
      else if (value.method === 'telemetry.live') result = this.liveWindow(String(p.recordingId), String(p.profileId));
      else if (value.method === 'telemetry.query') result = queryTelemetry(this.repository.derivation(value.projectId, String(p.derivationId)), { ...p as unknown as TelemetryRange, limit: 500 });
      else if (value.method === 'telemetry.selection') { const selection = p.selection as RecordingSelection; result = { selection, metrics: this.data(selection).metrics }; }
      else if (value.method === 'telemetry.exportSelection') {
        const selection = p.selection as RecordingSelection, { metrics, derivation } = this.data(selection);
        const window = queryTelemetry(derivation, { ...selection, limit: 10000 });
        const samples = derivation.samples.filter(sample => {
          const time = selection.timeBasis === 'host-receive' ? sample.hostReceiveMs : sample.deviceEpoch === selection.deviceEpoch ? sample.deviceTimeMs : null;
          return selection.channelIds.includes(sample.channelId) && time !== null && time >= selection.start && time <= selection.end;
        });
        const provenance = { recordingId: derivation.recordingId, originalDerivationId: derivation.derivationId, originalDerivationSha256: derivation.derivationSha256, rawSha256: derivation.rawSha256, segmentSha256s: derivation.segmentSha256s, parserVersion: derivation.parserVersion, configurationSha256: derivation.configurationSha256, profile: derivation.profile };
        result = this.export(Buffer.from(JSON.stringify({ schemaVersion: 1, selection, metrics, provenance, samples, gaps: window.gaps, issues: window.issues, limitations: ['Only the exact selected channels, inclusive interval and clock epoch are exported at full sample resolution; no display decimation or interpolation is applied.', 'Provenance identifies the unchanged complete original derivation. Raw hashes are references only; original raw bytes and unselected sample values are not included.', ...(selection.timeBasis === 'device' ? ['Capture gaps and parser issues use host receive time and cannot be placed within this device-clock interval without an explicit clock mapping; all such gaps/issues are disclosed.'] : []), 'No physical judgment is inferred.'] })));
      }
      else if (value.method === 'telemetry.stopCapture') {
        const intent = this.project.store.getRecord<{ operationId: string; kind: string }>('observations', String(p.recordingId), value.projectId);
        if (intent.kind !== 'capture-intent' || this.project.store.getOperation(value.projectId, intent.operationId).kind !== 'serial-capture') throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'This reference does not identify a capture.');
        const admitted = this.project.store.admitCancellation(value.projectId, value.requestId, intent.operationId, value);
        result = admitted ? this.project.jobs.requestCancel(value.projectId, intent.operationId) : this.project.store.getOperation(value.projectId, intent.operationId);
      } else if (value.method === 'experiment.compare') {
        const ids = p.experimentIds as string[], runs = ids.map(id => this.repository.get(value.projectId, id)), warnings: string[] = [];
        for (const id of ids.slice(1)) warnings.push(...this.repository.compare(value.projectId, ids[0]!, id).incompatibilities);
        const series = runs.flatMap(run => run.selections.slice(0, 1).map(selection => ({ seriesKey: `${run.experimentId}:${selection.derivationId}`, label: run.procedure.purpose.slice(0, 256), unit: this.repository.metrics(value.projectId, selection)[0]?.unit ?? null, window: queryTelemetry(this.repository.derivation(value.projectId, selection.derivationId), { ...selection, limit: 200 }) })));
        result = { experimentIds: ids, compatible: warnings.length === 0, warnings: [...new Set(warnings)], differences: [{ field: 'Project revision', values: runs.map(run => String(run.projectRevision)) }, { field: 'Procedure/version', values: runs.map(run => `${run.procedure.procedureId}/${run.procedure.version}`) }, { field: 'Parameters (preview; export for full values)', values: runs.map(run => canonicalJson(run.parameters).slice(0, 2048)) }, { field: 'Declared setup (preview)', values: runs.map(run => run.setup.slice(0, 2048)) }, { field: 'Firmware', values: runs.map(run => run.associations.firmwareSha256.id ?? 'Unknown') }], series };
      } else if (value.method === 'experiment.export') result = this.export(Buffer.from(JSON.stringify(this.repository.export(value.projectId, String(p.experimentId)))));
      else {
        if (!this.project.store.admitRequest(value.projectId, value.requestId, value)) throw new WorkbenchError('OUTCOME_UNKNOWN', 'Experiment mutation was already admitted. Refresh its durable revisions; do not blindly repeat it.');
        if (value.method === 'experiment.create') {
          const procedure = this.procedures().find(item => item.procedureId === p.procedureId);
          if (!procedure) throw new WorkbenchError('NOT_FOUND', 'Complete and save the ordinary procedure source first.');
          if (/\bTODO\b/i.test(JSON.stringify(procedure))) throw new WorkbenchError('INVALID_REQUEST', 'Replace all TODO procedure fields with your actual setup and decision rules.');
          const record = p.recordingId ? this.recording(String(p.recordingId)) : undefined;
          result = this.repository.create({ projectId: value.projectId, projectRevision: record?.projectRevision ?? manifest.projectRevision, procedureBytes: Buffer.from(canonicalJson(procedure)), setup: String(p.setup), parameters: p.parameters as Record<string, ExperimentParameter>, associations: this.associations(record) });
        } else if (value.method === 'experiment.transition') {
          result = this.repository.transition(value.projectId, String(p.experimentId), String(p.expectedRevisionId), p.lifecycle as ExperimentLifecycle);
          if (p.lifecycle === 'running') this.project.store.putRecord('sessions', randomUUID(), value.projectId, { kind: 'experiment-start-intent', experimentId: p.experimentId, manifestSha256: this.project.files.inspectManifest().sha256, projectRevision: manifest.projectRevision });
        }
        else if (value.method === 'experiment.attach') {
          const source = this.data(p.selection as RecordingSelection), run = this.repository.get(value.projectId, String(p.experimentId)), associations = this.associations(source.record);
          for (const key of Object.keys(run.associations) as (keyof ExperimentAssociations)[]) if (run.associations[key].id !== null && run.associations[key].id !== associations[key].id) throw new WorkbenchError('ARTIFACT_MISMATCH', `Recording ${key} differs from the declared run. Preserve the evidence and declare a new applicable run or setup segment.`);
          result = this.repository.attachSelection(value.projectId, String(p.experimentId), String(p.expectedRevisionId), p.selection as RecordingSelection);
        }
        else if (value.method === 'experiment.note' || value.method === 'experiment.record') result = (value.method === 'experiment.record' ? this.agentRepository : this.repository).note(value.projectId, String(p.experimentId), String(p.expectedRevisionId), { author: value.method === 'experiment.record' ? 'agent-observation' : 'local-user', reason: String(p.reason), text: String(p.text) });
        else if (value.method === 'experiment.segment') result = this.repository.changeSegment(value.projectId, String(p.experimentId), String(p.expectedRevisionId), String(p.reason), String(p.configuration));
        else if (value.method === 'experiment.judge') result = this.repository.judge(value.projectId, String(p.experimentId), String(p.expectedRevisionId), { outcome: p.outcome as 'pass' | 'fail' | 'inconclusive', evaluator: 'local-user', criterion: String(p.criterion), evidenceRevisionIds: [String(p.expectedRevisionId)] });
        else throw new WorkbenchError('UNKNOWN_METHOD', 'Unsupported experiment action.');
      }
      const response: ProjectResponse = { schemaVersion: 1, requestId: value.requestId, result };
      if (!isProjectResponse(response)) throw new WorkbenchError('INVALID_REQUEST', 'Telemetry result exceeds its bounded message contract. Narrow channels or interval.');
      if (mutation) this.project.store.putRecord('sessions', value.requestId, value.projectId, { kind: 'experiment-request-result', payloadSha256: sha(canonicalJson(value)), result });
      return response;
    } catch (error) { const known = error instanceof WorkbenchError ? error : new WorkbenchError('TELEMETRY_UNAVAILABLE', 'Telemetry operation failed; original recordings remain retained.'); return { schemaVersion: 1, requestId: value.requestId, error: { code: known.code, message: known.message.slice(0, 4096), retryable: false } }; }
  }
}
