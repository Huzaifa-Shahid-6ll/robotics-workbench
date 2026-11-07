import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DomainTools, reopenExperimentExport } from '@robotics-workbench/application';
import { RawRecorder, type RecordingResult } from '@robotics-workbench/serial';
import { isProjectRequest, type ExperimentRun, type HashedParserProfile, type OperationReceipt, type ParserProfile, type ProjectRequest, type ProjectResponse, type RecordingSelection, type TelemetryWindow } from '@robotics-workbench/contracts';
import { freezeTelemetrySelection, isTelemetryViewState, type TelemetryViewState } from '@robotics-workbench/webviews';
import { ProjectService } from '../src/project-service';
import { TelemetryService } from '../src/telemetry-service';
import type { CaptureEvent, HardwareService, StoredRecording } from '../src/hardware-service';
import { seedTelemetry } from './seed-telemetry';

function result<T>(response: ProjectResponse): T { assert.equal(response.error, undefined, JSON.stringify(response.error)); return response.result as T; }
function fixture(t: TestContext) {
  const parent = join(process.cwd(), 'artifacts', 'task09', 'service-tests'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'fixture-')), root = join(directory, 'project'), data = join(directory, 'data');
  const ids = seedTelemetry(root, data), project = new ProjectService(root, data);
  let observer: ((event: CaptureEvent) => void) | undefined;
  const active: { recording: RecordingResult; operationId: string; preview: ReturnType<RawRecorder['preview']> }[] = [];
  // The service reads this observer/list port only; no physical transport exists in the fixture.
  const hardware: Pick<HardwareService, 'setCaptureObserver' | 'liveRecordings'> = { setCaptureObserver: value => { observer = value; }, liveRecordings: () => active };
  const telemetry = new TelemetryService(project, hardware as HardwareService);
  t.after(async () => { await project.shutdown(); });
  const request = (method: ProjectRequest['method'], params: Record<string, unknown> = {}, revision?: number): ProjectRequest => ({ schemaVersion: 1, requestId: randomUUID(), projectId: ids.projectId, method, params, ...((method === 'telemetry.derive' || method.startsWith('experiment.') && !['experiment.compare', 'experiment.export'].includes(method)) ? { expectedProjectRevision: revision ?? 1 } : revision === undefined ? {} : { expectedProjectRevision: revision }) });
  const call = async <T>(method: ProjectRequest['method'], params: Record<string, unknown> = {}, revision?: number): Promise<T> => result<T>(await telemetry.handle(request(method, params, revision)));
  const snapshot = () => call<Pick<TelemetryViewState, 'project' | 'recordings' | 'profiles' | 'procedures' | 'runs'>>('telemetry.snapshot');
  const derive = async (profileId = ids.profileId, recordingId = ids.recordingId) => {
    const value = request('telemetry.derive', { recordingId, profileId }), admitted = result<OperationReceipt>(await telemetry.handle(value));
    const receipt = await project.jobs.wait(admitted.operationId); assert.equal(receipt.status, 'succeeded', JSON.stringify(receipt.error));
    return { request: value, receipt, derivationId: String(receipt.result!.derivationId) };
  };
  const query = (derivationId: string) => call<TelemetryWindow>('telemetry.query', { derivationId, channelIds: ['range', 'power'], timeBasis: 'host-receive', start: 0, end: 10000 });
  const select = (window: TelemetryWindow): RecordingSelection => ({ schemaVersion: 1, projectRevision: 1, recordingId: window.recordingId, derivationId: window.derivationId, configurationSha256: window.configurationSha256, parserVersion: window.parserVersion, channelIds: window.channelIds, timeBasis: 'host-receive', start: window.start, end: window.end });
  const create = (recordingId = ids.recordingId) => call<ExperimentRun>('experiment.create', { procedureId: ids.procedureId, recordingId, setup: 'Generated fixture bytes; no physical sensor or instrument.', parameters: { target: { value: 18, unit: 'mm' } } });
  const transition = (run: ExperimentRun, lifecycle: 'ready' | 'running' | 'completed') => call<ExperimentRun>('experiment.transition', { experimentId: run.experimentId, expectedRevisionId: run.revisionId, lifecycle });
  return { ids, directory, root, data, project, telemetry, request, call, snapshot, derive, query, select, create, transition, active, emit: (event: CaptureEvent) => observer?.(event) };
}
function retainRecording(f: ReturnType<typeof fixture>, input: { deviceId: string; uploadReceiptId: string | null; firmwareSha256: string | null; uploadGap?: boolean }): StoredRecording {
  const recorder = new RawRecorder(join(f.data, 'work', 'synthetic-association'), { projectId: f.ids.projectId, projectRevision: 1, deviceId: input.deviceId, uploadReceiptId: input.uploadReceiptId, firmwareSha256: input.firmwareSha256 });
  recorder.receive(Buffer.from('range:10 power:1\n')); if (input.uploadGap) recorder.boundary('upload'); recorder.receive(Buffer.from('range:20 power:2\n'));
  const recorded = recorder.finish(), stored: StoredRecording = { ...recorded, segments: recorded.segments.map(segment => ({ ...segment, artifactId: f.project.store.storeArtifact(f.ids.projectId, readFileSync(segment.path), 'application/x-ndjson').artifactId })) };
  f.project.store.putRecord('recordings', stored.recordingId, f.ids.projectId, stored); return stored;
}
function viewState(snapshot: Awaited<ReturnType<ReturnType<typeof fixture>['snapshot']>>, profile?: HashedParserProfile, window: TelemetryWindow | null = null): TelemetryViewState {
  return { schemaVersion: 1, trusted: true, loading: false, error: null, stale: false, ...snapshot, selectedRecordingId: window?.recordingId ?? null, selectedProfileId: profile?.id ?? null, revealedSelection: null, window, live: null, comparison: null };
}

