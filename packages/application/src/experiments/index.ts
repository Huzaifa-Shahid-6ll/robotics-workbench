import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { WorkbenchError, isRequestId, isExperimentProcedure, isTelemetryDerivation, isRecordingSelection, type EvidenceArtifact, type ExperimentAssociations, type ExperimentComparison, type ExperimentLifecycle, type ExperimentMetric, type ExperimentParameter, type ExperimentProcedure, type ExperimentRun, type RetainedTelemetryDerivation, type RecordingSelection, type TelemetryDerivation } from '@robotics-workbench/contracts';
import { assertSafeAgentText } from '../context/index';

export interface ExperimentStorage {
  getProject(projectId: string): unknown;
  storeArtifact(projectId: string, bytes: Uint8Array, mediaType: string): EvidenceArtifact;
  readArtifact(projectId: string, artifactId: string): Uint8Array;
  putRecord(table: 'experiments', id: string, projectId: string, value: unknown): void;
  getRecord<T>(table: 'experiments', id: string, projectId: string): T;
  listRecords<T>(table: 'experiments', projectId: string): T[];
}
export type ExperimentDraft = { projectId: string; projectRevision: number; procedureBytes: Uint8Array; parameters: Record<string, ExperimentParameter>; setup: string; associations: ExperimentAssociations };
export type ExperimentExport = { schemaVersion: 1; kind: 'experiment-evidence-export'; projectId: string; runs: ExperimentRun[]; derivations: RetainedTelemetryDerivation[]; metrics: ExperimentMetric[]; artifacts: (EvidenceArtifact & { bytesBase64: string })[]; limitations: string[]; manifestSha256: string };
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function invalid(message: string): never { throw new WorkbenchError('INVALID_REQUEST', message); }
function mismatch(message: string): never { throw new WorkbenchError('ARTIFACT_MISMATCH', message); }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function parseEvidence<T>(bytes: Uint8Array): T { try { return JSON.parse(Buffer.from(bytes).toString('utf8')) as T; } catch { return mismatch('Retained evidence JSON is invalid.'); } }
function bounded(value: unknown, limit = 256 * 1024): void {
  const bytes = encode(value); if (bytes.length > limit) invalid('Experiment metadata exceeds its bound.');
  assertSafeAgentText(bytes.toString('utf8'));
}
function artifact(value: EvidenceArtifact): boolean { return !!value && isRequestId(value.artifactId) && digest(value.sha256) && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes >= 0; }
function validateDraft(input: ExperimentDraft): ExperimentProcedure {
  if (!isRequestId(input.projectId) || !Number.isSafeInteger(input.projectRevision) || input.projectRevision < 1 || !(input.procedureBytes instanceof Uint8Array) || input.procedureBytes.length > 256 * 1024) invalid('Run requires exact bounded procedure bytes and project revision.');
  let procedure: unknown; try { procedure = JSON.parse(Buffer.from(input.procedureBytes).toString('utf8')); } catch { invalid('Procedure must be valid JSON.'); }
  if (!isExperimentProcedure(procedure)) invalid('Procedure requires setup, inputs, instruments, steps, outputs, tolerances, stop conditions and decision rules.');
  if (typeof input.setup !== 'string' || !input.setup || input.setup.length > 8192 || !input.parameters || typeof input.parameters !== 'object' || Array.isArray(input.parameters) || Object.keys(input.parameters).length > 100) invalid('Run requires bounded declared setup and parameters.');
  for (const [name, parameter] of Object.entries(input.parameters)) {
    if (!name || name.length > 128 || !parameter || Object.keys(parameter).sort().join(',') !== 'unit,value' || !['number', 'string', 'boolean'].includes(typeof parameter.value) || typeof parameter.value === 'number' && !Number.isFinite(parameter.value) || typeof parameter.value === 'string' && parameter.value.length > 4096 || parameter.unit !== null && (typeof parameter.unit !== 'string' || !parameter.unit || parameter.unit.length > 32)) invalid('Parameters require finite values and declared units or explicit unknown units.');
  }
  const keys = ['sourceSnapshotId', 'buildId', 'uploadOperationId', 'deviceId', 'deviceObservationId', 'firmwareSha256'];
  if (!input.associations || Object.keys(input.associations).sort().join(',') !== keys.sort().join(',')) invalid('All source/build/upload/device associations must be declared.');
  for (const [key, association] of Object.entries(input.associations)) {
    if (!association || Object.keys(association).sort().join(',') !== 'id,reason' || (association.id === null ? typeof association.reason !== 'string' || !association.reason || association.reason.length > 2048 : !(key === 'firmwareSha256' ? digest(association.id) : isRequestId(association.id)) || association.reason !== null)) invalid('Unknown associations need explicit null and reason; known associations need exact identities.');
  }
  bounded({ procedure, setup: input.setup, parameters: input.parameters, associations: input.associations });
  return procedure as ExperimentProcedure;
}

