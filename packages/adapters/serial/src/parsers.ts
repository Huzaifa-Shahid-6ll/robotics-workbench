import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { isRequestId, WorkbenchError } from '@robotics-workbench/contracts';
import { TELEMETRY_PARSER_VERSION, isParserProfile, isTelemetryHash, type HashedParserProfile, type RawByteSpan, type TelemetryBatch, type TelemetryDerivation, type TelemetryGap, type TelemetryIssue, type TelemetryRange, type TelemetrySample, type TelemetryWindow } from '@robotics-workbench/contracts';
import type { RawGap, RawRecord } from './recorder';

const FRAME_LIMIT = 1024 * 1024;
const empty = (): TelemetryBatch => ({ samples: [], issues: [], gaps: [] });
const fail = (message: string): never => { throw new WorkbenchError('INVALID_REQUEST', message); };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
/** A supplied hash is a precondition, never silently refreshed after configuration edits. */
export function createParserProfile(value: unknown): HashedParserProfile {
  if (!isParserProfile(value)) return fail('Choose a supported explicit versioned parser profile with unique channel mappings.');
  const { configurationSha256: expected, ...configuration } = value as HashedParserProfile;
  const configurationSha256 = hash(configuration);
  if (expected !== undefined && expected !== configurationSha256) return fail('Parser profile hash does not match its immutable configuration.');
  return freeze({ ...structuredClone(configuration), configurationSha256 });
}
const milliseconds = (ns: string) => Number(BigInt(ns) / 1000n) / 1000;
function span(spans: RawByteSpan[], record: RawRecord, start: number, end: number): void {
  if (end <= start) return;
  const previous = spans.at(-1), last = previous?.lastSequence ?? previous?.sequence;
  if (previous?.connectionSessionId === record.connectionSessionId && (last === record.sequence && previous.byteEnd === start || last === record.sequence - 1 && start === 0)) {
    if (previous.sequence !== record.sequence) previous.lastSequence = record.sequence;
    previous.byteEnd = end;
  } else spans.push({ connectionSessionId: record.connectionSessionId, sequence: record.sequence, byteStart: start, byteEnd: end });
}
const numberPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
function validateGap(gap: RawGap): void {
  if (!gap || !isRequestId(gap.connectionSessionId) || typeof gap.startElapsedNs !== 'string' || !/^(0|[1-9][0-9]{0,29})$/.test(gap.startElapsedNs)
    || (gap.endElapsedNs !== null && (typeof gap.endElapsedNs !== 'string' || !/^(0|[1-9][0-9]{0,29})$/.test(gap.endElapsedNs) || BigInt(gap.endElapsedNs) < BigInt(gap.startElapsedNs)))
    || !['upload', 'disconnect', 'reconnect', 'overflow', 'disk-failure', 'cancelled', 'limit', 'service-restart'].includes(gap.cause)
    || (gap.lostBytes !== null && (!Number.isSafeInteger(gap.lostBytes) || gap.lostBytes < 0))) return fail('Malformed raw capture gap.');
}
function numeric(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' && numberPattern.test(value.trim()) ? Number(value.trim()) : NaN;
  return Number.isFinite(number) ? number : undefined;
}
function fields(text: string, profile: HashedParserProfile): Map<string | number, unknown> {
  if (profile.mode === 'jsonl') {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
    return new Map(Object.entries(value));
  }
  if (profile.mode === 'csv') {
    const result: string[] = []; let field = '', quoted = false, closed = false;
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (quoted) {
        if (char === '"') { if (text[index + 1] === '"') { field += '"'; index++; } else { quoted = false; closed = true; } }
        else field += char;
      } else if (char === ',') { result.push(field); field = ''; closed = false; }
      else if (char === '"' && !field && !closed) quoted = true;
      else if (closed || char === '"') throw new Error('Malformed CSV field.');
      else field += char;
    }
    if (quoted) throw new Error('Unclosed CSV field.');
    result.push(field); return new Map(result.map((value, index) => [index, value]));
  }
  const result = new Map<string | number, unknown>();
  // Explicit Arduino label:value tokens; no extraction from arbitrary prose or unit suffixes.
  const token = /([^\s,:=]+)\s*[:=]\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(?=$|[\s,])/igy;
  let position = 0;
  while (position < text.length) {
    while (/[\s,]/.test(text[position] ?? '') && position < text.length) position++;
    if (position === text.length) break;
    token.lastIndex = position; const match = token.exec(text);
    if (!match || result.has(match[1])) throw new Error('Malformed or duplicate labeled value.');
    result.set(match[1], match[2]); position = token.lastIndex;
  }
  return result;
}