test('ordinary fixture source and retained recording reopen under one database owner; snapshot fits the strict view state', async t => {
  const f = fixture(t), snapshot = await f.snapshot();
  assert.equal(isTelemetryViewState(viewState(snapshot)), true); assert.equal(snapshot.recordings.length, 1); assert.equal(snapshot.recordings[0].completion, 'complete');
  assert.equal(snapshot.recordings[0].artifactSha256, null);
  const recording = f.project.store.getRecord<StoredRecording>('recordings', f.ids.recordingId, f.ids.projectId);
  assert.equal(recording.firmwareSha256, null); assert.equal(recording.gaps[0].lostBytes, null);
  assert.equal(recording.segments.length, 2); recording.segments.forEach(segment => assert.equal(f.project.store.getArtifact(f.ids.projectId, segment.artifactId).sha256, segment.sha256));
  assert.equal(snapshot.profiles[0].mode, 'labeled-numeric'); assert.ok(snapshot.profiles[0].channels.every(channel => channel.unit !== null));
  assert.ok(snapshot.recordings[0].limitations.some(message => /unknown/i.test(message))); assert.match(snapshot.project!.name, /Synthetic/);
  assert.match(readFileSync(join(f.root, 'TelemetryProbe', 'TelemetryProbe.ino'), 'utf8'), /not been compiled or uploaded/);
  assert.equal(f.project.store.listOperations(f.ids.projectId).length, 0); assert.deepEqual(f.project.devices.status(), []);
  const source = readFileSync(join(f.root, 'workbench.json')); assert.throws(() => seedTelemetry(f.root, f.data), { code: 'REVISION_CONFLICT' }); assert.deepEqual(readFileSync(join(f.root, 'workbench.json')), source);
});

