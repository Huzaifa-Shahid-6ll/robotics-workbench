/** D33 v1: explicit parser configuration; raw bytes remain the evidence authority. */
export const TELEMETRY_PARSER_VERSION = 'telemetry-v1' as const;
export type TelemetryTimeBasis = 'host-receive' | 'device';
export type TelemetryChannel = { channelId: string; label: string; unit: string | null; source: string | number };
export type ParserProfile = {
  schemaVersion: 1; id: string; parserVersion: typeof TELEMETRY_PARSER_VERSION;
  mode: 'raw-text' | 'labeled-numeric' | 'csv' | 'jsonl'; channels: TelemetryChannel[];
  deviceClock?: { source: string | number; unit: 'ms' | 'us' | 's'; wrapAt: number | null };
};
export type HashedParserProfile = ParserProfile & { configurationSha256: string };
/** End-exclusive offsets; lastSequence groups a contiguous sequence range in one session. */
export type RawByteSpan = { connectionSessionId: string; sequence: number; lastSequence?: number; byteStart: number; byteEnd: number };
export type TelemetrySample = {
  channelId: string; value: number; unit: string | null; hostReceiveMs: number;
  deviceTimeMs: number | null; deviceEpoch: number; raw: RawByteSpan[];
  parserVersion: typeof TELEMETRY_PARSER_VERSION; configurationSha256: string;
};
export type TelemetryIssue = {
  code: 'invalid-utf8' | 'invalid-frame' | 'incomplete-frame' | 'parse-limit' | 'clock-reset' | 'clock-wrap' | 'clock-repeat' | 'host-clock-reset' | 'sequence-gap';
  message: string; hostReceiveMs: number; raw: RawByteSpan[];
};
export type TelemetryGap = {
  cause: string; startHostReceiveMs: number; endHostReceiveMs: number | null;
  lostBytes: number | null; connectionSessionId: string;
};
export type TelemetryBatch = { samples: TelemetrySample[]; issues: TelemetryIssue[]; gaps: TelemetryGap[] };
export type TelemetryProvenance = {
  recordingId: string; derivationId: string; derivationSha256: string; rawSha256: string; segmentSha256s: string[];
  parserVersion: typeof TELEMETRY_PARSER_VERSION; configurationSha256: string;
};
export type TelemetryDerivation = TelemetryBatch & TelemetryProvenance & { schemaVersion: 1; profile: HashedParserProfile };
export type TelemetryRange = { channelIds: string[]; timeBasis: TelemetryTimeBasis; start: number; end: number; deviceEpoch?: number };
export type TelemetryStatistic = { channelId: string; unit: string | null; count: number; min: number | null; max: number | null; mean: number | null };
export type TelemetryWindow = TelemetryBatch & TelemetryProvenance & TelemetryRange & {
  statistics: TelemetryStatistic[]; totalSamples: number; downsampled: boolean; displayResolution: string;
};
export type RecordingSelection = TelemetryRange & {
  schemaVersion: 1; recordingId: string; derivationId: string; parserVersion: typeof TELEMETRY_PARSER_VERSION;
  configurationSha256: string; projectRevision: number;
};

const text = (value: unknown, max = 128): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(key => key in value) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
export const isTelemetryHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function isParserProfile(value: unknown): value is ParserProfile {
  if (!object(value) || !keys(value, ['schemaVersion', 'id', 'parserVersion', 'mode', 'channels'], ['deviceClock', 'configurationSha256'])
    || value.schemaVersion !== 1 || value.parserVersion !== TELEMETRY_PARSER_VERSION || !uuid(value.id)
    || !['raw-text', 'labeled-numeric', 'csv', 'jsonl'].includes(value.mode as string) || !Array.isArray(value.channels) || value.channels.length > 64) return false;
  const mode = value.mode;
  const source = (item: unknown) => mode === 'csv' ? Number.isSafeInteger(item) && Number(item) >= 0 && Number(item) < 256 : text(item) && (mode !== 'labeled-numeric' || !/[\s,:=]/.test(item));
  if (mode === 'raw-text' ? value.channels.length !== 0 || value.deviceClock !== undefined : value.channels.length === 0) return false;
  if (!value.channels.every(item => object(item) && keys(item, ['channelId', 'label', 'unit', 'source']) && text(item.channelId) && text(item.label) && (item.unit === null || text(item.unit, 32)) && source(item.source))) return false;
  if (new Set(value.channels.map(item => item.channelId)).size !== value.channels.length || new Set(value.channels.map(item => item.source)).size !== value.channels.length) return false;
  if (value.configurationSha256 !== undefined && !isTelemetryHash(value.configurationSha256)) return false;
  if (value.deviceClock !== undefined) {
    const clock = value.deviceClock;
    if (!object(clock) || !keys(clock, ['source', 'unit', 'wrapAt']) || !source(clock.source) || !['ms', 'us', 's'].includes(clock.unit as string)
      || (clock.wrapAt !== null && (typeof clock.wrapAt !== 'number' || !Number.isFinite(clock.wrapAt) || clock.wrapAt <= 0))) return false;
  }
  return true;
}
export function isRecordingSelection(value: unknown): value is RecordingSelection {
  if (!object(value) || !keys(value, ['schemaVersion', 'recordingId', 'derivationId', 'parserVersion', 'configurationSha256', 'projectRevision', 'channelIds', 'timeBasis', 'start', 'end'], ['deviceEpoch'])) return false;
  return value.schemaVersion === 1 && uuid(value.recordingId)
    && uuid(value.derivationId) && isTelemetryHash(value.configurationSha256) && value.parserVersion === TELEMETRY_PARSER_VERSION
    && Number.isSafeInteger(value.projectRevision) && Number(value.projectRevision) > 0 && Array.isArray(value.channelIds) && value.channelIds.length > 0 && value.channelIds.length <= 64
    && value.channelIds.every(item => text(item)) && new Set(value.channelIds).size === value.channelIds.length
    && ['host-receive', 'device'].includes(value.timeBasis as string) && typeof value.start === 'number' && Number.isFinite(value.start) && value.start >= 0
    && typeof value.end === 'number' && Number.isFinite(value.end) && value.end >= value.start
    && (value.timeBasis === 'device' ? Number.isSafeInteger(value.deviceEpoch) && Number(value.deviceEpoch) >= 0 : value.deviceEpoch === undefined);
}

