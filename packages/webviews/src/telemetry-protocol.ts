import { isParserProfile, isRecordingSelection, isTelemetryHash, type HashedParserProfile, type RecordingSelection, type TelemetryWindow } from '@robotics-workbench/contracts/telemetry';

export interface TelemetryRecordingItem {
  recordingId: string; projectRevision: number; startedAt: string; completion: 'active' | 'complete' | 'partial' | 'unavailable';
  device: string; artifactSha256: string | null; limitations: string[];
}
export interface TelemetryRunItem {
  experimentId: string; revisionId: string; title: string; procedureId: string; procedureVersion: number; projectRevision: number;
  lifecycle: 'draft' | 'ready' | 'running' | 'completed' | 'aborted' | 'interrupted';
  outcome: 'pass' | 'fail' | 'inconclusive' | 'not-evaluated'; recordingIds: string[];
  parameters: { name: string; value: string; unit: string | null }[]; limitations: string[];
}
export interface TelemetryViewState {
  schemaVersion: 1; trusted: boolean; loading: boolean; error: string | null; stale: boolean;
  project: { projectId: string; projectRevision: number; name: string } | null;
  recordings: TelemetryRecordingItem[]; profiles: HashedParserProfile[]; selectedRecordingId: string | null; selectedProfileId: string | null;
  window: TelemetryWindow | null;
  revealedSelection: RecordingSelection | null;
  live: { recordingId: string; text: string; omittedBytes: number | null; captureActive: boolean } | null;
  procedures: { procedureId: string; version: number; title: string }[]; runs: TelemetryRunItem[];
  comparison: { experimentIds: string[]; compatible: boolean; warnings: string[]; differences: { field: string; values: string[] }[]; series: { seriesKey: string; label: string; unit: string | null; window: TelemetryWindow }[] } | null;
}
export type TelemetryViewAction = 'ready' | 'refresh' | 'selectRecording' | 'selectProfile' | 'editProfiles' | 'query' | 'ask' | 'exportSelection' | 'stopCapture' | 'createProcedure' | 'openProcedure' | 'createRun' | 'startRun' | 'finishRun' | 'appendNote' | 'judgeRun' | 'compare' | 'exportRun';
export interface TelemetryViewRequest { schemaVersion: 1; requestId: string; projectId: string | null; type: TelemetryViewAction; payload: Record<string, unknown> }
export interface TelemetryViewResponse { schemaVersion: 1; type: 'state'; state: TelemetryViewState }

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const keys = (v: Record<string, unknown>, expected: string[], optional: string[] = []) => expected.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => expected.includes(k) || optional.includes(k));
const txt = (v: unknown, max = 2048, min = 0): v is string => typeof v === 'string' && v.length >= min && v.length <= max;
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const integer = (v: unknown): v is number => num(v) && Number.isSafeInteger(v);
const revision = (v: unknown): v is number => integer(v) && v > 0;
const list = (v: unknown, max: number, test: (item: unknown) => boolean): v is unknown[] => Array.isArray(v) && v.length <= max && v.every(test);
const texts = (v: unknown) => list(v, 64, x => txt(x));
const unit = (v: unknown) => v === null || txt(v, 32, 1);
function bounded(v: unknown, max: number): boolean {
  const scan = (x: unknown, depth = 0): boolean => depth <= 16 && (x === null || typeof x === 'string' || typeof x === 'boolean' || typeof x === 'number' && Number.isFinite(x) || Array.isArray(x) && x.every(i => scan(i, depth + 1)) || obj(x) && Object.values(x).every(i => scan(i, depth + 1)));
  try { return scan(v) && new TextEncoder().encode(JSON.stringify(v)).length <= max; } catch { return false; }
}
export function isTelemetryViewRequest(v: unknown, projectId?: string | null): v is TelemetryViewRequest {
  if (!bounded(v, 32768) || !obj(v) || !keys(v, ['schemaVersion', 'requestId', 'projectId', 'type', 'payload']) || v.schemaVersion !== 1 || !id(v.requestId) || !(v.projectId === null || id(v.projectId)) || !obj(v.payload)) return false;
  if (projectId !== undefined && projectId !== v.projectId && !(v.type === 'ready' && v.projectId === null)) return false;
  const p = v.payload;
  if (v.type === 'ready' || v.type === 'refresh') return keys(p, []);
  if (!id(v.projectId)) return false;
  switch (v.type) {
    case 'selectRecording': case 'stopCapture': return keys(p, ['recordingId']) && id(p.recordingId);
    case 'selectProfile': return keys(p, ['recordingId', 'profileId']) && id(p.recordingId) && id(p.profileId);
    case 'query': return keys(p, ['recordingId', 'profileId', 'channelIds', 'timeBasis', 'start', 'end'], ['deviceEpoch']) && id(p.recordingId) && id(p.profileId) && list(p.channelIds, 64, x => txt(x, 128, 1)) && p.channelIds.length > 0 && new Set(p.channelIds).size === p.channelIds.length && ['host-receive', 'device'].includes(String(p.timeBasis)) && num(p.start) && num(p.end) && p.end >= p.start && (p.timeBasis === 'device' ? integer(p.deviceEpoch) : p.deviceEpoch === undefined);
    case 'ask': case 'exportSelection': return keys(p, ['selection']) && isRecordingSelection(p.selection);
    case 'createProcedure': case 'editProfiles': return keys(p, []);
    case 'openProcedure': return keys(p, ['procedureId']) && id(p.procedureId);
    case 'createRun': return keys(p, ['procedureId'], ['selection']) && id(p.procedureId) && (p.selection === undefined || isRecordingSelection(p.selection));
    case 'finishRun': return keys(p, ['experimentId'], ['selection']) && id(p.experimentId) && (p.selection === undefined || isRecordingSelection(p.selection));
    case 'startRun': case 'appendNote': case 'judgeRun': case 'exportRun': return keys(p, ['experimentId']) && id(p.experimentId);
    case 'compare': return keys(p, ['experimentIds']) && list(p.experimentIds, 6, id) && p.experimentIds.length >= 2 && new Set(p.experimentIds).size === p.experimentIds.length;
    default: return false;
  }
}
const span = (v: unknown) => obj(v) && keys(v, ['connectionSessionId', 'sequence', 'byteStart', 'byteEnd'], ['lastSequence']) && id(v.connectionSessionId) && integer(v.sequence) && (v.lastSequence === undefined || integer(v.lastSequence) && v.lastSequence >= v.sequence) && integer(v.byteStart) && integer(v.byteEnd) && v.byteEnd >= v.byteStart;
function windowData(v: unknown): v is TelemetryWindow {
  if (!obj(v) || !keys(v, ['recordingId', 'derivationId', 'derivationSha256', 'rawSha256', 'segmentSha256s', 'parserVersion', 'configurationSha256', 'channelIds', 'timeBasis', 'start', 'end', 'samples', 'issues', 'gaps', 'statistics', 'totalSamples', 'downsampled', 'displayResolution'], ['deviceEpoch']) || !isTelemetryHash(v.derivationSha256)) return false;
  if (!isRecordingSelection({ schemaVersion: 1, projectRevision: 1, recordingId: v.recordingId, derivationId: v.derivationId, parserVersion: v.parserVersion, configurationSha256: v.configurationSha256, channelIds: v.channelIds, timeBasis: v.timeBasis, start: v.start, end: v.end, ...(v.deviceEpoch === undefined ? {} : { deviceEpoch: v.deviceEpoch }) }) || !isTelemetryHash(v.rawSha256) || !list(v.segmentSha256s, 256, isTelemetryHash)) return false;
  return list(v.samples, 10000, s => obj(s) && keys(s, ['channelId', 'value', 'unit', 'hostReceiveMs', 'deviceTimeMs', 'deviceEpoch', 'raw', 'parserVersion', 'configurationSha256']) && txt(s.channelId, 128, 1) && typeof s.value === 'number' && Number.isFinite(s.value) && unit(s.unit) && num(s.hostReceiveMs) && (s.deviceTimeMs === null || num(s.deviceTimeMs)) && integer(s.deviceEpoch) && s.parserVersion === v.parserVersion && s.configurationSha256 === v.configurationSha256 && list(s.raw, 256, span))
    && list(v.issues, 256, s => obj(s) && keys(s, ['code', 'message', 'hostReceiveMs', 'raw']) && ['invalid-utf8', 'invalid-frame', 'incomplete-frame', 'parse-limit', 'clock-reset', 'clock-wrap', 'clock-repeat', 'host-clock-reset', 'sequence-gap'].includes(String(s.code)) && txt(s.message) && num(s.hostReceiveMs) && list(s.raw, 256, span))
    && list(v.gaps, 256, s => obj(s) && keys(s, ['cause', 'startHostReceiveMs', 'endHostReceiveMs', 'lostBytes', 'connectionSessionId']) && txt(s.cause) && num(s.startHostReceiveMs) && (s.endHostReceiveMs === null || num(s.endHostReceiveMs) && s.endHostReceiveMs >= s.startHostReceiveMs) && (s.lostBytes === null || integer(s.lostBytes)) && id(s.connectionSessionId))
    && list(v.statistics, 64, s => obj(s) && keys(s, ['channelId', 'unit', 'count', 'min', 'max', 'mean']) && txt(s.channelId, 128, 1) && unit(s.unit) && integer(s.count) && [s.min, s.max, s.mean].every(n => n === null || typeof n === 'number' && Number.isFinite(n)))
    && integer(v.totalSamples) && v.totalSamples >= v.samples.length && typeof v.downsampled === 'boolean' && txt(v.displayResolution, 512, 1);
}
export function isTelemetryViewState(v: unknown): v is TelemetryViewState {
  if (!bounded(v, 1024 * 1024) || !obj(v) || !keys(v, ['schemaVersion', 'trusted', 'loading', 'error', 'stale', 'project', 'recordings', 'profiles', 'selectedRecordingId', 'selectedProfileId', 'window', 'revealedSelection', 'live', 'procedures', 'runs', 'comparison']) || v.schemaVersion !== 1 || typeof v.trusted !== 'boolean' || typeof v.loading !== 'boolean' || typeof v.stale !== 'boolean' || !(v.error === null || txt(v.error, 4096))) return false;
  if (!(v.project === null || obj(v.project) && keys(v.project, ['projectId', 'projectRevision', 'name']) && id(v.project.projectId) && revision(v.project.projectRevision) && txt(v.project.name, 1024, 1))) return false;
  if (!list(v.recordings, 500, r => obj(r) && keys(r, ['recordingId', 'projectRevision', 'startedAt', 'completion', 'device', 'artifactSha256', 'limitations']) && id(r.recordingId) && revision(r.projectRevision) && txt(r.startedAt, 64, 1) && Number.isFinite(Date.parse(r.startedAt)) && ['active', 'complete', 'partial', 'unavailable'].includes(String(r.completion)) && txt(r.device, 1024, 1) && (r.artifactSha256 === null || isTelemetryHash(r.artifactSha256)) && texts(r.limitations)) || !list(v.profiles, 64, p => obj(p) && isTelemetryHash(p.configurationSha256) && isParserProfile(p))) return false;
  if (!(v.selectedRecordingId === null || id(v.selectedRecordingId) && v.recordings.some(r => obj(r) && r.recordingId === v.selectedRecordingId)) || !(v.selectedProfileId === null || txt(v.selectedProfileId, 128, 1) && v.profiles.some(p => obj(p) && p.id === v.selectedProfileId)) || !(v.window === null || windowData(v.window) && v.window.recordingId === v.selectedRecordingId) || !(v.live === null || obj(v.live) && keys(v.live, ['recordingId', 'text', 'omittedBytes', 'captureActive']) && id(v.live.recordingId) && txt(v.live.text, 65536) && (v.live.omittedBytes === null || integer(v.live.omittedBytes)) && typeof v.live.captureActive === 'boolean')) return false;
  if (!list(v.procedures, 100, p => obj(p) && keys(p, ['procedureId', 'version', 'title']) && id(p.procedureId) && revision(p.version) && txt(p.title, 512, 1)) || !list(v.runs, 500, r => obj(r) && keys(r, ['experimentId', 'revisionId', 'title', 'procedureId', 'procedureVersion', 'projectRevision', 'lifecycle', 'outcome', 'recordingIds', 'parameters', 'limitations']) && id(r.experimentId) && id(r.revisionId) && txt(r.title, 512, 1) && id(r.procedureId) && revision(r.procedureVersion) && revision(r.projectRevision) && ['draft', 'ready', 'running', 'completed', 'aborted', 'interrupted'].includes(String(r.lifecycle)) && ['pass', 'fail', 'inconclusive', 'not-evaluated'].includes(String(r.outcome)) && list(r.recordingIds, 64, id) && list(r.parameters, 64, p => obj(p) && keys(p, ['name', 'value', 'unit']) && txt(p.name, 128, 1) && txt(p.value) && unit(p.unit)) && texts(r.limitations))) return false;
  if (!(v.comparison === null || obj(v.comparison) && keys(v.comparison, ['experimentIds', 'compatible', 'warnings', 'differences', 'series']) && list(v.comparison.experimentIds, 6, id) && typeof v.comparison.compatible === 'boolean' && texts(v.comparison.warnings) && list(v.comparison.differences, 64, d => obj(d) && keys(d, ['field', 'values']) && txt(d.field, 256, 1) && texts(d.values)) && list(v.comparison.series, 6, s => obj(s) && keys(s, ['seriesKey', 'label', 'unit', 'window']) && txt(s.seriesKey, 512, 1) && txt(s.label, 512, 1) && unit(s.unit) && windowData(s.window)))) return false;
  if (!(v.revealedSelection === null || isRecordingSelection(v.revealedSelection))) return false;
  const state = v as unknown as TelemetryViewState;
  if (new Set(state.recordings.map(r => r.recordingId)).size !== state.recordings.length || new Set(state.profiles.map(p => p.id)).size !== state.profiles.length || new Set(state.runs.map(r => r.experimentId)).size !== state.runs.length) return false;
  if (state.window) {
    const profile = state.profiles.find(p => p.id === state.selectedProfileId), w = state.window;
    if (!profile || profile.configurationSha256 !== w.configurationSha256 || profile.parserVersion !== w.parserVersion || !w.channelIds.every(c => profile.channels.some(p => p.channelId === c)) || !w.samples.every(s => w.channelIds.includes(s.channelId))) return false;
  }
  if (state.comparison && (state.comparison.experimentIds.length < 2 || new Set(state.comparison.experimentIds).size !== state.comparison.experimentIds.length || !state.comparison.experimentIds.every(id => state.runs.some(r => r.experimentId === id)) || !state.comparison.differences.every(d => d.values.length === state.comparison!.experimentIds.length) || new Set(state.comparison.series.map(s => s.seriesKey)).size !== state.comparison.series.length)) return false;
  return v.project !== null || !(v.recordings.length || v.profiles.length || v.runs.length || v.procedures.length || v.window || v.revealedSelection || v.live || v.comparison);
}
export function isTelemetryViewResponse(v: unknown): v is TelemetryViewResponse { return obj(v) && keys(v, ['schemaVersion', 'type', 'state']) && v.schemaVersion === 1 && v.type === 'state' && isTelemetryViewState(v.state); }

export function freezeTelemetrySelection(state: TelemetryViewState, start: number, end: number, channelIds: string[]): RecordingSelection | null {
  const w = state.window, recording = state.recordings.find(r => r.recordingId === state.selectedRecordingId);
  if (!w || !recording || !['complete', 'partial'].includes(recording.completion) || start < w.start || end > w.end || !channelIds.every(c => w.channelIds.includes(c))) return null;
  const selection = { schemaVersion: 1 as const, recordingId: w.recordingId, derivationId: w.derivationId, parserVersion: w.parserVersion, configurationSha256: w.configurationSha256, projectRevision: recording.projectRevision, channelIds: [...channelIds], timeBasis: w.timeBasis, start, end, ...(w.deviceEpoch === undefined ? {} : { deviceEpoch: w.deviceEpoch }) };
  return isRecordingSelection(selection) ? selection : null;
}