test('worker derivation is durable and deduplicated; historical parser and exact frozen intervals survive later source/config edits', async t => {
  const f = fixture(t), derived = await f.derive(), window = await f.query(derived.derivationId), snapshot = await f.snapshot(), selected = f.select(window);
  assert.equal(window.totalSamples, 10); assert.equal(window.statistics.find(stat => stat.channelId === 'range')!.mean, 18); assert.equal(window.statistics.find(stat => stat.channelId === 'power')!.mean, 3);
  assert.equal(isTelemetryViewState(viewState(snapshot, snapshot.profiles[0], window)), true);
  const duplicate = result<OperationReceipt>(await f.telemetry.handle(derived.request)); assert.equal(duplicate.operationId, derived.receipt.operationId); assert.equal(duplicate.status, 'succeeded');
  const conflict = await f.telemetry.handle({ ...derived.request, params: { ...derived.request.params, profileId: randomUUID() } }); assert.equal(conflict.error?.code, 'REQUEST_ID_CONFLICT');
  const context = f.telemetry.context(selected), before = JSON.parse(context.evidence.summary);
  assert.equal(context.evidence.sha256, createHash('sha256').update(f.project.store.readArtifact(f.ids.projectId, context.evidence.artifactId!)).digest('hex'));
  const profilesPath = join(f.root, 'telemetry', 'parsers.json'), profileSource = JSON.parse(readFileSync(profilesPath, 'utf8')) as { schemaVersion: 1; profiles: ParserProfile[] };
  profileSource.profiles[0].channels[0].unit = 'cm'; writeFileSync(profilesPath, JSON.stringify(profileSource)); writeFileSync(join(f.root, 'TelemetryProbe', 'TelemetryProbe.ino'), '// Later independent source edit remains saved.');
  const latest = await f.derive(), changed = await f.query(latest.derivationId); assert.notEqual(latest.derivationId, derived.derivationId); assert.notEqual(changed.configurationSha256, window.configurationSha256); assert.equal(changed.statistics[0].unit, 'cm');
  assert.deepEqual(await f.query(derived.derivationId), window);
  const frozen = await f.call<{ selection: RecordingSelection; metrics: unknown[] }>('telemetry.selection', { selection: selected }); assert.deepEqual(frozen.selection, selected);
  assert.deepEqual(JSON.parse(f.telemetry.context(selected).evidence.summary), before); assert.equal(context.evidence.applicability, 'historical');
  assert.equal(readFileSync(join(f.root, 'TelemetryProbe', 'TelemetryProbe.ino'), 'utf8'), '// Later independent source edit remains saved.');
});

test('raw corruption blocks historical query and a new worker derivation; wrong-project requests cannot reach evidence', async t => {
  const f = fixture(t), derived = await f.derive(), selected = f.select(await f.query(derived.derivationId));
  await assert.rejects(() => f.telemetry.handle({ ...f.request('telemetry.snapshot'), projectId: randomUUID() }), { code: 'UNAUTHORIZED_SCOPE' });
  const recording = f.project.store.getRecord<StoredRecording>('recordings', f.ids.recordingId, f.ids.projectId), artifact = f.project.store.getArtifact(f.ids.projectId, recording.segments[0].artifactId), path = join(f.data, artifact.relativePath), original = readFileSync(path), corrupt = Buffer.from(original); corrupt[0] ^= 1; writeFileSync(path, corrupt);
  assert.equal((await f.telemetry.handle(f.request('telemetry.selection', { selection: selected }))).error?.code, 'ARTIFACT_MISMATCH');
  const pending = result<OperationReceipt>(await f.telemetry.handle(f.request('telemetry.derive', { recordingId: f.ids.recordingId, profileId: f.ids.profileId }))), failed = await f.project.jobs.wait(pending.operationId);
  assert.equal(failed.status, 'failed'); assert.equal(failed.error?.code, 'ARTIFACT_MISMATCH'); assert.deepEqual(readFileSync(path), corrupt);
  assert.equal(f.project.store.getRecord<StoredRecording>('recordings', f.ids.recordingId, f.ids.projectId).rawSha256, recording.rawSha256);
});

