import { createHash } from 'node:crypto';
import { closeSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, realpathSync, statfsSync, statSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs';
import { release } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DIAGNOSTIC_BUNDLE_BYTES, DIAGNOSTIC_MEDIA_TYPE, DIAGNOSTIC_PRIVACY_NOTICE, diagnosticLogTypes, isDiagnosticBundle, isDiagnosticPreview, isProjectRequest, isProjectResponse, WorkbenchError, type DiagnosticBundleV1, type DiagnosticExportResultV1, type DiagnosticPreviewV1, type DiagnosticToolId, type OperationReceipt, type ProjectRequest, type ProjectResponse } from '@robotics-workbench/contracts';
import { checkArtifactCredentials } from '@robotics-workbench/persistence';
import { ProjectService } from './project-service';

type PreviewRecord = { kind: 'diagnostic-preview'; schemaVersion: 1; previewId: string; projectId: string; projectRevision: number; manifestSha256: string; bindingSha256: string; createdAt: string; artifactId: string; bundleSha256: string; byteLength: number };
type ExportRecord = { kind: 'diagnostic-export'; result: DiagnosticExportResultV1 };
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const methods = new Set(['diagnostics.preview', 'diagnostics.export']);
const inside = (root: string, child: string) => { const path = relative(root, child); return !path || !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`); };
const numericVersion = (value: unknown): string | null => typeof value === 'string' && value.length <= 256 ? value.match(/\b\d{1,6}(?:\.\d{1,6}){1,3}\b/)?.[0] ?? null : null;
const sameFile = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;

/** Host-only, explicit diagnostic export; private content is excluded rather than heuristically scrubbed. */
export class DiagnosticsService {
  constructor(private readonly project: ProjectService, private readonly app: { appVersion: string }) {}
  supports(method: string): boolean { return methods.has(method); }
  private bindingHash(): string { return hash(process.platform === 'win32' ? this.project.files.root.toLowerCase() : this.project.files.root); }
  private current(request: ProjectRequest) {
    if (request.projectId !== this.project.projectId) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'This diagnostic connection belongs to another project.');
    const snapshot = this.project.files.inspectManifest(), prior = this.project.store.getProject(request.projectId);
    if (snapshot.manifest.projectId !== request.projectId || snapshot.sha256 !== prior.manifestSha256 && snapshot.manifest.projectRevision <= prior.projectRevision || request.expectedProjectRevision !== undefined && snapshot.manifest.projectRevision !== request.expectedProjectRevision) throw new WorkbenchError('REVISION_CONFLICT', 'The saved project changed. Reconcile its manifest and create a fresh diagnostic preview.');
    this.project.store.updateProject(request.projectId, snapshot.manifest.projectRevision, snapshot.sha256);
    return snapshot;
  }

  private bundle(projectRevision: number): DiagnosticBundleV1 {
    const store = this.project.store, all = store.listOperations(this.project.projectId), operations = all.slice(-100).reverse();
    const snapshotSequence = store.snapshotWatermark(), afterSequence = Math.max(0, snapshotSequence - 100);
    const events = store.eventsSince(this.project.projectId, afterSequence, store.epoch, 100).events;
    const toolKinds: { toolId: DiagnosticToolId; kinds: OperationReceipt['kind'][] }[] = [{ toolId: 'arduino-cli', kinds: ['compile', 'upload'] }, { toolId: 'kicad-cli', kinds: ['kicad-export'] }, { toolId: 'cadquery', kinds: ['cad-generate'] }, { toolId: 'codex', kinds: [] }, { toolId: 'opencode', kinds: [] }];
    let freeBytes: string | null = null;
    try { const fs = statfsSync(store.dataRoot, { bigint: true }); freeBytes = (fs.bavail * fs.bsize).toString(); } catch { /* Unavailable free-space observation remains unknown. */ }
    const bundle: DiagnosticBundleV1 = {
      schemaVersion: 1, kind: 'workbench-diagnostics', privacy: 'default-private', observedAt: new Date().toISOString(),
      scope: { projectId: this.project.projectId, projectRevision, epoch: store.epoch, snapshotSequence },
      versions: { app: this.app.appVersion, companionNode: process.versions.node, sqlite: numericVersion(process.versions.sqlite), modulesAbi: process.versions.modules ?? null, platform: process.platform, arch: process.arch, osRelease: numericVersion(release()) },
      configuration: { dataRoot: 'external-local', companionRuntime: 'detected-local-node', telemetry: 'disabled', privatePayloadsIncluded: false },
      tools: toolKinds.map(({ toolId, kinds }) => {
        const observed = [...all].reverse().find(operation => kinds.includes(operation.kind) && numericVersion(operation.tool.version));
        return { toolId, version: observed ? numericVersion(observed.tool.version) : null, basis: observed ? 'retained-operation' : 'not-recorded', observedAt: observed?.finishedAt ?? observed?.createdAt ?? null, currentVerified: false };
      }),
      operations: operations.map(operation => ({ operationId: operation.operationId, kind: operation.kind, status: operation.status, createdAt: operation.createdAt, finishedAt: operation.finishedAt ?? null, artifactCount: operation.artifacts.length, errorPresent: !!operation.error })),
      logs: events.map(event => ({ sequence: event.sequence, type: diagnosticLogTypes.includes(event.type as typeof diagnosticLogTypes[number]) ? event.type as typeof diagnosticLogTypes[number] : 'other-redacted', occurredAt: event.occurredAt, operationId: event.operationId ?? null })),
      storage: { databaseBytes: statSync(store.databasePath).size, freeBytes, recoveryBasis: 'companion-startup-scan', quarantined: store.recovery.quarantined.length, missing: store.recovery.missing.length, corrupt: store.recovery.corrupt.length },
      omitted: { operations: Math.max(0, all.length - operations.length), olderLogWindow: afterSequence > 0 },
      notice: DIAGNOSTIC_PRIVACY_NOTICE
    };
    if (!isDiagnosticBundle(bundle)) throw new WorkbenchError('INVALID_REQUEST', 'Diagnostic metadata exceeds its bounded private format.');
    return bundle;
  }

  private retained(previewId: string): { record: PreviewRecord; preview: DiagnosticPreviewV1; bytes: Buffer } {
    const record = this.project.store.getRecord<PreviewRecord>('observations', previewId, this.project.projectId);
    if (record.kind !== 'diagnostic-preview' || record.schemaVersion !== 1 || record.previewId !== previewId || record.projectId !== this.project.projectId || record.bindingSha256 !== this.bindingHash()) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'The diagnostic preview does not belong to this project binding. Create a fresh preview.');
    const artifact = this.project.store.getArtifact(this.project.projectId, record.artifactId);
    if (artifact.mediaType !== DIAGNOSTIC_MEDIA_TYPE || artifact.sha256 !== record.bundleSha256 || artifact.sizeBytes !== record.byteLength || artifact.sizeBytes > DIAGNOSTIC_BUNDLE_BYTES) throw new WorkbenchError('ARTIFACT_MISMATCH', 'The retained artifact is not this diagnostic preview.');
    const bytes = this.project.store.readArtifact(this.project.projectId, artifact.artifactId);
    checkArtifactCredentials(bytes);
    const preview: DiagnosticPreviewV1 = { schemaVersion: 1, previewId, projectId: record.projectId, projectRevision: record.projectRevision, createdAt: record.createdAt, bundleSha256: artifact.sha256, byteLength: bytes.length, text: bytes.toString('utf8') };
    if (!bytes.equals(Buffer.from(preview.text)) || !isDiagnosticPreview(preview)) throw new WorkbenchError('INVALID_REQUEST', 'The retained diagnostic preview is not the validated private format.');
    return { record, preview, bytes };
  }

  private preview(request: ProjectRequest): DiagnosticPreviewV1 {
    const store = this.project.store;
    if (!store.admitRequest(request.projectId, request.requestId, request)) return this.retained(request.requestId).preview;
    const snapshot = this.current(request), bundle = this.bundle(snapshot.manifest.projectRevision), bytes = Buffer.from(JSON.stringify(bundle, null, 2) + '\n');
    if (bytes.length > DIAGNOSTIC_BUNDLE_BYTES) throw new WorkbenchError('INVALID_REQUEST', 'Diagnostic metadata exceeds its byte budget.');
    const artifact = store.storeArtifact(request.projectId, bytes, DIAGNOSTIC_MEDIA_TYPE);
    const record: PreviewRecord = { kind: 'diagnostic-preview', schemaVersion: 1, previewId: request.requestId, projectId: request.projectId, projectRevision: snapshot.manifest.projectRevision, manifestSha256: snapshot.sha256, bindingSha256: this.bindingHash(), createdAt: bundle.observedAt, artifactId: artifact.artifactId, bundleSha256: artifact.sha256, byteLength: artifact.sizeBytes };
    store.putRecord('observations', request.requestId, request.projectId, record);
    return this.retained(request.requestId).preview;
  }

  private publish(destination: string, previewId: string, bytes: Buffer): string {
    if (!isAbsolute(destination) || /^\\\\|^\/\//.test(destination)) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Choose an absolute local diagnostic file destination.');
    const name = basename(destination);
    if (/[<>:"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Choose an ordinary diagnostic filename.');
    const selectedParent = dirname(resolve(destination)), parent = realpathSync(selectedParent), parentInfo = lstatSync(selectedParent, { bigint: true });
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Choose an existing ordinary local destination directory.');
    const target = join(parent, name);
    if ([this.project.files.root, this.project.store.dataRoot].some(root => inside(root, target))) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Export diagnostics outside the project and its operational storage.');
    const unchanged = () => { const info = lstatSync(selectedParent, { bigint: true }); if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(selectedParent) !== parent || !sameFile(info, parentInfo)) throw new WorkbenchError('REVISION_CONFLICT', 'The destination directory changed; no further publication was attempted.'); };
    const temporary = join(parent, `.workbench-diagnostics-${previewId}.tmp`);
    let fd: number | undefined, owned: BigIntStats | undefined, published = false;
    try {
      unchanged(); fd = openSync(temporary, 'wx', 0o600); owned = fstatSync(fd, { bigint: true });
      writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
      unchanged(); linkSync(temporary, target); published = true; unchanged();
      const check = openSync(target, 'r');
      try {
        if (!owned || lstatSync(target).isSymbolicLink() || !sameFile(fstatSync(check, { bigint: true }), owned)) throw new WorkbenchError('OUTCOME_UNKNOWN', 'The diagnostic destination changed after publication.');
        const readback = Buffer.alloc(bytes.length + 1); let read = 0;
        while (read < readback.length) { const size = readSync(check, readback, read, readback.length - read, read); if (!size) break; read += size; }
        if (read !== bytes.length || !readback.subarray(0, read).equals(bytes)) throw new WorkbenchError('OUTCOME_UNKNOWN', 'The diagnostic destination changed after publication.');
      } finally { closeSync(check); }
      return target;
    } catch (error) {
      if (published) throw new WorkbenchError('OUTCOME_UNKNOWN', 'Diagnostic publication may have completed. Inspect the selected destination before a new explicit export.');
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new WorkbenchError('REVISION_CONFLICT', 'A destination or retained staging file already exists; choose a new diagnostic filename.');
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { if (owned && sameFile(lstatSync(temporary, { bigint: true }), owned)) unlinkSync(temporary); } catch { /* Retain a moved/unavailable staging file rather than touch an unrelated path. */ }
    }
  }

  private export(request: ProjectRequest): DiagnosticExportResultV1 {
    const store = this.project.store;
    if (!store.admitRequest(request.projectId, request.requestId, request)) {
      let prior: ExportRecord;
      try { prior = store.getRecord<ExportRecord>('observations', request.requestId, request.projectId); }
      catch { throw new WorkbenchError('OUTCOME_UNKNOWN', 'The prior diagnostic export has no completed result. Inspect its selected destination; it was not replayed.'); }
      if (prior.kind !== 'diagnostic-export') throw new WorkbenchError('OUTCOME_UNKNOWN', 'The prior diagnostic export has no completed result. Inspect its selected destination; it was not replayed.');
      return prior.result;
    }
    const snapshot = this.current(request), retained = this.retained(String(request.params.previewId));
    if (retained.record.projectRevision !== snapshot.manifest.projectRevision || retained.record.manifestSha256 !== snapshot.sha256 || retained.record.bundleSha256 !== request.params.expectedBundleSha256) throw new WorkbenchError('REVISION_CONFLICT', 'The diagnostic preview or saved project changed. Review a fresh preview before export.');
    const destination = this.publish(String(request.params.destination), retained.preview.previewId, retained.bytes);
    const result: DiagnosticExportResultV1 = { previewId: retained.preview.previewId, bundleSha256: retained.preview.bundleSha256, byteLength: retained.bytes.length, destination };
    try { store.putRecord('observations', request.requestId, request.projectId, { kind: 'diagnostic-export', result } satisfies ExportRecord); }
    catch { throw new WorkbenchError('OUTCOME_UNKNOWN', 'The diagnostic file was published but its result could not be retained. Inspect the destination before a new explicit export.'); }
    return result;
  }

  handle(value: unknown): ProjectResponse {
    if (!isProjectRequest(value) || !this.supports(value.method)) throw new WorkbenchError('INVALID_REQUEST', 'Malformed or unsupported diagnostic request.');
    try {
      if (value.projectId !== this.project.projectId) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'This diagnostic connection belongs to another project.');
      const result = value.method === 'diagnostics.preview' ? this.preview(value) : this.export(value);
      const response: ProjectResponse = { schemaVersion: 1, requestId: value.requestId, result };
      if (!isProjectResponse(response)) throw new WorkbenchError('INVALID_REQUEST', 'Diagnostic result exceeds the control boundary.');
      return response;
    } catch (error) {
      const known = error instanceof WorkbenchError ? error : new WorkbenchError('DIAGNOSTIC_UNAVAILABLE', 'Diagnostic preview or export did not complete. Existing project and evidence files were preserved; inspect local storage before retrying.');
      return { schemaVersion: 1, requestId: value.requestId, error: { code: known.code, message: known.message.slice(0, 2048), retryable: false } };
    }
  }
}