/** Records are append-only; no method opens hardware or edits raw artifacts. */
export class ExperimentRepository {
  constructor(private readonly storage: ExperimentStorage, private readonly actor: 'local-host' | 'agent' = 'agent') {}
  private bytes(projectId: string, reference: EvidenceArtifact): Uint8Array {
    if (!artifact(reference)) mismatch('Invalid evidence artifact reference.');
    const bytes = this.storage.readArtifact(projectId, reference.artifactId);
    if (bytes.length !== reference.sizeBytes || sha(bytes) !== reference.sha256) mismatch('Retained evidence is incomplete or corrupt; original references remain intact.');
    return bytes;
  }
  retainDerivation(projectId: string, derivation: TelemetryDerivation, rawArtifacts: EvidenceArtifact[], recordingMetadata: Record<string, unknown> | null = null): RetainedTelemetryDerivation {
    this.storage.getProject(projectId);
    if (!isTelemetryDerivation(derivation) || !Array.isArray(rawArtifacts) || !rawArtifacts.length || rawArtifacts.length > 1024 || !rawArtifacts.every(artifact) || JSON.stringify(rawArtifacts.map(item => item.sha256)) !== JSON.stringify(derivation.segmentSha256s)) invalid('Derivation must identify the exact retained segments and explicit parser configuration.');
    bounded(recordingMetadata);
    for (const reference of rawArtifacts) this.bytes(projectId, reference);
    const retained = this.storage.listRecords<RetainedTelemetryDerivation>('experiments', projectId).find(item => item.kind === 'telemetry-derivation' && item.derivationId === derivation.derivationId);
    const bytes = encode(derivation);
    if (bytes.length > 64 * 1024 * 1024) invalid('Parsed derivation exceeds 64 MiB.');
    if (retained) { if (sha(bytes) !== retained.parsedArtifact.sha256) mismatch('A derivation identity cannot replace retained values.'); this.derivation(projectId, derivation.derivationId); return retained; }
    const record: RetainedTelemetryDerivation = { schemaVersion: 1, kind: 'telemetry-derivation', recordId: randomUUID(), projectId, derivationId: derivation.derivationId, derivationSha256: derivation.derivationSha256, recordingId: derivation.recordingId, parserVersion: derivation.parserVersion, configurationSha256: derivation.configurationSha256, parsedArtifact: this.storage.storeArtifact(projectId, bytes, 'application/json'), rawArtifacts: clone(rawArtifacts), recordingMetadata: clone(recordingMetadata) };
    this.storage.putRecord('experiments', record.recordId, projectId, record); return clone(record);
  }
  derivation(projectId: string, derivationId: string): TelemetryDerivation {
    const record = this.storage.listRecords<RetainedTelemetryDerivation>('experiments', projectId).find(item => item.kind === 'telemetry-derivation' && item.derivationId === derivationId);
    if (!record) throw new WorkbenchError('NOT_FOUND', 'Exact historical derivation is unavailable; newer recordings were not substituted.');
    record.rawArtifacts.forEach(reference => this.bytes(projectId, reference));
    let value: TelemetryDerivation;
    try { value = JSON.parse(Buffer.from(this.bytes(projectId, record.parsedArtifact)).toString('utf8')) as TelemetryDerivation; } catch (error) { if (error instanceof WorkbenchError) throw error; return mismatch('Retained parsed JSON is invalid.'); }
    if (!isTelemetryDerivation(value) || value.derivationId !== derivationId || value.derivationSha256 !== record.derivationSha256 || value.recordingId !== record.recordingId || value.configurationSha256 !== record.configurationSha256 || value.parserVersion !== record.parserVersion || JSON.stringify(value.segmentSha256s) !== JSON.stringify(record.rawArtifacts.map(item => item.sha256))) mismatch('Retained derivation identity differs from its immutable index.');
    return value;
  }
  metrics(projectId: string, selection: RecordingSelection): ExperimentMetric[] {
    if (!isRecordingSelection(selection)) invalid('Selection must freeze exact recording, derivation, channels, clock and interval.');
    const data = this.derivation(projectId, selection.derivationId);
    if (selection.recordingId !== data.recordingId || selection.parserVersion !== data.parserVersion || selection.configurationSha256 !== data.configurationSha256 || selection.channelIds.some(id => !data.profile.channels.some(channel => channel.channelId === id))) mismatch('Selection differs from its exact retained derivation.');
    if (selection.timeBasis === 'device' && data.samples.some(sample => selection.channelIds.includes(sample.channelId) && sample.deviceTimeMs === null)) invalid('Device acquisition time is unavailable; host receive time was not substituted.');
    const selected = data.samples.filter(sample => selection.channelIds.includes(sample.channelId) && (selection.timeBasis !== 'device' || sample.deviceEpoch === selection.deviceEpoch)).filter(sample => { const time = selection.timeBasis === 'host-receive' ? sample.hostReceiveMs : sample.deviceTimeMs; return time !== null && time >= selection.start && time <= selection.end; });
    const gaps = selection.timeBasis === 'host-receive' ? data.gaps.filter(gap => gap.startHostReceiveMs <= selection.end && (gap.endHostReceiveMs === null || gap.endHostReceiveMs >= selection.start)).length : data.gaps.length;
    const issues = selection.timeBasis === 'host-receive' ? data.issues.filter(issue => issue.hostReceiveMs >= selection.start && issue.hostReceiveMs <= selection.end).length : data.issues.length;
    return selection.channelIds.map(channelId => {
      const samples = selected.filter(sample => sample.channelId === channelId), values = samples.map(sample => sample.value), unit = data.profile.channels.find(channel => channel.channelId === channelId)!.unit;
      let runningMean = 0, count = 0, min: number | null = null, max: number | null = null;
      for (const value of values) {
        if (!Number.isFinite(value)) mismatch('Derived numeric sample is not finite.');
        count++; runningMean = runningMean * ((count - 1) / count) + value / count;
        min = min === null ? value : Math.min(min, value); max = max === null ? value : Math.max(max, value);
      }
      const mean = values.length ? runningMean : null;
      if (mean !== null && !Number.isFinite(mean)) invalid('Statistics overflowed; no unsupported numeric result was emitted.');
      return { formulaVersion: 'sample-statistics-v1', channelId, unit, count: values.length, min, max, mean, missingData: 'exclude-absent-no-interpolation', gaps, issues, formula: { mean: 'sum(value)/count', interval: 'inclusive', weighting: 'sample' }, selection: clone(selection) };
    });
  }
  create(input: ExperimentDraft): ExperimentRun {
    this.storage.getProject(input.projectId); const procedure = validateDraft(input), now = new Date().toISOString();
    if (this.storage.listRecords<ExperimentRun>('experiments', input.projectId).some(run => run.kind === 'experiment-run' && run.procedure.procedureId === procedure.procedureId && run.procedure.version === procedure.version && run.procedureArtifact.sha256 !== sha(input.procedureBytes))) throw new WorkbenchError('REVISION_CONFLICT', 'Procedure identity/version already has different retained bytes. Increment the ordinary-file procedure version; old runs remain unchanged.');
    const run: ExperimentRun = { schemaVersion: 1, kind: 'experiment-run', experimentId: randomUUID(), revisionId: randomUUID(), previousRevisionId: null, revision: 1, projectId: input.projectId, projectRevision: input.projectRevision, lifecycle: 'draft', procedure: clone(procedure), procedureArtifact: this.storage.storeArtifact(input.projectId, Uint8Array.from(input.procedureBytes), 'application/json'), parameters: clone(input.parameters), setup: input.setup, associations: clone(input.associations), createdAt: now, changedAt: now, startedAt: null, finishedAt: null, frozenConfigurationSha256: null, selections: [], metricArtifacts: [], comparable: true, changes: [], notes: [], judgment: { outcome: 'not-evaluated', evaluator: null, criterion: null, evidenceRevisionIds: [], at: null }, revisionReason: 'Run drafted.' };
    this.storage.putRecord('experiments', run.revisionId, run.projectId, run); return clone(run);
  }
  history(projectId: string, experimentId: string): ExperimentRun[] { return this.storage.listRecords<ExperimentRun>('experiments', projectId).filter(item => item.kind === 'experiment-run' && item.experimentId === experimentId); }
  list(projectId: string): ExperimentRun[] { const latest = new Map<string, ExperimentRun>(); for (const run of this.storage.listRecords<ExperimentRun>('experiments', projectId)) if (run.kind === 'experiment-run') latest.set(run.experimentId, run); return [...latest.values()]; }
  get(projectId: string, experimentId: string): ExperimentRun { const run = this.history(projectId, experimentId).at(-1); if (!run) throw new WorkbenchError('NOT_FOUND', 'Experiment is unavailable in this project.'); return run; }
  inspectEvidence(projectId: string, experimentId: string): { status: 'available' | 'incomplete'; errors: string[] } {
    const run = this.get(projectId, experimentId), errors: string[] = [];
    if (!run.selections.length) errors.push('No acquisition interval is attached.');
    try { this.bytes(projectId, run.procedureArtifact); this.retainedMetrics(projectId, run); }
    catch (error) { errors.push(error instanceof WorkbenchError ? `${error.code}: ${error.message}` : 'Evidence could not be verified.'); }
    return { status: errors.length ? 'incomplete' : 'available', errors };
  }
  private append(projectId: string, experimentId: string, expectedRevisionId: string, reason: string, change: (run: ExperimentRun) => void): ExperimentRun {
    const run = clone(this.get(projectId, experimentId));
    if (run.revisionId !== expectedRevisionId) throw new WorkbenchError('REVISION_CONFLICT', 'Run changed; inspect the current revision before appending.');
    run.previousRevisionId = run.revisionId; run.revisionId = randomUUID(); run.revision++; run.changedAt = new Date().toISOString(); run.revisionReason = reason;
    change(run); bounded(run); this.storage.putRecord('experiments', run.revisionId, projectId, run); return clone(run);
  }
  transition(projectId: string, experimentId: string, expectedRevisionId: string, lifecycle: ExperimentLifecycle): ExperimentRun {
    return this.append(projectId, experimentId, expectedRevisionId, `Lifecycle: ${lifecycle}.`, run => {
      const allowed: Record<ExperimentLifecycle, ExperimentLifecycle[]> = { draft: ['ready', 'aborted'], ready: ['running', 'aborted'], running: ['completed', 'aborted', 'interrupted'], completed: [], aborted: [], interrupted: [] };
      if (!allowed[run.lifecycle].includes(lifecycle)) invalid('Invalid run lifecycle transition; interrupted runs are never silently resumed.');
      this.bytes(projectId, run.procedureArtifact);
      if (lifecycle === 'running') { run.startedAt = run.changedAt; run.frozenConfigurationSha256 = sha(encode({ procedureSha256: run.procedureArtifact.sha256, parameters: run.parameters, setup: run.setup, associations: run.associations, projectRevision: run.projectRevision })); }
      if (['completed', 'aborted', 'interrupted'].includes(lifecycle)) run.finishedAt = run.changedAt;
      run.lifecycle = lifecycle;
    });
  }
  attachSelection(projectId: string, experimentId: string, expectedRevisionId: string, selection: RecordingSelection): ExperimentRun {
    const metrics = this.metrics(projectId, selection);
    return this.append(projectId, experimentId, expectedRevisionId, 'Exact recording interval retained.', run => {
      if (!['ready', 'running'].includes(run.lifecycle) || selection.projectRevision !== run.projectRevision) invalid('Only applicable ready/running runs can attach acquisition evidence.');
      run.selections.push(clone(selection)); run.metricArtifacts.push(this.storage.storeArtifact(projectId, encode(metrics), 'application/json'));
    });
  }
  private retainedMetrics(projectId: string, run: ExperimentRun): ExperimentMetric[] {
    if (run.metricArtifacts.length !== run.selections.length) mismatch('Run metric evidence is incomplete.');
    return run.selections.flatMap((selection, index) => {
      const retained = parseEvidence<ExperimentMetric[]>(this.bytes(projectId, run.metricArtifacts[index]));
      if (!isDeepStrictEqual(retained, this.metrics(projectId, selection))) mismatch('Metric formula identity produced different results. Retain the historical result and use a new formula version.');
      return retained;
    });
  }
  note(projectId: string, experimentId: string, expectedRevisionId: string, input: { author: string; reason: string; text: string }): ExperimentRun {
    if (!input || ![input.author, input.reason, input.text].every(text => typeof text === 'string' && text.length > 0 && text.length <= 4096)) invalid('An appended note or correction needs author, reason and text.');
    return this.append(projectId, experimentId, expectedRevisionId, input.reason, run => { run.notes.push({ ...input, at: run.changedAt }); });
  }
  changeSegment(projectId: string, experimentId: string, expectedRevisionId: string, reason: string, configuration: string): ExperimentRun {
    if (typeof reason !== 'string' || !reason || reason.length > 4096 || typeof configuration !== 'string' || !configuration || configuration.length > 8192) invalid('A changed setup needs an explicit bounded reason and configuration.');
    return this.append(projectId, experimentId, expectedRevisionId, reason, run => { if (run.lifecycle !== 'running') invalid('Segments can only be declared during a running acquisition.'); run.changes.push({ at: run.changedAt, reason, configuration }); run.comparable = false; });
  }
  judge(projectId: string, experimentId: string, expectedRevisionId: string, input: { outcome: 'pass' | 'fail' | 'inconclusive'; evaluator: string; criterion: string; evidenceRevisionIds: string[] }): ExperimentRun {
    if (this.actor !== 'local-host') throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Agent assertions cannot create a procedure judgment. Use the trusted local host evidence flow.');
    if (!input || !['pass', 'fail', 'inconclusive'].includes(input.outcome) || ![input.evaluator, input.criterion].every(value => typeof value === 'string' && !!value && value.length <= 4096) || !Array.isArray(input.evidenceRevisionIds) || !input.evidenceRevisionIds.length || input.evidenceRevisionIds.length > 100 || !input.evidenceRevisionIds.every(isRequestId)) invalid('Judgment requires a local evaluator, criterion and exact run evidence revisions.');
    return this.append(projectId, experimentId, expectedRevisionId, 'Local procedure judgment recorded.', run => {
      if (!['completed', 'aborted', 'interrupted'].includes(run.lifecycle) || input.outcome === 'pass' && run.lifecycle !== 'completed') invalid('Only completed acquisition can pass; terminal partial acquisition can be inconclusive or failed.');
      if (input.outcome === 'pass' && !run.comparable) invalid('A run with configuration changes cannot pass whole-run criteria. Segmented procedure judgments are not supported; retain inconclusive evidence or create a new run.');
      const history = this.history(projectId, experimentId);
      if (input.evidenceRevisionIds.some(id => !history.some(item => item.revisionId === id && item.selections.length > 0))) invalid('Judgment evidence must reference retained applicable run revisions with acquisition evidence.');
      const metrics = this.retainedMetrics(projectId, run); this.bytes(projectId, run.procedureArtifact);
      if (input.outcome === 'pass' && (!metrics.length || metrics.some(metric => !metric.count || metric.unit === null || metric.gaps > 0 || metric.issues > 0))) invalid('A passing numeric procedure requires nonempty evidence with known units and no unreviewed acquisition gaps or parse issues. Record inconclusive or a new procedure/run.');
      run.judgment = { ...clone(input), at: run.changedAt };
    });
  }
  recover(projectId: string): ExperimentRun[] { return this.list(projectId).filter(run => run.lifecycle === 'running').map(run => this.transition(projectId, run.experimentId, run.revisionId, 'interrupted')); }
  compare(projectId: string, leftId: string, rightId: string): ExperimentComparison {
    const left = this.get(projectId, leftId), right = this.get(projectId, rightId), reasons: string[] = [];
    if (left.lifecycle !== 'completed' || right.lifecycle !== 'completed') reasons.push('Both acquisitions must be completed.');
    if (!left.comparable || !right.comparable) reasons.push('A mid-run configuration segment prevents whole-run comparison.');
    if (left.procedureArtifact.sha256 !== right.procedureArtifact.sha256) reasons.push('Procedure versions or exact procedure bytes differ.');
    if (left.projectRevision !== right.projectRevision) reasons.push('Applicable project revisions differ.');
    if (left.setup !== right.setup) reasons.push('Declared physical setup differs.');
    if (JSON.stringify(left.parameters) !== JSON.stringify(right.parameters)) reasons.push('Declared parameter values or units differ; a controlled comparison procedure is required.');
    for (const key of ['deviceId', 'deviceObservationId', 'firmwareSha256'] as const) if (!left.associations[key].id || !right.associations[key].id || left.associations[key].id !== right.associations[key].id) reasons.push(`${key} is unknown or differs; hardware/firmware differences require an explicit comparison procedure.`);
    const a = this.retainedMetrics(projectId, left), b = this.retainedMetrics(projectId, right);
    if (!a.length || !b.length || a.length !== b.length) reasons.push('Both runs need corresponding exact selected channels.');
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i].channelId !== b[i].channelId || a[i].unit === null || a[i].unit !== b[i].unit) reasons.push('Channel meanings or known units differ.');
      if (a[i].selection.timeBasis !== b[i].selection.timeBasis || a[i].selection.timeBasis === 'device') reasons.push('Clock bases differ or independent device clocks have no declared alignment.');
      if (a[i].selection.end - a[i].selection.start !== b[i].selection.end - b[i].selection.start) reasons.push('Selected interval durations differ.');
      if (a[i].selection.configurationSha256 !== b[i].selection.configurationSha256 || a[i].selection.parserVersion !== b[i].selection.parserVersion) reasons.push('Parser versions/configuration differ.');
      if (a[i].gaps || b[i].gaps || a[i].issues || b[i].issues || !a[i].count || !b[i].count) reasons.push('Missing samples, parse issues or acquisition gaps prevent a formal conclusion.');
    }
    return { exploratoryOverlay: !!a.length && !!b.length, formalImprovementAllowed: reasons.length === 0, incompatibilities: [...new Set(reasons)], conclusion: 'not-evaluated' };
  }
  export(projectId: string, experimentId: string): ExperimentExport {
    const runs = this.history(projectId, experimentId); if (!runs.length) throw new WorkbenchError('NOT_FOUND', 'Experiment is unavailable.');
    const ids = new Set(runs.flatMap(run => run.selections.map(selection => selection.derivationId)));
    const derivations = this.storage.listRecords<RetainedTelemetryDerivation>('experiments', projectId).filter(item => item.kind === 'telemetry-derivation' && ids.has(item.derivationId));
    if (derivations.length !== ids.size) mismatch('Export cannot omit missing derivations.');
    ids.forEach(id => this.derivation(projectId, id));
    const references = new Map<string, EvidenceArtifact>();
    for (const reference of [...runs.flatMap(run => [run.procedureArtifact, ...run.metricArtifacts]), ...derivations.flatMap(item => [item.parsedArtifact, ...item.rawArtifacts])]) references.set(reference.artifactId, reference);
    // shortcut: a run archive fits in 128 MiB; stream a container when larger retained runs need portable export.
    if ([...references.values()].reduce((total, reference) => total + Math.ceil(reference.sizeBytes / 3) * 4, 0) > 120 * 1024 * 1024) invalid('Run evidence exceeds the bounded JSON archive size; originals remain retained.');
    let serialTail = '';
    const artifacts = [...references.values()].map(reference => { const bytes = this.bytes(projectId, reference); serialTail = assertSafeExportBytes(bytes, serialTail); return { ...reference, bytesBase64: Buffer.from(bytes).toString('base64') }; });
    const metrics = this.retainedMetrics(projectId, runs.at(-1)!);
    const body = { schemaVersion: 1 as const, kind: 'experiment-evidence-export' as const, projectId, runs, derivations, metrics, artifacts, limitations: ['Source/build/upload identities are references; external source and firmware artifacts are not included by this run-only export.', 'No device, account or physical replay is required to inspect the retained evidence.'] };
    bounded({ runs, derivations }); const result = { ...body, manifestSha256: sha(encode(body)) };
    if (encode(result).length > 128 * 1024 * 1024) invalid('Run evidence exceeds the bounded JSON archive size; originals remain retained.');
    return result;
  }
}