test('interval export includes only exact selected channel/time samples and preserves full original derivation provenance', async t => {
  const f = fixture(t), derived = await f.derive(), window = await f.query(derived.derivationId), original = f.telemetry.repository.derivation(f.ids.projectId, derived.derivationId), first = original.samples.find(sample => sample.channelId === 'range')!;
  const selection: RecordingSelection = { ...f.select(window), channelIds: ['range'], start: first.hostReceiveMs, end: first.hostReceiveMs };
  const exported = await f.call<{ path: string; sha256: string }>('telemetry.exportSelection', { selection });
  const bytes = readFileSync(exported.path), payload = JSON.parse(bytes.toString('utf8')) as { schemaVersion: number; selection: RecordingSelection; metrics: { channelId: string; count: number }[]; provenance: { originalDerivationId: string; originalDerivationSha256: string; rawSha256: string; segmentSha256s: string[]; profile: HashedParserProfile }; samples: TelemetryWindow['samples']; gaps: TelemetryWindow['gaps']; issues: TelemetryWindow['issues']; limitations: string[]; derivation?: unknown };
  assert.equal(createHash('sha256').update(bytes).digest('hex'), exported.sha256); assert.equal(payload.schemaVersion, 1); assert.deepEqual(payload.selection, selection);
  assert.deepEqual(payload.samples, [first]); assert.ok(payload.samples.every(sample => sample.channelId === 'range' && sample.hostReceiveMs === first.hostReceiveMs));
  assert.deepEqual(payload.metrics.map(metric => ({ channelId: metric.channelId, count: metric.count })), [{ channelId: 'range', count: 1 }]); assert.equal(payload.derivation, undefined);
  assert.equal(payload.provenance.originalDerivationId, original.derivationId); assert.equal(payload.provenance.originalDerivationSha256, original.derivationSha256); assert.equal(payload.provenance.rawSha256, original.rawSha256); assert.deepEqual(payload.provenance.segmentSha256s, original.segmentSha256s); assert.deepEqual(payload.provenance.profile, original.profile);
  assert.ok(!bytes.toString('utf8').includes('bytesBase64')); assert.deepEqual(f.telemetry.repository.derivation(f.ids.projectId, derived.derivationId), original);
  assert.ok(original.samples.some(sample => sample.channelId === 'power')); assert.ok(original.samples.some(sample => sample.channelId === 'range' && sample.hostReceiveMs > first.hostReceiveMs));
});

test('live callbacks produce a valid transient plot but cannot freeze provisional evidence or reopen a physical port', async t => {
  const f = fixture(t), operationId = randomUUID();
  let recorder!: RawRecorder;
  recorder = new RawRecorder(join(f.data, 'work', 'synthetic-live'), { projectId: f.ids.projectId, projectRevision: 1, deviceId: randomUUID(), onRecord: record => f.emit({ type: 'record', recording: recorder.snapshot(), operationId, record }), onGap: gap => f.emit({ type: 'gap', recording: recorder.snapshot(), operationId, gap }) });
  const entry = { recording: recorder.snapshot(), operationId, preview: recorder.preview() }; f.active.push(entry); f.emit({ type: 'start', recording: entry.recording, operationId });
  recorder.receive(Buffer.from('range:12 power:1\n')); recorder.boundary('upload'); recorder.receive(Buffer.from('invalid numeric frame\nrange:24 power:2\n')); entry.recording = recorder.snapshot(); entry.preview = recorder.preview();
  const live = await f.call<{ live: NonNullable<TelemetryViewState['live']>; window: TelemetryWindow }>('telemetry.live', { recordingId: recorder.recordingId, profileId: f.ids.profileId }), snapshot = await f.snapshot(), state = viewState(snapshot, snapshot.profiles[0], live.window); state.live = live.live;
  assert.equal(live.window.totalSamples, 4); assert.match(live.window.displayResolution, /Transient live/); assert.equal(isTelemetryViewState(state), true);
  assert.ok(live.window.gaps.some(gap => gap.cause === 'upload' && gap.lostBytes === null));
  assert.ok(live.window.issues.some(issue => issue.code === 'invalid-frame')); assert.ok(live.window.gaps.some(gap => gap.cause === 'invalid-frame'));
  assert.equal(freezeTelemetrySelection(state, live.window.start, live.window.end, ['range']), null);
  const forged: RecordingSelection = { schemaVersion: 1, projectRevision: 1, recordingId: recorder.recordingId, derivationId: live.window.derivationId, parserVersion: live.window.parserVersion, configurationSha256: live.window.configurationSha256, channelIds: ['range'], timeBasis: 'host-receive', start: live.window.start, end: live.window.end };
  assert.equal((await f.telemetry.handle(f.request('telemetry.selection', { selection: forged }))).error?.code, 'NOT_FOUND');
  recorder.finish(); f.emit({ type: 'finish', recording: recorder.snapshot(), operationId }); f.active.length = 0;
  assert.equal(f.project.store.listOperations(f.ids.projectId).length, 0); assert.deepEqual(f.project.devices.status(), []);
});

