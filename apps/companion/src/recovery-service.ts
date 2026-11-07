import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isProjectRequest, isProjectResponse, WorkbenchError, type ProjectRequest, type ProjectResponse } from '@robotics-workbench/contracts';
import { ProjectService } from './project-service';
import { exportProject, restoreProject } from './project-archive';

const methods = new Set(['recovery.inspect', 'project.export', 'project.restore']);
const notice = 'Retained operations and observations are historical evidence. Restoring files does not restore firmware, physical wiring or a current device connection.';
const inside = (root: string, child: string) => { const path = relative(resolve(root), resolve(child)); return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)); };

/** Trusted host routes only: archive paths are never supplied by provider tools or webviews. */
export class RecoveryService {
  constructor(private readonly project: ProjectService) {}
  supports(method: string): boolean { return methods.has(method); }

  private current(request: ProjectRequest) {
    if (request.projectId !== this.project.projectId) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'This recovery connection belongs to another project.');
    const snapshot = this.project.files.inspectManifest();
    if (snapshot.manifest.projectId !== request.projectId) throw new WorkbenchError('REVISION_CONFLICT', 'Project identity changed; reopen it before recovery.');
    const prior = this.project.store.getProject(request.projectId);
    if (snapshot.sha256 !== prior.manifestSha256 && snapshot.manifest.projectRevision <= prior.projectRevision) throw new WorkbenchError('REVISION_CONFLICT', 'Manifest changed without an accepted revision; preserve and reconcile the file.');
    if (request.expectedProjectRevision !== undefined && request.expectedProjectRevision !== snapshot.manifest.projectRevision) throw new WorkbenchError('REVISION_CONFLICT', 'Project changed; refresh before recovery.');
    this.project.store.updateProject(request.projectId, snapshot.manifest.projectRevision, snapshot.sha256);
    return snapshot;
  }

  private inspect(request: ProjectRequest, projectRevision: number, manifestNotice = '') {
    const store = this.project.store, snapshotSequence = store.snapshotWatermark();
    let offset = 0;
    if (request.params.cursor) {
      try {
        const cursor = JSON.parse(Buffer.from(String(request.params.cursor), 'base64url').toString('utf8'));
        if (cursor.epoch !== store.epoch || cursor.snapshotSequence !== snapshotSequence || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error();
        offset = cursor.offset;
      } catch { throw new WorkbenchError('REVISION_CONFLICT', 'Recovery history changed; refresh its first page.'); }
    }
    const all = store.listOperations(request.projectId).reverse();
    if (offset > all.length) throw new WorkbenchError('INVALID_REQUEST', 'Recovery cursor is outside this history.');
    const operations = [];
    let bytes = 0;
    while (offset < all.length && operations.length < Math.min(100, Number(request.params.limit ?? 100))) {
      const item = all[offset];
      const summary = { operationId: item.operationId, kind: item.kind, status: item.status, createdAt: item.createdAt,
        ...(item.finishedAt ? { finishedAt: item.finishedAt } : {}), artifactCount: item.artifacts.length,
        ...(item.error ? { error: { code: item.error.code.slice(0, 128), message: item.error.message.slice(0, 512) } } : {}) };
      const size = Buffer.byteLength(JSON.stringify(summary));
      if (size + bytes > 12 * 1024) break;
      operations.push(summary); bytes += size; offset++;
    }
    return { projectId: request.projectId, projectRevision, operations,
      nextCursor: offset < all.length ? Buffer.from(JSON.stringify({ epoch: store.epoch, snapshotSequence, offset })).toString('base64url') : null,
      storage: { quarantined: store.recovery.quarantined.length, missing: store.recovery.missing.length, corrupt: store.recovery.corrupt.length }, notice: manifestNotice + notice };
  }

  handle(value: unknown): ProjectResponse {
    if (!isProjectRequest(value) || !this.supports(value.method)) throw new WorkbenchError('INVALID_REQUEST', 'Malformed or unsupported recovery request.');
    try {
      if (value.projectId !== this.project.projectId) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'This recovery connection belongs to another project.');
      let result: unknown;
      if (value.method === 'recovery.inspect') {
        let revision = this.project.store.getProject(value.projectId).projectRevision, manifestNotice = '';
        try { revision = this.current(value).manifest.projectRevision; }
        catch { manifestNotice = 'The current manifest needs repair or reconciliation. Showing the last accepted project revision and retained receipts. '; }
        result = this.inspect(value, revision, manifestNotice);
      }
      else {
        const store = this.project.store;
        if (!store.admitRequest(value.projectId, value.requestId, value)) {
          try { result = store.getRecord<{ kind: string; result: unknown }>('observations', value.requestId, value.projectId).result; }
          catch { throw new WorkbenchError('OUTCOME_UNKNOWN', 'This recovery request was already admitted. Inspect retained directories before starting a new explicit request; it was not replayed.'); }
        } else {
          const snapshot = this.current(value);
          if (!this.project.jobs.isIdle) throw new WorkbenchError('DEVICE_BUSY', 'Finish or cancel current operations before export or restore.');
          if (value.method === 'project.export') {
            if (snapshot.sha256 !== value.params.expectedManifestSha256) throw new WorkbenchError('REVISION_CONFLICT', 'The saved manifest changed externally; reconcile both versions before export.');
            const documents = Object.entries(value.params.documentHashes as Record<string, string>);
            const saved = documents.length ? this.project.files.snapshotSource({ paths: documents.map(([path]) => path), host: () => ({ dirtyPaths: [] }) }) : null;
            for (const [path, digest] of documents) {
              if (saved?.files.find(file => file.path === path)?.sha256 !== digest) throw new WorkbenchError('REVISION_CONFLICT', 'A saved editor document changed externally; reconcile both versions before export.');
            }
          } else {
            for (const destination of [String(value.params.newProjectRoot), String(value.params.newDataRoot)]) {
              for (const retained of [this.project.files.root, this.project.store.dataRoot]) if (inside(retained, destination) || inside(destination, retained)) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Restore to independent directories outside the open project and its operational storage.');
            }
          }
          if (value.method === 'project.export') {
            const archive = exportProject(this.project.files, store, String(value.params.destination), () => ({ dirtyPaths: [] }));
            result = { archiveDirectory: String(value.params.destination), projectId: archive.projectId, projectRevision: archive.projectRevision,
              sourceSnapshotId: archive.sourceSnapshotId, sourceSha256: archive.sourceSha256, snapshotSequence: archive.snapshotSequence, fileCount: archive.files.length, notice };
          } else {
            const restored = restoreProject(String(value.params.archiveDirectory), String(value.params.newProjectRoot), String(value.params.newDataRoot));
            try { result = { projectId: restored.files.inspectManifest().manifest.projectId, projectRevision: restored.files.inspectManifest().manifest.projectRevision,
              newProjectRoot: restored.files.root, newDataRoot: restored.store.dataRoot, notice }; }
            finally { restored.store.close(); }
          }
          store.putRecord('observations', value.requestId, value.projectId, { kind: value.method, result });
        }
      }
      const response: ProjectResponse = { schemaVersion: 1, requestId: value.requestId, result };
      if (!isProjectResponse(response)) throw new WorkbenchError('INVALID_REQUEST', 'Recovery result exceeds the control boundary.');
      return response;
    } catch (error) {
      const known = error instanceof WorkbenchError ? error : new WorkbenchError('RECOVERY_UNAVAILABLE', 'Recovery failed. Existing project, evidence and retained archive files were preserved; inspect local storage before retrying.');
      return { schemaVersion: 1, requestId: value.requestId, error: { code: known.code, message: known.message.slice(0, 4096), retryable: false } };
    }
  }
}
