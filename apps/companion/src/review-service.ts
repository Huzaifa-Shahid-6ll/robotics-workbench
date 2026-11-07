import { randomUUID, createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { isProjectRequest, isReviewSnapshot, WorkbenchError, type ProjectResponse } from '@robotics-workbench/contracts';
import type { ProjectService } from './project-service';

type ReviewIndex = { kind: 'task-review'; taskId: string; artifactId: string };
/** Immutable content artifacts plus an append-only operational index; source stays authoritative. */
export class ReviewService {
  constructor(private readonly project: ProjectService) {}
  handle(value: unknown): ProjectResponse {
    if (!isProjectRequest(value) || value.projectId !== this.project.projectId) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Review belongs to a different project.');
    const taskId = String(value.params.taskId);
    if (value.method === 'artifact.preview') {
      const bytes = this.project.store.readArtifact(value.projectId, String(value.params.artifactId));
      const prefix = bytes.subarray(0, 65536);
      if (prefix.includes(0)) throw new WorkbenchError('CAPABILITY_UNSUPPORTED', 'Binary artifact preview is unavailable; inspect its typed source/export.');
      return { schemaVersion: 1, requestId: value.requestId, result: { text: prefix.toString('utf8'), truncated: bytes.length > prefix.length, totalBytes: bytes.length } };
    }
    if (value.method === 'review.relocation') {
      const latest = this.project.store.listRecords<ReviewIndex>('sessions', value.projectId).filter(item => item.kind === 'task-review' && item.taskId === taskId).at(-1);
      if (!latest) return { schemaVersion: 1, requestId: value.requestId, result: null };
      const bytes = this.project.store.readArtifact(value.projectId, latest.artifactId);
      const snapshot: unknown = JSON.parse(bytes.toString('utf8'));
      if (!isReviewSnapshot(snapshot) || snapshot.taskId !== taskId) throw new WorkbenchError('ARTIFACT_MISMATCH', 'Retained review has an invalid task identity.');
      type Restore = { kind: string; previousRoot: string; root: string; archiveManifestSha256: string; sourceSha256: string; restoredAt: string };
      const origins = this.project.store.listRecords<Restore>('observations', value.projectId).filter(item => item?.kind === 'project-restore');
      const backward: Restore[] = [], seen = new Set([this.project.files.root.toLowerCase()]);
      let root = this.project.files.root, index = origins.length - 1, matched = 0;
      if (snapshot.root.toLowerCase() === root.toLowerCase()) return { schemaVersion: 1, requestId: value.requestId, result: null };
      for (;;) {
        while (index >= 0 && (typeof origins[index].root !== 'string' || origins[index].root.toLowerCase() !== root.toLowerCase())) index--;
        if (index < 0) break;
        if (backward.length >= 100) throw new WorkbenchError('REVISION_CONFLICT', 'Restore ancestry exceeds 100 hops; retained review remains unchanged.');
        const proof = origins[index--];
        if (!isAbsolute(proof.previousRoot ?? '') || !isAbsolute(proof.root) || ![proof.archiveManifestSha256, proof.sourceSha256].every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)) || !Number.isFinite(Date.parse(proof.restoredAt))) throw new WorkbenchError('ARTIFACT_MISMATCH', 'A restore-origin record is malformed; retained review remains unchanged.');
        if (seen.has(proof.previousRoot.toLowerCase())) throw new WorkbenchError('REVISION_CONFLICT', 'Restore ancestry repeats a project root; retained review remains unchanged.');
        seen.add(proof.previousRoot.toLowerCase()); backward.push(proof); root = proof.previousRoot;
        if (!matched && root.toLowerCase() === snapshot.root.toLowerCase()) matched = backward.length;
      }
      const chain = backward.slice(0, matched).reverse().map(({ kind, ...proof }) => proof), proof = backward[0];
      return { schemaVersion: 1, requestId: value.requestId, result: matched ? { previousRoot: snapshot.root, root: this.project.files.root, archiveManifestSha256: proof.archiveManifestSha256, sourceSha256: proof.sourceSha256, restoredAt: proof.restoredAt, reviewArtifactId: latest.artifactId, reviewSha256: createHash('sha256').update(bytes).digest('hex'), ...(chain.length > 1 ? { restorationChain: chain } : {}) } : null };
    }
    if (value.method === 'review.save') {
      const snapshot = value.params.snapshot as Record<string, unknown>;
      const bytes = Buffer.from(JSON.stringify(snapshot));
      if (!isReviewSnapshot(snapshot) || snapshot.taskId !== taskId || snapshot.root !== this.project.files.root) throw new WorkbenchError('INVALID_REQUEST', 'Review snapshot has an invalid shape, identity/root or exceeds 512 KiB.');
      const ids = new Set<string>(), paths = new Set<string>();
      for (const file of snapshot.files) {
        if (ids.has(file.id) || paths.has(file.path.toLowerCase()) || /[\\:\x00-\x1f]/.test(file.path) || file.path.startsWith('/') || file.path.split('/').some(part => !part || part === '..' || part === '.' || /^(?:\.git|\.codex|\.opencode|node_modules|\.env(?:\..*)?)$/i.test(part))) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Review file identity or portable path is invalid.');
        ids.add(file.id); paths.add(file.path.toLowerCase());
        for (const [text, sha] of [[file.baselineText, file.baselineSha256], [file.observedText, file.observedSha256]] as const) {
          if (text === undefined && sha !== undefined || text === null && sha !== null || typeof text === 'string' && (Buffer.byteLength(text) > 131072 || createHash('sha256').update(text).digest('hex') !== sha)) throw new WorkbenchError('ARTIFACT_MISMATCH', 'Review text does not match its recorded identity.');
        }
      }
      const artifact = this.project.store.storeArtifact(value.projectId, bytes, 'application/json');
      this.project.store.putRecord('sessions', randomUUID(), value.projectId, { kind: 'task-review', taskId, artifactId: artifact.artifactId });
      return { schemaVersion: 1, requestId: value.requestId, result: { artifactId: artifact.artifactId, sha256: artifact.sha256 } };
    }
    if (value.method !== 'review.load') throw new WorkbenchError('UNKNOWN_METHOD', 'Unsupported review method.');
    const records = this.project.store.listRecords<ReviewIndex>('sessions', value.projectId).filter(item => item.kind === 'task-review' && item.taskId === taskId);
    const latest = records.at(-1);
    return { schemaVersion: 1, requestId: value.requestId, result: latest ? JSON.parse(this.project.store.readArtifact(value.projectId, latest.artifactId).toString('utf8')) : null };
  }
}