test('runs attach exact evidence, keep agent observations separate from host judgments, and export/reopen offline', async t => {
  const f = fixture(t), derived = await f.derive(), selected = f.select(await f.query(derived.derivationId));
  let run = await f.create(); assert.equal(run.lifecycle, 'draft'); assert.equal(run.judgment.outcome, 'not-evaluated'); assert.equal(run.associations.firmwareSha256.id, null);
  run = await f.transition(run, 'ready'); run = await f.call<ExperimentRun>('experiment.attach', { experimentId: run.experimentId, expectedRevisionId: run.revisionId, selection: selected }); run = await f.transition(run, 'running'); run = await f.transition(run, 'completed');
  const tools = new DomainTools(f.ids.projectId, request => f.telemetry.handle(request), async () => {}, () => { throw new Error('Small fixture result should not need retention.'); });
  await assert.rejects(() => tools.call('experiment_judge', { requestId: randomUUID(), expectedProjectRevision: 1, params: { experimentId: run.experimentId, expectedRevisionId: run.revisionId, outcome: 'pass', criterion: 'Agent says pass.' } }), { code: 'INVALID_REQUEST' });
  const agentArgs = { requestId: randomUUID(), expectedProjectRevision: 1, params: { experimentId: run.experimentId, expectedRevisionId: run.revisionId, text: 'Agent suggests the fixture passed; this remains interpretation.', reason: 'Synthetic provider observation.' } };
  const observation = await tools.call('experiment_record', agentArgs); assert.equal(observation.isError, undefined); run = f.telemetry.repository.get(f.ids.projectId, run.experimentId); assert.equal(run.judgment.outcome, 'not-evaluated'); assert.equal(run.notes.at(-1)!.author, 'agent-observation');
  await assert.rejects(() => tools.call('experiment_record', { ...agentArgs, requestId: randomUUID(), params: { ...agentArgs.params, outcome: 'pass' } }), { code: 'INVALID_REQUEST' });
  const judge = { experimentId: run.experimentId, expectedRevisionId: run.revisionId, outcome: 'pass', criterion: 'Generated fixture mean18 mm; software-only result.' };
  assert.equal((await f.telemetry.handle(f.request('experiment.judge', judge))).error?.code, 'INVALID_REQUEST');
  run = await f.call<ExperimentRun>('experiment.judge', { ...judge, outcome: 'inconclusive' }); assert.equal(run.judgment.outcome, 'inconclusive');
  const exported = await f.call<{ path: string; sha256: string }>('experiment.export', { experimentId: run.experimentId }); const reopened = reopenExperimentExport(readFileSync(exported.path));
  assert.equal(reopened.runs.at(-1)!.experimentId, run.experimentId); assert.equal(reopened.metrics.find(metric => metric.channelId === 'range')!.mean, 18); assert.equal(reopened.runs.at(-1)!.judgment.outcome, 'inconclusive');
  let second = await f.create(); second = await f.transition(second, 'ready'); second = await f.call<ExperimentRun>('experiment.attach', { experimentId: second.experimentId, expectedRevisionId: second.revisionId, selection: selected }); second = await f.transition(second, 'running'); second = await f.transition(second, 'completed');
  const comparison = await f.call<NonNullable<TelemetryViewState['comparison']>>('experiment.compare', { experimentIds: [run.experimentId, second.experimentId] });
  assert.equal(comparison.compatible, false); assert.ok(comparison.warnings.some(warning => /gap|unknown/i.test(warning))); assert.equal(comparison.series.length, 2);
  const compared = viewState(await f.snapshot()); compared.comparison = comparison; assert.equal(isTelemetryViewState(compared), true);
  assert.equal(isTelemetryViewState(viewState(await f.snapshot())), true); assert.deepEqual(f.project.devices.status(), []);
});

