import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { isRequestId, isTelemetryHash, WorkbenchError } from '@robotics-workbench/contracts';
import { createParserProfile, deriveTelemetry, type RawRecord } from '@robotics-workbench/serial';
import type { TelemetryWorkerJob } from './derive-telemetry';

const INPUT_LIMIT = 32 * 1024 * 1024, RESULT_LIMIT = 64 * 1024 * 1024;
function failure(code: string, message: string): never { throw new WorkbenchError(code, message); }
function run() {
  const job = workerData as TelemetryWorkerJob;
  if (!job || job.schemaVersion !== 1 || !isRequestId(job.projectId) || !isRequestId(job.recordingId) || !isTelemetryHash(job.rawSha256)
    || !Number.isSafeInteger(job.rawBytes) || job.rawBytes < 0 || !['completed', 'cancelled', 'failed', 'interrupted'].includes(job.status) || !isAbsolute(job.dataRoot) || !Array.isArray(job.segments) || job.segments.length > 4096 || !Array.isArray(job.gaps) || job.gaps.length > 1000) return failure('INVALID_REQUEST', 'Invalid bounded telemetry-worker job.');
  const root = realpathSync(job.dataRoot);
  if (root.toLowerCase() !== job.dataRoot.toLowerCase()) return failure('UNAUTHORIZED_SCOPE', 'Telemetry input must use the canonical data root.');
  const artifacts = join(root, 'artifacts');
  if (lstatSync(root).isSymbolicLink() || lstatSync(artifacts).isSymbolicLink() || realpathSync(artifacts).toLowerCase() !== artifacts.toLowerCase()) return failure('UNAUTHORIZED_SCOPE', 'Telemetry input cannot traverse links or junctions.');
  let inputBytes = 0, rawBytes = 0, lastReceiveMs = 0, incompleteTail = false;
  function* records(): Generator<RawRecord> {
    for (const segment of job.segments) {
      if (!isTelemetryHash(segment.sha256) || !isRequestId(segment.connectionSessionId) || !Number.isSafeInteger(segment.sizeBytes) || segment.sizeBytes < 0 || typeof segment.complete !== 'boolean' || !isAbsolute(segment.path)
        || segment.path.toLowerCase() !== join(artifacts, segment.sha256).toLowerCase()) return failure('UNAUTHORIZED_SCOPE', 'Telemetry segment must identify its canonical retained artifact.');
      const path = realpathSync(segment.path), inside = relative(root, path), info = lstatSync(segment.path);
      if (isAbsolute(inside) || inside.startsWith('..') || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || path.toLowerCase() !== segment.path.toLowerCase()) return failure('UNAUTHORIZED_SCOPE', 'Telemetry segment cannot leave its data root or use a shared/link file.');
      inputBytes += info.size;
      if (inputBytes > INPUT_LIMIT || info.size !== segment.sizeBytes) return failure('TELEMETRY_LIMIT_EXCEEDED', 'Telemetry raw input exceeds its size bound or changed size.');
      const fd = openSync(path, 'r');
      let bytes: Buffer;
      try {
        const opened = fstatSync(fd);
        if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== info.size || opened.nlink !== 1) return failure('ARTIFACT_MISMATCH', 'Telemetry segment changed while opening.');
        bytes = readFileSync(fd);
        const after = fstatSync(fd);
        if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) return failure('ARTIFACT_MISMATCH', 'Telemetry segment changed while reading.');
      } finally { closeSync(fd); }
      if (bytes.length !== segment.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== segment.sha256) return failure('ARTIFACT_MISMATCH', 'Telemetry raw segment failed SHA-256 verification.');
      let position = 0;
      while (position < bytes.length) {
        const newline = bytes.indexOf(10, position);
        if (newline < 0 && job.status !== 'completed' && segment.complete === false && segment === job.segments.at(-1)) { incompleteTail = true; break; }
        if (newline < 0 || newline - position > 1024 * 1024 || newline === position) return failure('INVALID_REQUEST', 'Telemetry raw segment has an incomplete, empty or oversized JSON record; recover it explicitly first.');
        let record: RawRecord;
        try { record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(position, newline))) as RawRecord; }
        catch { return failure('INVALID_REQUEST', 'Telemetry raw segment contains malformed JSON/UTF-8.'); }
        if (!record || record.recordingId !== job.recordingId || record.connectionSessionId !== segment.connectionSessionId) return failure('ARTIFACT_MISMATCH', 'Telemetry raw record identity differs from its recording/session.');
        rawBytes += Buffer.from(record.bytesBase64 ?? '', 'base64').length;
        yield record; lastReceiveMs = Number(BigInt(record.hostElapsedNs) / 1000n) / 1000; position = newline + 1;
      }
    }
  }
  const value = deriveTelemetry(records(), job.gaps, createParserProfile(job.profile), { recordingId: job.recordingId, rawSha256: job.rawSha256, segmentSha256s: job.segments.map(segment => segment.sha256) });
  if (rawBytes !== job.rawBytes) return failure('ARTIFACT_MISMATCH', 'Decoded telemetry byte count differs from its recording.');
  if (incompleteTail) value.issues.push({ code: 'incomplete-frame', message: 'Incomplete final raw JSON record retained unchanged; only LF-terminated records were analyzed. Issue is located at the last complete receive time; tail timing and byte/sample loss are unknown.', hostReceiveMs: lastReceiveMs, raw: [] });
  const resultBytes = Buffer.byteLength(JSON.stringify(value));
  if (resultBytes > RESULT_LIMIT) return failure('TELEMETRY_LIMIT_EXCEEDED', 'Parsed telemetry exceeds the initial 64 MiB result bound; raw evidence was preserved.');
  return { value, resultBytes };
}
try { parentPort?.postMessage(run()); }
catch (error) { parentPort?.postMessage({ error: { code: error instanceof WorkbenchError ? error.code : 'TELEMETRY_FAILED', message: error instanceof WorkbenchError ? error.message.slice(0, 1024) : 'Telemetry worker could not read/derive the retained recording; raw evidence was preserved.' } }); }
