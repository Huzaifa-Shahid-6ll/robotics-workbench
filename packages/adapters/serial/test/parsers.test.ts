import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createParserProfile, StreamingTelemetryParser, deriveTelemetry, queryTelemetry, downsampleTelemetry } from '../src/parsers';
import { isParserProfile, isRecordingSelection, isTelemetryDerivation, type ParserProfile, type TelemetryBatch, type TelemetrySample } from '@robotics-workbench/contracts';
import type { RawGap, RawRecord } from '../src/recorder';

const recordingId = '44444444-4444-4444-8444-444444444444', session = '55555555-5555-4555-8555-555555555555', profileId = '66666666-6666-4666-8666-666666666666';
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const input = (mode: ParserProfile['mode'] = 'labeled-numeric'): ParserProfile => ({ schemaVersion: 1, id: profileId, parserVersion: 'telemetry-v1', mode,
  channels: mode === 'raw-text' ? [] : [{ channelId: 'range', label: 'Range', unit: 'mm', source: mode === 'csv' ? 0 : 'range' }] });
function record(bytes: Uint8Array | string, sequence = 0, elapsedMs = 0, connectionSessionId = session): RawRecord {
  return { schemaVersion: 1, recordingId, connectionSessionId, sequence, hostElapsedNs: String(elapsedMs * 1e6), hostReceivedAt: '2026-11-03T00:00:00.000Z', bytesBase64: Buffer.from(bytes).toString('base64'), quality: 'received' };
}
function parse(records: RawRecord[], profile = createParserProfile(input()), gaps: RawGap[] = []) {
  return deriveTelemetry(records, gaps, profile, { recordingId, rawSha256: sha(Buffer.concat(records.map(record => Buffer.from(record.bytesBase64, 'base64')))), segmentSha256s: [sha(records.map(record => JSON.stringify(record) + '\n').join(''))] });
}
function batch(parser: StreamingTelemetryParser, records: RawRecord[]): TelemetryBatch {
  const all = [...records.map(record => parser.push(record)), parser.finish()];
  return { samples: all.flatMap(part => part.samples), issues: all.flatMap(part => part.issues), gaps: all.flatMap(part => part.gaps) };
}

test('explicit synthetic fixture preserves raw bytes, split lines, values and receive-time basis', () => {
  const fixture = JSON.parse(readFileSync(join(process.cwd(), 'packages/test-fixtures/recordings/telemetry-v1.synthetic.json'), 'utf8'));
  assert.equal(fixture.kind, 'synthetic-software-fixture');
  const records = fixture.chunks.map((chunk: { bytesBase64: string; hostElapsedNs: string }, sequence: number) => ({ ...record('', sequence), ...chunk }));
  const before = JSON.stringify(records), result = parse(records, createParserProfile(fixture.profile));
  assert.deepEqual(result.samples.map(sample => sample.value), fixture.expectedValues);
  assert.equal(JSON.stringify(records), before); assert.equal(result.samples[0].hostReceiveMs, 10);
  assert.equal(result.samples[0].deviceTimeMs, null); assert.ok(isTelemetryDerivation(result));
});

test('every possible split and byte-at-a-time fragmentation match coalesced numeric results', () => {
  const bytes = Buffer.from('range:12.3\r\nrange:-4e2\nrange:0\n');
  const expected = parse([record(bytes)]).samples.map(sample => sample.value);
  for (let index = 1; index < bytes.length; index++) {
    const records = [record(bytes.subarray(0, index)), record(bytes.subarray(index), 1)];
    const actual = parse(records); assert.deepEqual(actual.samples.map(sample => sample.value), expected); assert.equal(actual.rawSha256, sha(bytes));
  }
  const records = [...bytes].map((byte, sequence) => record(Buffer.from([byte]), sequence));
  const actual = parse(records); assert.deepEqual(actual.samples.map(sample => sample.value), expected);
  assert.deepEqual(actual.samples[0].raw, [{ connectionSessionId: session, sequence: 0, lastSequence: 11, byteStart: 0, byteEnd: 1 }]);
});

test('raw spans expand to exact line bytes across grouped record sequences', () => {
  const records = [record('range:1\nran'), record('ge:2\nrange:3\n', 1)];
  const result = parse(records);
  const expand = (sample: TelemetrySample) => Buffer.concat(sample.raw.flatMap(span => records.filter(record => record.connectionSessionId === span.connectionSessionId && record.sequence >= span.sequence && record.sequence <= (span.lastSequence ?? span.sequence)).map(record => Buffer.from(record.bytesBase64, 'base64').subarray(record.sequence === span.sequence ? span.byteStart : 0, record.sequence === (span.lastSequence ?? span.sequence) ? span.byteEnd : undefined)))).toString();
  assert.deepEqual(result.samples.map(expand), ['range:1\n', 'range:2\n', 'range:3\n']);
});