test('metadata mutation request reuse cannot append twice; stale revisions and changed intent preserve earlier records', async t => {
  const f = fixture(t), request = f.request('experiment.create', { procedureId: f.ids.procedureId, setup: 'Dedicated synthetic fixture.', parameters: {} });
  const run = result<ExperimentRun>(await f.telemetry.handle(request)), before = f.telemetry.repository.history(f.ids.projectId, run.experimentId);
  assert.deepEqual(result<ExperimentRun>(await f.telemetry.handle(request)), run); assert.equal(f.telemetry.repository.list(f.ids.projectId).length, 1);
  assert.equal((await f.telemetry.handle({ ...request, params: { ...request.params, setup: 'Changed request payload.' } })).error?.code, 'REQUEST_ID_CONFLICT');
  assert.equal((await f.telemetry.handle(f.request('experiment.transition', { experimentId: run.experimentId, expectedRevisionId: randomUUID(), lifecycle: 'ready' }))).error?.code, 'REVISION_CONFLICT');
  assert.deepEqual(f.telemetry.repository.history(f.ids.projectId, run.experimentId), before);
  const invalid = f.request('experiment.record', { experimentId: run.experimentId, expectedRevisionId: run.revisionId, text: 'Invalid actor', reason: 'Boundary probe', actor: 'local-host' }); assert.equal(isProjectRequest(invalid), false);
  const manifestPath = join(f.root, 'workbench.json'), manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); manifest.projectRevision = 2; writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.deepEqual(result<ExperimentRun>(await f.telemetry.handle(request)), run);
  assert.equal((await f.telemetry.handle(f.request('experiment.create', request.params))).error?.code, 'REVISION_CONFLICT');
});

test('long valid procedure and parameter metadata retain originals behind bounded strict view previews', async t => {
  const f = fixture(t), path = join(f.root, 'experiments', 'procedures.json'), source = JSON.parse(readFileSync(path, 'utf8'));
  source.procedures[0].purpose = 'Synthetic purpose '.repeat(80); writeFileSync(path, JSON.stringify(source));
  const parameters = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`p${i}`, { value: i === 0 ? 'x'.repeat(4096) : i, unit: null }]));
  const run = await f.call<ExperimentRun>('experiment.create', { procedureId: f.ids.procedureId, setup: 'Synthetic bounded-metadata fixture.', parameters });
  const snapshot = await f.snapshot(); assert.equal(isTelemetryViewState(viewState(snapshot)), true);
  assert.ok(snapshot.runs[0].parameters.length <= 64); assert.ok(snapshot.runs[0].parameters.every(parameter => parameter.value.length <= 2048)); assert.ok(snapshot.runs[0].limitations.some(message => /parameter|truncat|omitt/i.test(message)));
  assert.deepEqual(f.telemetry.repository.get(f.ids.projectId, run.experimentId).parameters, parameters);
});

