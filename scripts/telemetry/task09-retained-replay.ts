import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createParserProfile, deriveTelemetry, queryTelemetry, type RawRecord, type RecordingResult } from '../../packages/adapters/serial/src/index';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const source = 'verification/evidence/task-04/hardware';
const recording = JSON.parse(readFileSync(`${source}/recordings.json`, 'utf8'))[0] as RecordingResult;
const records: RawRecord[] = [], hashes: string[] = [];
for (const [index, segment] of recording.segments.entries()) {
  const bytes = readFileSync(`${source}/raw-segment-${index + 1}.jsonl`);
  assert.equal(bytes.length, segment.sizeBytes); assert.equal(sha(bytes), segment.sha256);
  hashes.push(sha(bytes)); records.push(...bytes.toString('utf8').trim().split(/\r?\n/).map(line => JSON.parse(line) as RawRecord));
}
const before = sha(Buffer.concat(records.map(record => Buffer.from(record.bytesBase64, 'base64'))));
assert.equal(before, recording.rawSha256);
const profile = createParserProfile({ schemaVersion: 1, id: randomUUID(), parserVersion: 'telemetry-v1', mode: 'labeled-numeric', channels: [{ channelId: 'counter', label: 'Recorded probe counter (unit unspecified)', unit: null, source: 'counter' }] });
const identity = { recordingId: recording.recordingId, rawSha256: recording.rawSha256, segmentSha256s: hashes };
const parsed = deriveTelemetry(records, recording.gaps, profile, identity);
assert.deepEqual(deriveTelemetry(records, recording.gaps, profile, identity), parsed);
assert.ok(parsed.samples.length > 0);
assert.ok(parsed.gaps.some(gap => gap.cause === 'upload' && gap.lostBytes === null));
assert.ok(parsed.issues.some(issue => issue.code === 'invalid-frame'), 'Binary/startup text cannot become numeric measurements.');
const window = queryTelemetry(parsed, { channelIds: ['counter'], timeBasis: 'host-receive', start: 0, end: Math.max(...parsed.samples.map(sample => sample.hostReceiveMs)), limit: 500 });
assert.equal(window.statistics[0]!.count, parsed.samples.length); assert.equal(window.statistics[0]!.unit, null);
assert.equal(sha(Buffer.concat(records.map(record => Buffer.from(record.bytesBase64, 'base64')))), before);
const directory = `verification/evidence/task-09/retained-replay/${randomUUID()}`;
mkdirSync(directory, { recursive: true });
const report = { passed: true, evidenceClass: 'historical-real-capture-replay', sourceTask: 'TASK-04', sourceRecordingId: recording.recordingId, sourceSegmentSha256s: hashes, sourceRawSha256: recording.rawSha256, parserProfile: profile, derivationId: parsed.derivationId, derivationSha256: parsed.derivationSha256, sampleCount: parsed.samples.length, gaps: parsed.gaps, issues: parsed.issues, statistics: window.statistics, limitations: ['Read-only replay of previously observed dedicated Uno bytes; no new USB/port/upload operation was performed.', 'Counter unit remains explicitly unknown. Startup/binary bytes remain available and do not become numeric zero samples.', 'This is no new sensor, wiring, calibration, reset or physical behavior verification.'] };
writeFileSync(`${directory}/result.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: true, report: `${directory}/result.json`, sampleCount: parsed.samples.length }));