test('invalid UTF-8, binary, missing fields, NaN, infinity, prose and unfinished line produce no false sample', () => {
  const records = [record(Buffer.from([0xff, 10])), record('range:1\0\n', 1), record('voltage:2\n', 2), record('range:NaN\n', 3), record('range:1e999\n', 4), record('The range:12 is good\n', 5), record('range:3', 6)];
  const result = parse(records);
  assert.equal(result.samples.length, 0); assert.equal(result.issues.length, 7);
  assert.equal(result.issues[0].code, 'invalid-utf8'); assert.equal(result.issues.at(-1)?.code, 'incomplete-frame');
  assert.equal(result.rawSha256, sha(Buffer.concat(records.map(record => Buffer.from(record.bytesBase64, 'base64')))));
});

test('explicit raw text never auto-switches to a numeric parser', () => {
  const result = parse([record('range:12\n{"range":13}\n1,2\n')], createParserProfile(input('raw-text')));
  assert.equal(result.samples.length, 0); assert.equal(result.issues.length, 0);
});

test('CSV mapping supports quoted fields, finite values and explicit unknown units', () => {
  const profile = input('csv'); profile.channels = [{ channelId: 'x', label: 'X', unit: null, source: 1 }];
  const result = parse([record('"ignored,field",12.5\n"",-2\n"broken,3\n,NaN\n')], createParserProfile(profile));
  assert.deepEqual(result.samples.map(sample => [sample.channelId, sample.value, sample.unit]), [['x', 12.5, null], ['x', -2, null]]);
  assert.equal(result.issues.length, 2);
});

test('JSONL mapping requires numeric JSON values and emits no partial multichannel frame', () => {
  const profile = input('jsonl'); profile.channels.push({ channelId: 'temperature', label: 'Temperature', unit: 'C', source: 'temperature' });
  const result = parse([record('{"range":2,"temperature":20}\n{"range":"3","temperature":21}\n{"range":4}\n[]\n')], createParserProfile(profile));
  assert.deepEqual(result.samples.map(sample => sample.value), [2, 20]); assert.equal(result.issues.length, 3);
});

test('configuration is immutable, deterministic, versioned and rejects stale hash/mapping', () => {
  const profile = createParserProfile(input()); assert.ok(Object.isFrozen(profile.channels[0]));
  assert.equal(createParserProfile(JSON.parse(JSON.stringify(profile))).configurationSha256, profile.configurationSha256);
  assert.throws(() => createParserProfile({ ...profile, mode: 'jsonl' }), /hash/);
  assert.throws(() => createParserProfile({ ...profile, parserVersion: 'telemetry-v2' }), /supported/);
  assert.equal(isParserProfile({ ...input(), channels: [input().channels[0], input().channels[0]] }), false);
  assert.equal(isParserProfile({ ...input(), id: 'renamable-label' }), false);
});

test('one MiB parser limit reports exact raw references, discards until delimiter and resumes', () => {
  const huge = Buffer.from('range:' + '1'.repeat(1024 * 1024));
  const records = [record(huge.subarray(0, 65536)), record(huge.subarray(65536), 1), record('\nrange:8\n', 2)];
  const result = parse(records); assert.deepEqual(result.samples.map(sample => sample.value), [8]);
  assert.equal(result.issues[0].code, 'parse-limit'); assert.deepEqual(result.issues[0].raw, [{ connectionSessionId: session, sequence: 0, lastSequence: 2, byteStart: 0, byteEnd: 1 }]);
  assert.equal(result.gaps[0].cause, 'parse-limit'); assert.ok(isTelemetryDerivation(result));
});

test('configured device wrap, repeated time and reset are explicit distinct from host receive time', () => {
  const profile = input('jsonl'); profile.deviceClock = { source: 't', unit: 'ms', wrapAt: 256 };
  const records = [250, 2, 2, 100, 4].map((time, sequence) => record(JSON.stringify({ range: sequence, t: time }) + '\n', sequence, sequence * 10));
  const result = parse(records, createParserProfile(profile));
  assert.deepEqual(result.samples.map(sample => sample.deviceTimeMs), [250, 258, 258, 356, 4]);
  assert.deepEqual(result.samples.map(sample => sample.deviceEpoch), [0, 0, 0, 0, 1]);
  assert.deepEqual(result.issues.map(issue => issue.code), ['clock-wrap', 'clock-repeat', 'clock-reset']);
  assert.equal(queryTelemetry(result, { channelIds: ['range'], timeBasis: 'device', deviceEpoch: 1, start: 0, end: 10, limit: 10 }).totalSamples, 1);
  assert.throws(() => queryTelemetry(result, { channelIds: ['range'], timeBasis: 'device', start: 0, end: 500, limit: 10 }), /epoch/);
});