test('a real accepted design edit segments a running run, preserves frozen evidence and refuses stale completion or whole-run pass', async t => {
  const f = fixture(t), derived = await f.derive(), selection = f.select(await f.query(derived.derivationId));
  let run = await f.create(); run = await f.transition(run, 'ready');
  run = await f.call<ExperimentRun>('experiment.attach', { experimentId: run.experimentId, expectedRevisionId: run.revisionId, selection });
  run = await f.call<ExperimentRun>('experiment.note', { experimentId: run.experimentId, expectedRevisionId: run.revisionId, reason: 'Initial fixture setup.', text: 'Original source and retained bytes must remain linked.' });
  run = await f.transition(run, 'running'); const original = structuredClone(run), initialManifest = f.project.files.inspectManifest();
  const start = f.project.store.listRecords<{ kind: string; experimentId?: string; manifestSha256?: string; projectRevision?: number }>('sessions', f.ids.projectId).filter(item => item.kind === 'experiment-start-intent' && item.experimentId === run.experimentId).at(-1);
  assert.equal(start?.manifestSha256, initialManifest.sha256); assert.equal(start?.projectRevision, 1);
  const recording = f.project.store.getRecord<StoredRecording>('recordings', f.ids.recordingId, f.ids.projectId), rawBefore = recording.segments.map(segment => f.project.store.readArtifact(f.ids.projectId, segment.artifactId));
  const layout = f.project.files.writeLayout({ expectedSha256: null, positions: {} }); f.project.files.writeLayout({ expectedSha256: layout.sha256, positions: {} });
  await f.snapshot(); assert.equal(f.telemetry.repository.get(f.ids.projectId, run.experimentId).revisionId, run.revisionId);
  const changedManifest = structuredClone(initialManifest.manifest); changedManifest.projectRevision = 2;
  changedManifest.components.push({ componentId: randomUUID(), label: 'Synthetic intent instance added during the run', definition: null, identityStatus: 'unresolved' });
  writeFileSync(join(f.root, 'workbench.json'), JSON.stringify(changedManifest));
  const stale = await f.telemetry.handle(f.request('experiment.transition', { experimentId: run.experimentId, expectedRevisionId: run.revisionId, lifecycle: 'completed' }, 2));
  assert.equal(stale.error?.code, 'REVISION_CONFLICT'); run = f.telemetry.repository.get(f.ids.projectId, run.experimentId);
  assert.equal(run.lifecycle, 'running'); assert.equal(run.comparable, false); assert.notEqual(run.revisionId, original.revisionId); assert.equal(run.changes.length, 1); assert.match(run.changes[0].reason, /Design intent changed/);
  await f.snapshot(); assert.equal(f.telemetry.repository.get(f.ids.projectId, run.experimentId).revisionId, run.revisionId);
  assert.deepEqual(f.telemetry.repository.history(f.ids.projectId, run.experimentId).find(item => item.revisionId === original.revisionId), original);
  assert.deepEqual(run.notes, original.notes); assert.deepEqual(run.metricArtifacts, original.metricArtifacts); assert.deepEqual(run.selections, original.selections); assert.equal(run.frozenConfigurationSha256, original.frozenConfigurationSha256);
  run = await f.call<ExperimentRun>('experiment.segment', { experimentId: run.experimentId, expectedRevisionId: run.revisionId, reason: 'Explicit local fixture setup change.', configuration: 'Software fixture parameter changed; no hardware action occurred.' }, 2);
  assert.equal(run.changes.length, 2); run = await f.call<ExperimentRun>('experiment.transition', { experimentId: run.experimentId, expectedRevisionId: run.revisionId, lifecycle: 'completed' }, 2);
  const judgment = { experimentId: run.experimentId, expectedRevisionId: run.revisionId, outcome: 'pass', criterion: 'Whole-run fixture judgment.' };
  const refused = await f.telemetry.handle(f.request('experiment.judge', judgment, 2)); assert.equal(refused.error?.code, 'INVALID_REQUEST'); assert.match(refused.error!.message, /configuration changes/i);
  run = await f.call<ExperimentRun>('experiment.judge', { ...judgment, outcome: 'inconclusive' }, 2); assert.equal(run.judgment.outcome, 'inconclusive');
  recording.segments.forEach((segment, index) => assert.deepEqual(f.project.store.readArtifact(f.ids.projectId, segment.artifactId), rawBefore[index]));
  assert.equal(readFileSync(join(f.root, 'workbench.json'), 'utf8'), JSON.stringify(changedManifest)); assert.deepEqual(f.project.devices.status(), []);
});