/** One bounded incremental parser per explicit profile. It never writes raw data or opens a port. */
export class StreamingTelemetryParser {
  readonly profile: HashedParserProfile;
  private frameBytes = Buffer.alloc(0);
  private bytes = 0;
  private raw: RawByteSpan[] = [];
  private oversized = false;
  private lastRecord?: RawRecord;
  private recordingId?: string;
  private hostReceiveMs = 0;
  private previousDevice?: number;
  private deviceOffset = 0;
  private deviceEpoch = 0;
  private closed = false;
  constructor(profile: HashedParserProfile) { this.profile = createParserProfile(profile); }

  push(record: RawRecord): TelemetryBatch {
    if (this.closed) return fail('A finished parser cannot accept additional bytes.');
    if (!record || typeof record !== 'object' || Object.keys(record).sort().join(',') !== 'bytesBase64,connectionSessionId,hostElapsedNs,hostReceivedAt,quality,recordingId,schemaVersion,sequence'
      || record.schemaVersion !== 1 || !isRequestId(record.recordingId) || !isRequestId(record.connectionSessionId)
      || !Number.isSafeInteger(record.sequence) || record.sequence < 0 || typeof record.hostElapsedNs !== 'string' || !/^(0|[1-9][0-9]{0,29})$/.test(record.hostElapsedNs)
      || typeof record.bytesBase64 !== 'string' || record.bytesBase64.length > 12 * FRAME_LIMIT
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(record.bytesBase64)
      || typeof record.hostReceivedAt !== 'string' || !record.hostReceivedAt.endsWith('Z') || !Number.isFinite(Date.parse(record.hostReceivedAt)) || record.quality !== 'received') return fail('Malformed raw telemetry record.');
    if (this.recordingId && this.recordingId !== record.recordingId) return fail('One parser cannot combine different recordings.');
    this.recordingId = record.recordingId;
    const bytes = Buffer.from(record.bytesBase64, 'base64');
    if (bytes.toString('base64') !== record.bytesBase64) return fail('Raw byte encoding must be canonical base64.');
    const result = empty(), hostReceiveMs = milliseconds(record.hostElapsedNs), previous = this.lastRecord;
    if (!Number.isFinite(hostReceiveMs)) return fail('Raw monotonic receive time is outside the supported range.');
    if (previous && (previous.connectionSessionId !== record.connectionSessionId || record.sequence !== previous.sequence + 1)) {
      this.flushIncomplete(result);
      result.gaps.push({ cause: previous.connectionSessionId === record.connectionSessionId ? 'sequence-gap' : 'connection-boundary', startHostReceiveMs: this.hostReceiveMs, endHostReceiveMs: Math.max(this.hostReceiveMs, hostReceiveMs), lostBytes: null, connectionSessionId: previous.connectionSessionId });
      if (previous.connectionSessionId === record.connectionSessionId) this.issue(result, 'sequence-gap', 'Raw record sequence is not contiguous.');
      this.resetClock();
    }
    if (previous && hostReceiveMs < this.hostReceiveMs) {
      this.flushIncomplete(result); this.hostReceiveMs = hostReceiveMs; this.lastRecord = record;
      this.issue(result, 'host-clock-reset', 'Monotonic receive time moved backwards; no acquisition-time claim is made.'); this.resetClock();
    }
    this.hostReceiveMs = hostReceiveMs; this.lastRecord = record;
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start), end = newline < 0 ? bytes.length : newline + 1;
      span(this.raw, record, start, end);
      const length = end - start;
      if (!this.oversized && this.bytes + length > FRAME_LIMIT) this.oversized = true;
      if (!this.oversized) {
        if (this.bytes + length > this.frameBytes.length) {
          const grown = Buffer.allocUnsafe(Math.min(FRAME_LIMIT, Math.max(this.bytes + length, this.frameBytes.length * 2, 4096)));
          this.frameBytes.copy(grown, 0, 0, this.bytes); this.frameBytes = grown;
        }
        bytes.copy(this.frameBytes, this.bytes, start, end); this.bytes += length;
      }
      if (newline >= 0) { this.frame(result); this.clearFrame(); }
      start = end;
    }
    return result;
  }

  gap(gap: RawGap): TelemetryBatch {
    if (this.closed) return fail('A finished parser cannot accept gaps.');
    validateGap(gap);
    const result = empty(); this.flushIncomplete(result); this.resetClock(); this.lastRecord = undefined;
    result.gaps.push({ cause: gap.cause, startHostReceiveMs: milliseconds(gap.startElapsedNs), endHostReceiveMs: gap.endElapsedNs === null ? null : milliseconds(gap.endElapsedNs), lostBytes: gap.lostBytes, connectionSessionId: gap.connectionSessionId });
    return result;
  }
  finish(): TelemetryBatch { const result = empty(); if (!this.closed) { this.flushIncomplete(result); this.closed = true; } return result; }
  private resetClock(): void { this.previousDevice = undefined; this.deviceOffset = 0; this.deviceEpoch++; }
  private clearFrame(): void { this.bytes = 0; this.raw = []; this.oversized = false; }
  private issue(result: TelemetryBatch, code: TelemetryIssue['code'], message: string): void {
    result.issues.push({ code, message, hostReceiveMs: this.hostReceiveMs, raw: structuredClone(this.raw) });
    if (['invalid-utf8', 'invalid-frame', 'incomplete-frame', 'parse-limit', 'host-clock-reset'].includes(code) && this.lastRecord) result.gaps.push({ cause: code, startHostReceiveMs: this.hostReceiveMs, endHostReceiveMs: this.hostReceiveMs, lostBytes: null, connectionSessionId: this.lastRecord.connectionSessionId });
  }
  private flushIncomplete(result: TelemetryBatch): void {
    if (this.raw.length) this.issue(result, this.oversized ? 'parse-limit' : 'incomplete-frame', this.oversized ? 'Parser frame exceeded 1 MiB; raw bytes remain available.' : 'Incomplete line retained as raw evidence; no numeric sample emitted.');
    this.clearFrame();
  }
  private frame(result: TelemetryBatch): void {
    if (this.oversized) { this.issue(result, 'parse-limit', 'Parser frame exceeded 1 MiB; raw bytes remain available.'); return; }
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(this.frameBytes.subarray(0, this.bytes)).replace(/\r?\n$/, ''); }
    catch { this.issue(result, 'invalid-utf8', 'Invalid UTF-8 retained as raw bytes; no numeric sample emitted.'); return; }
    if (this.profile.mode === 'raw-text' || !text.trim()) return;
    let values: Map<string | number, unknown>;
    try { if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error('Binary input.'); values = fields(text, this.profile); }
    catch { this.issue(result, 'invalid-frame', 'Frame does not match the explicitly selected parser.'); return; }
    const numbers = this.profile.channels.map(channel => this.profile.mode === 'jsonl' && typeof values.get(channel.source) !== 'number' ? undefined : numeric(values.get(channel.source)));
    const clock = this.profile.deviceClock;
    const device = clock ? this.profile.mode === 'jsonl' && typeof values.get(clock.source) !== 'number' ? undefined : numeric(values.get(clock.source)) : undefined;
    if (numbers.some(value => value === undefined) || clock && (device === undefined || device < 0 || clock.wrapAt !== null && device >= clock.wrapAt)) { this.issue(result, 'invalid-frame', 'Configured fields must contain finite numbers; absent values remain unknown.'); return; }
    let deviceTimeMs: number | null = null;
    if (clock && device !== undefined) {
      if (this.previousDevice !== undefined) {
        if (device === this.previousDevice) this.issue(result, 'clock-repeat', 'Device timestamp repeated; samples are retained without invented timing.');
        else if (device < this.previousDevice) {
          if (clock.wrapAt !== null && this.previousDevice >= clock.wrapAt * 0.75 && device <= clock.wrapAt * 0.25) { this.deviceOffset += clock.wrapAt; this.issue(result, 'clock-wrap', 'Device clock unwrapped using the configured modulus; a device reset cannot be excluded.'); }
          else { this.deviceEpoch++; this.deviceOffset = 0; this.issue(result, 'clock-reset', 'Device clock moved backwards; a distinct clock epoch begins.'); }
        }
      }
      this.previousDevice = device; deviceTimeMs = (device + this.deviceOffset) * (clock.unit === 's' ? 1000 : clock.unit === 'us' ? 0.001 : 1);
      if (!Number.isFinite(deviceTimeMs)) { this.issue(result, 'invalid-frame', 'Device time overflowed the supported finite range.'); return; }
    }
    this.profile.channels.forEach((channel, index) => result.samples.push({ channelId: channel.channelId, value: numbers[index]!, unit: channel.unit, hostReceiveMs: this.hostReceiveMs, deviceTimeMs, deviceEpoch: this.deviceEpoch, raw: structuredClone(this.raw), parserVersion: TELEMETRY_PARSER_VERSION, configurationSha256: this.profile.configurationSha256 }));
  }
}

