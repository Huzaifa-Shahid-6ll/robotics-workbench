import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, freemem, platform, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { RawRecorder } from '../../packages/adapters/serial/src/recorder';

async function main() {
const durationMs = Number(process.argv[2] ?? 1800000);
assert.ok(Number.isSafeInteger(durationMs) && durationMs >= 1000 && durationMs <= 1800000);
const runId = randomUUID(), directory = resolve('verification/evidence/task-11/performance', runId);
mkdirSync(directory, { recursive: true });
const rawRoot = resolve('artifacts/task11-performance', runId); mkdirSync(rawRoot, { recursive: true });
const options = { projectId: randomUUID(), projectRevision: 1, deviceId: randomUUID() };
const startedAt = new Date().toISOString(), started = performance.now();
const recorder = new RawRecorder(rawRoot, options), expected = createHash('sha256');
const samples: { elapsedMs: number; rssBytes: number; previewBytes: number; rows: number }[] = [];
let rawBytes = 0, chunks = 0;
while (performance.now() - started < durationMs) {
  const bytes = Buffer.from(`counter:${chunks++}\n`.repeat(80));
  assert.equal(recorder.receive(bytes), true); expected.update(bytes); rawBytes += bytes.length;
  const preview = recorder.preview();
  assert.ok(Buffer.byteLength(preview.text) <= 16384 && preview.text.split('\n').length <= 10000);
  if (!samples.length || performance.now() - started - samples.at(-1)!.elapsedMs >= 10000) {
    samples.push({ elapsedMs: performance.now() - started, rssBytes: process.memoryUsage.rss(), previewBytes: Buffer.byteLength(preview.text), rows: preview.text.split('\n').length });
    writeFileSync(join(directory, 'progress.json'), JSON.stringify({ runId, startedAt, durationMs, elapsedMs: performance.now() - started, rawBytes, samples: samples.length }));
  }
  await new Promise(resolve => setTimeout(resolve, 100));
}
const recording = recorder.finish();
assert.equal(recording.rawBytes, rawBytes); assert.equal(recording.rawSha256, expected.digest('hex'));
for (const segment of recording.segments) {
  const bytes = readFileSync(segment.path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), segment.sha256);
}
const overload = new RawRecorder(rawRoot, { ...options, limits: { acquisitionBytes: 4 } });
assert.equal(overload.receive(Buffer.from('kept')), true);
assert.equal(overload.receive(Buffer.from('lost overflow')), false);
const partial = overload.finish(); assert.equal(partial.status, 'failed');
assert.ok(partial.gaps.some(gap => gap.cause === 'overflow' && gap.lostBytes === 13));
assert.equal(partial.rawBytes, 4);
const warm = samples.filter(s => s.elapsedMs >= 60000);
const midpoint = Math.floor(warm.length / 2);
const earlyMax = Math.max(0, ...warm.slice(0, midpoint).map(s => s.rssBytes));
const lateMax = Math.max(0, ...warm.slice(midpoint).map(s => s.rssBytes));
const record = { schemaVersion: 1, runId, testId: 'performance.sustained-raw-display', appVersion: '0.1.0', startedAt, endedAt: new Date().toISOString(), result: 'passed', evidenceClass: 'synthetic-stream-actual-wall-time',
  environment: { platform: platform(), os: release(), node: process.version, cpu: cpus()[0]?.model, totalMemoryBytes: totalmem(), freeMemoryBytes: freemem() },
  workload: { requestedDurationMs: durationMs, actualDurationMs: performance.now() - started, chunks, rawBytes, rowsPerChunk: 80, intervalMs: 100, displayMaximumBytes: 16384, displayMaximumRows: 10000, fullDuration: durationMs === 1800000 },
  samples, observedWarmRssGrowthBytes: warm.length > 2 ? lateMax - earlyMax : null,
  recording, overload: partial,
  limitations: ['Synthetic input on this actual machine; no USB, sensor or calibration proof.', 'Measures the real raw recorder and display preview process only; VS Code/rendered plot/provider/optional worker memory require separate measurements.', 'Short runs are self-checks and cannot pass the thirty-minute release gate. Raw artifacts remain under artifacts/task11-performance; full raw digest and segment hashes identify their bytes.'] };
writeFileSync(join(directory, 'result.json'), JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify({ runId, report: join(directory, 'result.json'), fullDuration: record.workload.fullDuration, rawBytes }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