test('known run associations refuse another device, upload or firmware and refuse unknown replacement provenance', async t => {
  const f = fixture(t), identity = { deviceId: randomUUID(), uploadReceiptId: randomUUID(), firmwareSha256: createHash('sha256').update('synthetic firmware A').digest('hex') }, original = retainRecording(f, identity);
  let run = await f.create(original.recordingId); run = await f.transition(run, 'ready');
  assert.equal(run.associations.deviceId.id, identity.deviceId); assert.equal(run.associations.uploadOperationId.id, identity.uploadReceiptId); assert.equal(run.associations.firmwareSha256.id, identity.firmwareSha256);
  const before = structuredClone(run), variants = [{ ...identity, deviceId: randomUUID() }, { ...identity, uploadReceiptId: randomUUID() }, { ...identity, firmwareSha256: createHash('sha256').update('synthetic firmware B').digest('hex') }, { ...identity, uploadReceiptId: null, firmwareSha256: null }];
  for (const variant of variants) {
    const other = retainRecording(f, variant), derived = await f.derive(f.ids.profileId, other.recordingId), selection = f.select(await f.query(derived.derivationId));
    const refused = await f.telemetry.handle(f.request('experiment.attach', { experimentId: run.experimentId, expectedRevisionId: run.revisionId, selection }));
    assert.ok(refused.error, 'Mismatched/unknown evidence must be refused before a run revision is appended.');
    assert.deepEqual(f.telemetry.repository.get(f.ids.projectId, run.experimentId), before);
  }
  const exact = await f.derive(f.ids.profileId, original.recordingId), selected = f.select(await f.query(exact.derivationId));
  run = await f.call<ExperimentRun>('experiment.attach', { experimentId: run.experimentId, expectedRevisionId: run.revisionId, selection: selected }); assert.equal(run.selections.length, 1); assert.equal(run.selections[0].recordingId, original.recordingId);
  assert.deepEqual(f.project.store.getRecord<StoredRecording>('recordings', original.recordingId, f.ids.projectId), original); assert.deepEqual(f.project.devices.status(), []);
});

test('upload gaps and firmware-transition observations make whole-record firmware/source associations explicitly unknown', async t => {
  const f = fixture(t), deviceId = randomUUID(), uploadReceiptId = randomUUID(), sourceSnapshotId = randomUUID(), buildId = randomUUID(), firmwareSha256 = createHash('sha256').update('software-only firmware identity').digest('hex');
  f.project.store.putRecord('source_snapshots', sourceSnapshotId, f.ids.projectId, { sourceSnapshotId, projectRevision: 1, syntheticFixture: true });
  f.project.store.putRecord('builds', buildId, f.ids.projectId, { buildId, sourceSnapshotId, projectRevision: 1, syntheticFixture: true });
  f.project.store.putRecord('uploads', randomUUID(), f.ids.projectId, { operationId: uploadReceiptId, buildId, deviceId, artifactSha256: firmwareSha256, syntheticFixture: true });
  const identity = { deviceId, uploadReceiptId, firmwareSha256 }, original = retainRecording(f, identity), control = await f.create(original.recordingId);
  assert.equal(control.associations.uploadOperationId.id, uploadReceiptId); assert.equal(control.associations.firmwareSha256.id, firmwareSha256); assert.equal(control.associations.buildId.id, buildId); assert.equal(control.associations.sourceSnapshotId.id, sourceSnapshotId);
  const withGap = retainRecording(f, { ...identity, uploadGap: true }), gapRun = await f.create(withGap.recordingId);
  const withTransition = retainRecording(f, identity);
  f.project.store.putRecord('observations', randomUUID(), f.ids.projectId, { kind: 'capture-firmware-transition', recordingId: withTransition.recordingId, afterGapIndex: 0, uploadReceiptId: randomUUID(), firmwareSha256: createHash('sha256').update('later synthetic firmware').digest('hex'), basis: 'synthetic-software-fixture' });
  const transitionRun = await f.create(withTransition.recordingId);
  for (const run of [gapRun, transitionRun]) for (const key of ['firmwareSha256', 'uploadOperationId', 'buildId', 'sourceSnapshotId'] as const) { assert.equal(run.associations[key].id, null, `${key} must not describe an entire changed capture as its initial firmware.`); assert.ok(run.associations[key].reason); }
  assert.equal(gapRun.associations.deviceId.id, deviceId); assert.equal(transitionRun.associations.deviceId.id, deviceId);
  for (const record of [original, withGap, withTransition]) assert.deepEqual(f.project.store.getRecord<StoredRecording>('recordings', record.recordingId, f.ids.projectId), record);
  assert.deepEqual(f.project.devices.status(), []);
});
