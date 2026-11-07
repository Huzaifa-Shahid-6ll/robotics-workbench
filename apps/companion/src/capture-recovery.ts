import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { relative } from 'node:path';
import { ProjectFiles } from '@robotics-workbench/application';
import { isRequestId, WorkbenchError } from '@robotics-workbench/contracts';
import { readRawWindow, recoverRawSegment, type RawGap, type RecordingResult } from '@robotics-workbench/serial';
import type { ProjectService } from './project-service';
import type { StoredRecording } from './hardware-service';

type CaptureIntent = { kind: 'capture-intent'; operationId: string; directory: string; recording: RecordingResult };
const causes = new Set(['upload', 'disconnect', 'reconnect', 'overflow', 'disk-failure', 'cancelled', 'limit', 'service-restart']);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const invalid = (message: string): never => { throw new WorkbenchError('ARTIFACT_MISMATCH', message); };
function gaps(value: unknown): RawGap[] {
  if (!Array.isArray(value) || value.length > 999) return invalid('Interrupted capture has an invalid gap inventory.');
  for (const gap of value) if (!gap || !causes.has(gap.cause) || !isRequestId(gap.connectionSessionId) || typeof gap.startElapsedNs !== 'string' || !/^(0|[1-9][0-9]*)$/.test(gap.startElapsedNs) || gap.endElapsedNs !== null && (typeof gap.endElapsedNs !== 'string' || !/^(0|[1-9][0-9]*)$/.test(gap.endElapsedNs)) || gap.lostBytes !== null && (!Number.isSafeInteger(gap.lostBytes) || gap.lostBytes < 0)) return invalid('Interrupted capture has malformed gap metadata.');
  return value.map(gap => ({ cause: gap.cause, connectionSessionId: gap.connectionSessionId, startElapsedNs: gap.startElapsedNs, endElapsedNs: gap.endElapsedNs, lostBytes: gap.lostBytes }));
}