export function isTelemetryDerivation(value: unknown): value is TelemetryDerivation {
  const finite = (number: unknown): number is number => typeof number === 'number' && Number.isFinite(number);
  const nonnegative = (number: unknown) => finite(number) && number >= 0;
  const raw = (spans: unknown) => Array.isArray(spans) && spans.length <= 1024 && spans.every(span => object(span)
    && keys(span, ['connectionSessionId', 'sequence', 'byteStart', 'byteEnd'], ['lastSequence']) && uuid(span.connectionSessionId)
    && Number.isSafeInteger(span.sequence) && Number(span.sequence) >= 0 && Number.isSafeInteger(span.byteStart) && Number(span.byteStart) >= 0
    && Number.isSafeInteger(span.byteEnd) && Number(span.byteEnd) >= 0
    && (span.lastSequence === undefined ? Number(span.byteEnd) >= Number(span.byteStart) : Number.isSafeInteger(span.lastSequence) && Number(span.lastSequence) > Number(span.sequence)));
  if (!object(value) || !keys(value, ['schemaVersion', 'recordingId', 'derivationId', 'derivationSha256', 'rawSha256', 'segmentSha256s', 'parserVersion', 'configurationSha256', 'profile', 'samples', 'issues', 'gaps'])
    || value.schemaVersion !== 1 || !uuid(value.recordingId) || !uuid(value.derivationId) || !isTelemetryHash(value.derivationSha256) || !isTelemetryHash(value.rawSha256)
    || !Array.isArray(value.segmentSha256s) || !value.segmentSha256s.every(isTelemetryHash) || value.parserVersion !== TELEMETRY_PARSER_VERSION
    || !isTelemetryHash(value.configurationSha256) || !isParserProfile(value.profile) || (value.profile as HashedParserProfile).configurationSha256 !== value.configurationSha256
    || !Array.isArray(value.samples) || !Array.isArray(value.issues) || !Array.isArray(value.gaps)) return false;
  const channels = value.profile.channels;
  return value.samples.every(sample => object(sample) && keys(sample, ['channelId', 'value', 'unit', 'hostReceiveMs', 'deviceTimeMs', 'deviceEpoch', 'raw', 'parserVersion', 'configurationSha256'])
    && channels.some(channel => channel.channelId === sample.channelId && channel.unit === sample.unit) && finite(sample.value) && nonnegative(sample.hostReceiveMs)
    && (value.profile && (value.profile as ParserProfile).deviceClock ? nonnegative(sample.deviceTimeMs) : sample.deviceTimeMs === null) && Number.isSafeInteger(sample.deviceEpoch) && Number(sample.deviceEpoch) >= 0
    && Array.isArray(sample.raw) && sample.raw.length > 0 && raw(sample.raw) && sample.parserVersion === value.parserVersion && sample.configurationSha256 === value.configurationSha256)
    && value.issues.every(issue => object(issue) && keys(issue, ['code', 'message', 'hostReceiveMs', 'raw'])
      && ['invalid-utf8', 'invalid-frame', 'incomplete-frame', 'parse-limit', 'clock-reset', 'clock-wrap', 'clock-repeat', 'host-clock-reset', 'sequence-gap'].includes(issue.code as string)
      && text(issue.message, 512) && nonnegative(issue.hostReceiveMs) && raw(issue.raw))
    && value.gaps.every(gap => object(gap) && keys(gap, ['cause', 'startHostReceiveMs', 'endHostReceiveMs', 'lostBytes', 'connectionSessionId'])
      && text(gap.cause) && nonnegative(gap.startHostReceiveMs) && (gap.endHostReceiveMs === null || nonnegative(gap.endHostReceiveMs) && Number(gap.endHostReceiveMs) >= Number(gap.startHostReceiveMs))
      && (gap.lostBytes === null || Number.isSafeInteger(gap.lostBytes) && Number(gap.lostBytes) >= 0) && uuid(gap.connectionSessionId));
}