function append(target: TelemetryBatch, batch: TelemetryBatch): void { target.samples.push(...batch.samples); target.issues.push(...batch.issues); target.gaps.push(...batch.gaps); }
function uuidFromHash(sha256: string): string {
  const bytes = Buffer.from(sha256.slice(0, 32), 'hex'); bytes[6] = (bytes[6] & 15) | 0x80; bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function deriveTelemetry(records: Iterable<RawRecord>, gaps: readonly RawGap[], profile: HashedParserProfile, identity: { recordingId: string; rawSha256: string; segmentSha256s: string[] }): TelemetryDerivation {
  if (!identity || !isRequestId(identity.recordingId) || !isTelemetryHash(identity.rawSha256) || !Array.isArray(identity.segmentSha256s) || !identity.segmentSha256s.every(isTelemetryHash)) return fail('Derivation requires exact raw recording hashes.');
  if (!Array.isArray(gaps) || gaps.length > 1000) return fail('Derivation requires a bounded raw capture gap list.');
  gaps.forEach(validateGap);
  const parser = new StreamingTelemetryParser(profile), result = empty(), rawHash = createHash('sha256');
  const orderedGaps = [...gaps].sort((a, b) => BigInt(a.startElapsedNs) < BigInt(b.startElapsedNs) ? -1 : BigInt(a.startElapsedNs) > BigInt(b.startElapsedNs) ? 1 : 0); let gapIndex = 0;
  for (const record of records) {
    if (record.recordingId !== identity.recordingId) return fail('Raw recording identity does not match the requested derivation.');
    if (typeof record.hostElapsedNs !== 'string' || !/^(0|[1-9][0-9]{0,29})$/.test(record.hostElapsedNs)) return fail('Malformed raw telemetry receive time.');
    while (gapIndex < orderedGaps.length && BigInt(orderedGaps[gapIndex].startElapsedNs) <= BigInt(record.hostElapsedNs)) append(result, parser.gap(orderedGaps[gapIndex++]));
    append(result, parser.push(record)); rawHash.update(Buffer.from(record.bytesBase64, 'base64'));
  }
  while (gapIndex < orderedGaps.length) append(result, parser.gap(orderedGaps[gapIndex++]));
  append(result, parser.finish());
  if (rawHash.digest('hex') !== identity.rawSha256) return fail('Raw recording bytes do not match the retained digest.');
  const derivationSha256 = hash({ schemaVersion: 1, ...identity, configurationSha256: parser.profile.configurationSha256, parserVersion: TELEMETRY_PARSER_VERSION, gaps });
  return { schemaVersion: 1, ...structuredClone(identity), derivationId: uuidFromHash(derivationSha256), derivationSha256, parserVersion: TELEMETRY_PARSER_VERSION, configurationSha256: parser.profile.configurationSha256, profile: parser.profile, ...result };
}

/** Exact extrema and endpoints survive each bucket; a gap starts a separate display segment. */
export function downsampleTelemetry(samples: readonly TelemetrySample[], maxPoints: number, gaps: readonly TelemetryGap[] = []): TelemetrySample[] {
  if (!Number.isSafeInteger(maxPoints) || maxPoints < 1 || maxPoints > 10000) return fail('Display sample limit must be from 1 to 10000.');
  if (samples.length <= maxPoints) return [...samples];
  const groups = new Map<string, TelemetrySample[][]>();
  for (const sample of samples) {
    const key = sample.channelId + ':' + sample.deviceEpoch, segments = groups.get(key) ?? [[]], current = segments.at(-1)!, previous = current.at(-1);
    if (previous && (previous.raw.at(-1)?.connectionSessionId !== sample.raw[0]?.connectionSessionId || gaps.some(gap => gap.startHostReceiveMs >= previous.hostReceiveMs && gap.startHostReceiveMs <= sample.hostReceiveMs))) segments.push([]);
    segments.at(-1)!.push(sample); groups.set(key, segments);
  }
  const segments = [...groups.values()].flat(), minimum = segments.reduce((count, segment) => count + Math.min(4, segment.length), 0);
  if (minimum > maxPoints) return fail('Increase the sample limit to preserve channel extrema and capture gaps.');
  const bucketCount = Math.max(1, Math.floor(maxPoints / Math.max(1, segments.length) / 4)), selected = new Set<TelemetrySample>();
  for (const segment of segments) {
    const buckets = Math.min(bucketCount, Math.max(1, Math.ceil(segment.length / 4)));
    for (let bucket = 0; bucket < buckets; bucket++) {
      const start = Math.floor(bucket * segment.length / buckets), end = Math.floor((bucket + 1) * segment.length / buckets);
      let min = segment[start], max = segment[start];
      for (let index = start + 1; index < end; index++) { if (segment[index].value < min.value) min = segment[index]; if (segment[index].value > max.value) max = segment[index]; }
      selected.add(segment[start]); selected.add(min); selected.add(max); selected.add(segment[end - 1]);
    }
  }
  return samples.filter(sample => selected.has(sample));
}

export function queryTelemetry(derivation: TelemetryDerivation, request: TelemetryRange & { limit: number }): TelemetryWindow {
  const { channelIds, timeBasis, start, end, deviceEpoch, limit } = request;
  if (!Array.isArray(channelIds) || channelIds.length < 1 || channelIds.length > 64 || new Set(channelIds).size !== channelIds.length || !channelIds.every(id => derivation.profile.channels.some(channel => channel.channelId === id))
    || !['host-receive', 'device'].includes(timeBasis) || !Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end < start
    || (timeBasis === 'device' ? !derivation.profile.deviceClock || !Number.isSafeInteger(deviceEpoch) || deviceEpoch! < 0 : deviceEpoch !== undefined)
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 10000) return fail('Choose configured channels and an explicit finite range; device time requires its clock epoch.');
  const selected = derivation.samples.filter(sample => { const time = timeBasis === 'host-receive' ? sample.hostReceiveMs : sample.deviceEpoch === deviceEpoch ? sample.deviceTimeMs : null; return channelIds.includes(sample.channelId) && time !== null && time >= start && time <= end; });
  // Device clocks cannot place a raw capture gap without a clock mapping; retain all disclosed gaps.
  const gaps = derivation.gaps.filter(gap => timeBasis === 'device' || gap.startHostReceiveMs <= end && (gap.endHostReceiveMs === null || gap.endHostReceiveMs >= start));
  const issues = derivation.issues.filter(issue => timeBasis === 'device' || issue.hostReceiveMs >= start && issue.hostReceiveMs <= end);
  const statistics = channelIds.map(channelId => {
    const values = selected.filter(sample => sample.channelId === channelId); let min: number | null = null, max: number | null = null, mean: number | null = null;
    values.forEach((sample, index) => { min = min === null ? sample.value : Math.min(min, sample.value); max = max === null ? sample.value : Math.max(max, sample.value); mean = mean === null ? sample.value : mean * (index / (index + 1)) + sample.value / (index + 1); });
    return { channelId, unit: derivation.profile.channels.find(channel => channel.channelId === channelId)!.unit, count: values.length, min, max, mean };
  });
  const samples = downsampleTelemetry(selected, limit, gaps), downsampled = samples.length < selected.length;
  const { recordingId, derivationId, derivationSha256, rawSha256, segmentSha256s, parserVersion, configurationSha256 } = derivation;
  return { recordingId, derivationId, derivationSha256, rawSha256, segmentSha256s: [...segmentSha256s], parserVersion, configurationSha256, channelIds: [...channelIds], timeBasis, start, end, ...(deviceEpoch === undefined ? {} : { deviceEpoch }), samples, gaps, issues, statistics, totalSamples: selected.length, downsampled, displayResolution: downsampled ? 'Extrema and endpoints per bucket; capture gaps preserved. Statistics use every selected sample.' : 'Every selected sample; no interpolation.' };
}