/** Retain verified prefixes after process loss; never reopen a port or promote a cancelled operation. */
export function recoverInterruptedCaptures(project: ProjectService, workRoot: string): void {
  for (const intent of project.store.listRecords<CaptureIntent>('observations', project.projectId).filter(item => item.kind === 'capture-intent')) {
    try {
      try { project.store.getRecord('recordings', intent.recording.recordingId, project.projectId); continue; }
      catch (error) { if (!(error instanceof WorkbenchError) || error.code !== 'NOT_FOUND') throw error; }
      const operation = project.store.getOperation(project.projectId, intent.operationId);
      if (operation.kind !== 'serial-capture' || !['cancelled', 'failed', 'outcome-unknown'].includes(operation.status)) continue;
      const base = intent.recording;
      if (!isRequestId(base.recordingId) || base.projectId !== project.projectId || !isRequestId(base.deviceId) || base.projectRevision !== operation.expectedProjectRevision || base.schemaVersion !== 1 || base.parserVersion !== 'raw-v1') invalid('Interrupted capture intent identity is inconsistent.');
      const scope = new ProjectFiles(workRoot), directory = scope.resolvePath(relative(workRoot, intent.directory).replaceAll('\\', '/'));
      const files = new ProjectFiles(directory), metadataPath = files.resolvePath('metadata.json');
      if (lstatSync(metadataPath).size > 1024 * 1024 || lstatSync(metadataPath).nlink !== 1) invalid('Interrupted capture metadata is not bounded ordinary data.');
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as RecordingResult;
      if (metadata.recordingId !== base.recordingId || metadata.projectId !== base.projectId || metadata.deviceId !== base.deviceId || metadata.projectRevision !== base.projectRevision) invalid('Interrupted capture metadata belongs to another acquisition.');
      const retainedGaps = gaps(metadata.gaps), names = readdirSync(directory).filter(name => /^[1-9][0-9]*\.(?:partial\.)?jsonl$/.test(name)).sort((a, b) => Number(a.split('.')[0]) - Number(b.split('.')[0]));
      if (names.length > 256 || new Set(names.map(name => name.split('.')[0])).size !== names.length) invalid('Interrupted capture segment inventory is ambiguous or exceeds its bound.');
      let rawBytes = 0, lastElapsedNs = '0', session: string = randomUUID();
      const rawHash = createHash('sha256'), sequences = new Map<string, number>(), segments: StoredRecording['segments'] = [], recoveredSources = [];
      for (const name of names) {
        const sourcePath = files.resolvePath(name), sourceInfo = lstatSync(sourcePath);
        if (!sourceInfo.isFile() || sourceInfo.nlink !== 1 || sourceInfo.size > 64 * 1024 * 1024) invalid('Interrupted capture segment is not bounded ordinary data.');
        const original = readFileSync(sourcePath), originalArtifact = project.store.storeArtifact(project.projectId, original, 'application/octet-stream', operation.operationId), recovered = recoverRawSegment(sourcePath);
        const tailArtifact = recovered.quarantinePath ? project.store.storeArtifact(project.projectId, readFileSync(recovered.quarantinePath), 'application/octet-stream', operation.operationId) : null;
        let offset: number | null = 0, segmentSession: string | undefined;
        do {
          const page = readRawWindow(recovered.recoveredPath, { offset, maxBytes: 32768, limit: 500 });
          for (const record of page.records) {
            if (record.recordingId !== base.recordingId || segmentSession && record.connectionSessionId !== segmentSession || record.sequence <= (sequences.get(record.connectionSessionId) ?? -1) || BigInt(record.hostElapsedNs) < BigInt(lastElapsedNs)) invalid('Interrupted capture raw records have inconsistent identity or ordering.');
            const bytes = Buffer.from(record.bytesBase64, 'base64'); rawBytes += bytes.length;
            if (rawBytes > 1024 * 1024 * 1024) invalid('Interrupted capture exceeds its one GiB acquisition bound.');
            rawHash.update(bytes); sequences.set(record.connectionSessionId, record.sequence); segmentSession = record.connectionSessionId; session = segmentSession; lastElapsedNs = record.hostElapsedNs;
          }
          offset = page.nextOffset;
        } while (offset !== null);
        const bytes = readFileSync(recovered.recoveredPath), artifact = project.store.storeArtifact(project.projectId, bytes, 'application/x-ndjson', operation.operationId);
        if (segmentSession) segments.push({ path: recovered.recoveredPath, artifactId: artifact.artifactId, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes, complete: true, connectionSessionId: segmentSession });
        recoveredSources.push({ sourcePath, sourceSha256: hash(original), originalArtifactId: originalArtifact.artifactId, recoveredArtifactId: artifact.artifactId, incompleteTailBytes: recovered.incompleteTailBytes, quarantinePath: recovered.quarantinePath, tailArtifactId: tailArtifact?.artifactId ?? null, tailSha256: tailArtifact?.sha256 ?? null });
      }
      const recording: StoredRecording = { ...base, status: 'interrupted', finishedAt: new Date().toISOString(), rawBytes, rawSha256: rawHash.digest('hex'), segments,
        gaps: [...retainedGaps, { cause: 'service-restart', connectionSessionId: session, startElapsedNs: lastElapsedNs, endElapsedNs: null, lostBytes: null }], error: { code: 'CAPTURE_INTERRUPTED', message: 'Companion process ended before finalization. Only verified complete raw records were recovered; lost tail bytes/samples remain unknown.' } };
      project.store.putRecord('recordings', recording.recordingId, project.projectId, recording);
      project.store.putRecord('observations', randomUUID(), project.projectId, { kind: 'capture-recovery', operationId: operation.operationId, recordingId: recording.recordingId, recoveredSources, noReplay: true });
    } catch (error) {
      project.store.appendEvent(project.projectId, project.store.getProject(project.projectId).projectRevision, 'recording.recovery-failed', { recordingId: intent.recording?.recordingId ?? null, code: error instanceof WorkbenchError ? error.code : 'CAPTURE_RECOVERY_FAILED', notice: 'Original staging bytes were preserved. Inspect the interrupted capture; no port was reopened.' });
    }
  }
}