test('gaps prevent cross-boundary fragments, preserve unknown lost counts and increment device epochs', () => {
  const gap: RawGap = { cause: 'upload', connectionSessionId: session, startElapsedNs: '10000000', endElapsedNs: '19000000', lostBytes: null };
  const result = parse([record('range:1', 0, 0), record('range:2\n', 0, 20, '77777777-7777-4777-8777-777777777777')], createParserProfile(input()), [gap]);
  assert.deepEqual(result.samples.map(sample => sample.value), [2]); assert.equal(result.gaps.find(item => item.cause === 'upload')?.lostBytes, null);
  assert.equal(result.issues[0].code, 'incomplete-frame'); assert.equal(result.samples[0].deviceEpoch, 1);
});

test('offline derivation interleaves gaps exactly like live parsing, retaining clock epochs, loss counts and raw spans', () => {
  const profile = input('jsonl'); profile.deviceClock = { source: 't', unit: 'ms', wrapAt: 256 };
  const selected = createParserProfile(profile), secondSession = '77777777-7777-4777-8777-777777777777', thirdSession = '88888888-8888-4888-8888-888888888888';
  const records = [record('{"range":1,"t":250}\n{"range":', 0, 0), record('{"range":2,"t":2}\n', 0, 10, secondSession), record('{"range":3,"t":2}\n', 1, 11, secondSession), record('{"range":4,"t":255}\n', 0, 21, thirdSession), record('{"range":5,"t":1}\n', 1, 22, thirdSession)];
  const gaps: RawGap[] = [
    { cause: 'upload', connectionSessionId: session, startElapsedNs: '5000000', endElapsedNs: '9000000', lostBytes: null },
    { cause: 'disconnect', connectionSessionId: secondSession, startElapsedNs: '12000000', endElapsedNs: '20000000', lostBytes: 7 },
    { cause: 'cancelled', connectionSessionId: thirdSession, startElapsedNs: '23000000', endElapsedNs: '24000000', lostBytes: null }
  ];
  const live = new StreamingTelemetryParser(selected);
  const batches = [live.push(records[0]), live.gap(gaps[0]), live.push(records[1]), live.push(records[2]), live.gap(gaps[1]), live.push(records[3]), live.push(records[4]), live.gap(gaps[2]), live.finish()];
  const replay = parse(records, selected, gaps);
  assert.deepEqual(replay.samples, batches.flatMap(batch => batch.samples));
  assert.deepEqual(replay.issues, batches.flatMap(batch => batch.issues));
  assert.deepEqual(replay.gaps, batches.flatMap(batch => batch.gaps));
  assert.deepEqual(replay.samples.map(sample => sample.deviceEpoch), [0, 1, 1, 2, 2]);
  assert.deepEqual(replay.samples.map(sample => sample.deviceTimeMs), [250, 2, 2, 255, 257]);
  assert.deepEqual(replay.samples.map(sample => sample.value), [1, 2, 3, 4, 5]);
  assert.deepEqual(replay.gaps.filter(gap => ['upload', 'disconnect', 'cancelled'].includes(gap.cause)).map(gap => gap.lostBytes), [null, 7, null]);
  assert.deepEqual(replay.issues.map(issue => issue.code), ['incomplete-frame', 'clock-repeat', 'clock-wrap']);
});

test('unannounced sequence and monotonic-clock regressions disclose anomalies; wall-clock changes do not alter intervals', () => {
  const first = record('range:1\n', 0, 10), next = record('range:2\n', 2, 20); next.hostReceivedAt = '2020-01-01T00:00:00.000Z';
  const last = record('range:3\n', 3, 5), result = parse([first, next, last]);
  assert.deepEqual(result.samples.map(sample => sample.hostReceiveMs), [10, 20, 5]);
  assert.ok(result.issues.some(issue => issue.code === 'sequence-gap')); assert.ok(result.issues.some(issue => issue.code === 'host-clock-reset'));
  assert.ok(queryTelemetry(result, { channelIds: ['range'], timeBasis: 'host-receive', start: 0, end: 8, limit: 10 }).issues.some(issue => issue.code === 'host-clock-reset'));
});