function assertSafeExportBytes(bytes: Uint8Array, serialTail = ''): string {
  const text = Buffer.from(bytes).toString('utf8'); assertSafeAgentText(text);
  for (const line of text.split('\n')) {
    let record: unknown; try { record = JSON.parse(line); } catch { continue; }
    if (record && typeof record === 'object' && 'bytesBase64' in record && typeof record.bytesBase64 === 'string') {
      const serial = serialTail + Buffer.from(record.bytesBase64, 'base64').toString('utf8'); assertSafeAgentText(serial); serialTail = serial.slice(-4096);
    }
  }
  return serialTail;
}

/** Offline inspection validates every checksum before exposing any evidence. */
export function reopenExperimentExport(bytes: Uint8Array): ExperimentExport {
  if (!(bytes instanceof Uint8Array) || bytes.length > 128 * 1024 * 1024) invalid('Evidence export exceeds 128 MiB.');
  let value: ExperimentExport; try { value = JSON.parse(Buffer.from(bytes).toString('utf8')) as ExperimentExport; } catch { return invalid('Evidence export must be valid JSON.'); }
  if (!value || value.schemaVersion !== 1 || value.kind !== 'experiment-evidence-export' || !isRequestId(value.projectId) || !Array.isArray(value.runs) || !value.runs.length || !Array.isArray(value.derivations) || !Array.isArray(value.artifacts) || !digest(value.manifestSha256)) invalid('Invalid versioned evidence export.');
  const { manifestSha256, ...body } = value;
  if (sha(encode(body)) !== manifestSha256) mismatch('Export manifest checksum differs.');
  const artifacts = new Map<string, Uint8Array>();
  let serialTail = '';
  for (const item of value.artifacts) {
    if (!artifact(item) || typeof item.bytesBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.bytesBase64) || artifacts.has(item.artifactId)) invalid('Invalid or duplicate exported artifact.');
    const original = Buffer.from(item.bytesBase64, 'base64');
    if (sha(original) !== item.sha256 || original.length !== item.sizeBytes) mismatch('Exported artifact checksum differs.');
    serialTail = assertSafeExportBytes(original, serialTail); artifacts.set(item.artifactId, original);
  }
  bounded({ runs: value.runs, derivations: value.derivations });
  for (let runIndex = 0; runIndex < value.runs.length; runIndex++) {
    const run = value.runs[runIndex];
    if (run.projectId !== value.projectId || !isRequestId(run.experimentId) || !isRequestId(run.revisionId) || !isExperimentProcedure(run.procedure) || !Array.isArray(run.selections) || !run.selections.every(isRecordingSelection) || !Array.isArray(run.metricArtifacts) || run.metricArtifacts.length !== run.selections.length) invalid('Exported run identity or procedure is invalid.');
    const procedure = artifacts.get(run.procedureArtifact.artifactId); if (!procedure || sha(procedure) !== run.procedureArtifact.sha256 || !isDeepStrictEqual(parseEvidence(procedure), run.procedure)) mismatch('Exported run procedure is missing or differs.');
    validateDraft({ projectId: run.projectId, projectRevision: run.projectRevision, procedureBytes: procedure, parameters: run.parameters, setup: run.setup, associations: run.associations });
    const timestamp = (time: unknown) => typeof time === 'string' && time.endsWith('Z') && Number.isFinite(Date.parse(time));
    const previous = value.runs[runIndex - 1];
    if (run.kind !== 'experiment-run' || run.schemaVersion !== 1 || !['draft', 'ready', 'running', 'completed', 'aborted', 'interrupted'].includes(run.lifecycle)
      || run.experimentId !== value.runs[0].experimentId || run.revision !== runIndex + 1 || run.previousRevisionId !== (previous?.revisionId ?? null)
      || !timestamp(run.createdAt) || !timestamp(run.changedAt) || run.startedAt !== null && !timestamp(run.startedAt) || run.finishedAt !== null && !timestamp(run.finishedAt)
      || run.frozenConfigurationSha256 !== null && !digest(run.frozenConfigurationSha256) || typeof run.comparable !== 'boolean' || !Array.isArray(run.changes) || !Array.isArray(run.notes)
      || !run.judgment || !['pass', 'fail', 'inconclusive', 'not-evaluated'].includes(run.judgment.outcome) || !Array.isArray(run.judgment.evidenceRevisionIds)
      || run.judgment.evidenceRevisionIds.some(id => !value.runs.some(item => item.revisionId === id && item.selections.length > 0))
      || run.judgment.outcome === 'pass' && run.lifecycle !== 'completed') invalid('Exported run lifecycle, judgment or immutable revision chain is invalid.');
    for (const selection of run.selections) if (!value.derivations.some(item => item.derivationId === selection.derivationId && item.recordingId === selection.recordingId)) mismatch('Exported selection has missing derivation evidence.');
    for (let index = 0; index < run.metricArtifacts.length; index++) {
      const reference = run.metricArtifacts[index], metrics = artifacts.get(reference.artifactId);
      if (!metrics || sha(metrics) !== reference.sha256 || metrics.length !== reference.sizeBytes) mismatch('Exported run metric evidence is missing or corrupt.');
      const parsed = parseEvidence<ExperimentMetric[]>(metrics);
      if (!Array.isArray(parsed) || !parsed.length || !parsed.every(metric => isDeepStrictEqual(metric.selection, run.selections[index]) && metric.formulaVersion === 'sample-statistics-v1')) mismatch('Exported metrics differ from their frozen interval/formula.');
    }
  }
  for (const derivation of value.derivations) {
    if (derivation.projectId !== value.projectId || !Array.isArray(derivation.rawArtifacts)) invalid('Exported derivation identity is invalid.');
    for (const reference of [derivation.parsedArtifact, ...derivation.rawArtifacts]) { const original = artifacts.get(reference.artifactId); if (!original || sha(original) !== reference.sha256 || original.length !== reference.sizeBytes) mismatch('Export omits or corrupts referenced evidence.'); }
    const parsed = parseEvidence<TelemetryDerivation>(artifacts.get(derivation.parsedArtifact.artifactId)!);
    if (!isTelemetryDerivation(parsed) || parsed.derivationId !== derivation.derivationId || parsed.derivationSha256 !== derivation.derivationSha256 || parsed.recordingId !== derivation.recordingId || JSON.stringify(parsed.segmentSha256s) !== JSON.stringify(derivation.rawArtifacts.map(item => item.sha256))) mismatch('Exported derivation provenance differs.');
  }
  const retainedMetrics = value.runs.at(-1)!.metricArtifacts.flatMap(reference => parseEvidence<ExperimentMetric[]>(artifacts.get(reference.artifactId)!));
  if (!isDeepStrictEqual(value.metrics, retainedMetrics)) mismatch('Export summary differs from the retained metric artifacts.');
  return clone(value);
}
