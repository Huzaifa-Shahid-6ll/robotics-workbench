import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { isRequestId, isTelemetryHash, isTelemetryDerivation, WorkbenchError, type HashedParserProfile, type TelemetryDerivation } from '@robotics-workbench/contracts';
import { createParserProfile, type RawGap } from '@robotics-workbench/serial';
import type { WorkbenchStore } from '@robotics-workbench/persistence';
import type { StoredRecording } from './hardware-service';

export const TELEMETRY_WORKER_LIMITS = Object.freeze({ inputBytes: 32 * 1024 * 1024, resultBytes: 64 * 1024 * 1024, timeoutMs: 30_000 });
export type TelemetryWorkerJob = {
  schemaVersion: 1; dataRoot: string; projectId: string; recordingId: string; rawSha256: string; rawBytes: number;
  status: StoredRecording['status']; profile: HashedParserProfile; gaps: RawGap[];
  segments: { path: string; sha256: string; sizeBytes: number; connectionSessionId: string; complete: boolean }[];
};
/** Test-only injection is never exposed by a renderer/agent request. */
export type TelemetryWorkerOptions = { workerPath?: string; timeoutMs?: number };

export async function deriveTelemetryInWorker(store: WorkbenchStore, recording: StoredRecording, profile: HashedParserProfile, signal?: AbortSignal, options: TelemetryWorkerOptions = {}): Promise<TelemetryDerivation> {
  if (signal?.aborted) throw new WorkbenchError('CANCELLED', 'Telemetry derivation cancelled; raw evidence was preserved.');
  if (!recording || !isRequestId(recording.projectId) || !isRequestId(recording.recordingId) || !isTelemetryHash(recording.rawSha256)
    || !Number.isSafeInteger(recording.rawBytes) || recording.rawBytes < 0 || !['completed', 'cancelled', 'failed', 'interrupted'].includes(recording.status) || !Array.isArray(recording.segments) || recording.segments.length > 4096
    || !Array.isArray(recording.gaps) || recording.gaps.length > 1000) throw new WorkbenchError('INVALID_REQUEST', 'Choose a finalized retained recording for derivation.');
  store.getProject(recording.projectId);
  const checkedProfile = createParserProfile(profile);
  let inputBytes = 0;
  const segments = recording.segments.map(segment => {
    const artifact = store.getArtifact(recording.projectId, segment.artifactId);
    if (artifact.sha256 !== segment.sha256 || artifact.sizeBytes !== segment.sizeBytes || artifact.relativePath !== `artifacts/${artifact.sha256}` || !isRequestId(segment.connectionSessionId) || typeof segment.complete !== 'boolean') throw new WorkbenchError('ARTIFACT_MISMATCH', 'Recording segment metadata differs from its retained artifact.');
    inputBytes += artifact.sizeBytes;
    return { path: join(store.dataRoot, artifact.relativePath), sha256: artifact.sha256, sizeBytes: artifact.sizeBytes, connectionSessionId: segment.connectionSessionId, complete: segment.complete };
  });
  if (inputBytes > TELEMETRY_WORKER_LIMITS.inputBytes) throw new WorkbenchError('TELEMETRY_LIMIT_EXCEEDED', 'This recording exceeds the initial 32 MiB derivation input limit; raw evidence was preserved.');
  const workerPath = options.workerPath ?? join(__dirname, 'telemetry-worker.cjs'), timeoutMs = options.timeoutMs ?? TELEMETRY_WORKER_LIMITS.timeoutMs;
  if (!isAbsolute(workerPath) || !existsSync(workerPath) || !lstatSync(workerPath).isFile() || lstatSync(workerPath).isSymbolicLink() || realpathSync(workerPath).toLowerCase() !== workerPath.toLowerCase()) throw new WorkbenchError('TOOL_UNAVAILABLE', 'The trusted bundled telemetry worker is unavailable.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TELEMETRY_WORKER_LIMITS.timeoutMs) throw new WorkbenchError('INVALID_REQUEST', 'Invalid bounded telemetry-worker deadline.');
  const job: TelemetryWorkerJob = { schemaVersion: 1, dataRoot: store.dataRoot, projectId: recording.projectId, recordingId: recording.recordingId, rawSha256: recording.rawSha256, rawBytes: recording.rawBytes, status: recording.status, profile: checkedProfile, gaps: structuredClone(recording.gaps), segments };
  return new Promise<TelemetryDerivation>((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: job, execArgv: [], stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 224, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 } });
    let settled = false;
    const finish = (value?: TelemetryDerivation, error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      void worker.terminate().then(() => error ? reject(error) : resolve(value!), () => reject(new WorkbenchError('OUTCOME_UNKNOWN', 'Telemetry worker termination was not observed; raw artifacts remain intact.')));
    };
    const abort = () => finish(undefined, new WorkbenchError('CANCELLED', 'Telemetry derivation cancelled; raw evidence was preserved.'));
    const timer = setTimeout(() => finish(undefined, new WorkbenchError('TELEMETRY_TIMEOUT', 'Telemetry derivation exceeded its deadline; raw evidence was preserved.')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    worker.stdout?.resume(); worker.stderr?.resume();
    worker.once('message', (message: { value?: TelemetryDerivation; error?: { code?: string; message?: string }; resultBytes?: number }) => {
      if (message?.error) return finish(undefined, new WorkbenchError(typeof message.error.code === 'string' ? message.error.code.slice(0, 128) : 'TELEMETRY_FAILED', String(message.error.message ?? 'Telemetry derivation failed.').slice(0, 1024)));
      if (!Number.isSafeInteger(message?.resultBytes) || message.resultBytes! < 1 || message.resultBytes! > TELEMETRY_WORKER_LIMITS.resultBytes || !isTelemetryDerivation(message?.value)
        || message.value.recordingId !== recording.recordingId || message.value.rawSha256 !== recording.rawSha256 || message.value.configurationSha256 !== checkedProfile.configurationSha256
        || message.value.segmentSha256s.length !== segments.length || message.value.segmentSha256s.some((hash, index) => hash !== segments[index].sha256)) return finish(undefined, new WorkbenchError('ARTIFACT_MISMATCH', 'Telemetry worker result does not match the retained recording/profile.'));
      finish(message.value);
    });
    worker.once('error', () => finish(undefined, new WorkbenchError('TELEMETRY_FAILED', 'Isolated telemetry processing failed or exceeded its memory bound; raw evidence was preserved.')));
    worker.once('exit', () => { if (!settled) finish(undefined, new WorkbenchError('TELEMETRY_FAILED', 'Telemetry worker exited without a complete derivation; raw evidence was preserved.')); });
  });
}