test('exact derivation identity, version/hash/raw integrity and frozen selection are enforced', () => {
  const records = [record('range:1\n')], result = parse(records), again = parse(records);
  assert.equal(result.derivationId, again.derivationId); assert.match(result.derivationId, /^[a-f0-9-]{36}$/);
  assert.equal(result.derivationSha256, again.derivationSha256); assert.notEqual(parse([record('range:2\n')]).derivationId, result.derivationId);
  assert.throws(() => deriveTelemetry(records, [], result.profile, { recordingId, rawSha256: '0'.repeat(64), segmentSha256s: [] }), /digest/);
  const selection = { schemaVersion: 1, recordingId, derivationId: result.derivationId, parserVersion: 'telemetry-v1', configurationSha256: result.configurationSha256, projectRevision: 3, channelIds: ['range'], timeBasis: 'host-receive', start: 0, end: 5 };
  assert.ok(isRecordingSelection(selection)); assert.equal(isRecordingSelection({ ...selection, projectRevision: 0 }), false);
  assert.equal(isRecordingSelection({ ...selection, timeBasis: 'device' }), false);
  assert.equal(isTelemetryDerivation({ ...result, samples: [{ ...result.samples[0], value: Infinity }] }), false);
  assert.equal(isTelemetryDerivation({ ...result, samples: [{ ...result.samples[0], unit: 'V' }] }), false);
});

test('range statistics use every selected sample and preserve extrema when the plot is downsampled', () => {
  const records = Array.from({ length: 100 }, (_, sequence) => record('range:' + (sequence === 45 ? 999 : sequence === 55 ? -999 : sequence) + '\n', sequence, sequence));
  const result = parse(records), window = queryTelemetry(result, { channelIds: ['range'], timeBasis: 'host-receive', start: 0, end: 99, limit: 12 });
  assert.equal(window.totalSamples, 100); assert.equal(window.statistics[0].count, 100); assert.equal(window.statistics[0].min, -999); assert.equal(window.statistics[0].max, 999);
  assert.ok(Math.abs(window.statistics[0].mean! - 48.5) < 1e-10);
  assert.equal(window.downsampled, true); assert.ok(window.samples.length <= 12); assert.ok(window.samples.some(sample => sample.value === 999)); assert.ok(window.samples.some(sample => sample.value === -999));
  assert.equal(window.samples[0].value, 0); assert.equal(window.samples.at(-1)?.value, 99);
  const empty = queryTelemetry(result, { channelIds: ['range'], timeBasis: 'host-receive', start: 500, end: 501, limit: 2 });
  assert.deepEqual(empty.statistics[0], { channelId: 'range', unit: 'mm', count: 0, min: null, max: null, mean: null });
  assert.throws(() => queryTelemetry(result, { channelIds: ['unknown'], timeBasis: 'host-receive', start: 0, end: 1, limit: 10 }), /configured/);
  const extreme = parse([record('range:1e308\nrange:-1e308\n')]);
  assert.equal(queryTelemetry(extreme, { channelIds: ['range'], timeBasis: 'host-receive', start: 0, end: 0, limit: 10 }).statistics[0].mean, 0);
});

test('downsampling preserves discontinuity endpoints or refuses an inadequate display limit', () => {
  const records = Array.from({ length: 20 }, (_, sequence) => record('range:' + sequence + '\n', sequence, sequence));
  const result = parse(records), gaps = [{ cause: 'disconnect', connectionSessionId: session, startHostReceiveMs: 9.5, endHostReceiveMs: 9.5, lostBytes: null }];
  const samples = downsampleTelemetry(result.samples, 8, gaps);
  assert.ok(samples.some(sample => sample.value === 9)); assert.ok(samples.some(sample => sample.value === 10)); assert.ok(samples.length <= 8);
  assert.throws(() => downsampleTelemetry(result.samples, 4, gaps), /preserve/);
});

test('trust boundaries reject malformed raw bytes and gaps; finished parser cannot be reused', () => {
  const parser = new StreamingTelemetryParser(createParserProfile(input()));
  assert.throws(() => parser.push({ ...record('range:1\n'), bytesBase64: 'AB==' }), /canonical/);
  assert.throws(() => parser.push({ ...record('range:1\n'), sequence: -1 }), /Malformed/);
  assert.throws(() => parser.gap({ cause: 'overflow', connectionSessionId: session, startElapsedNs: '10', endElapsedNs: '9', lostBytes: null }), /Malformed/);
  parser.finish(); assert.throws(() => parser.push(record('range:2\n')), /finished/);
});
