import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { ProjectFiles } from '@robotics-workbench/application';
import { JobCoordinator, ProcessRunner } from '@robotics-workbench/application';
import { DeviceCoordinator } from '@robotics-workbench/devices';
import { WorkbenchStore } from '@robotics-workbench/persistence';
import { isProjectRequest, isProjectResponse, WorkbenchError, type ProjectResponse } from '@robotics-workbench/contracts';
import { recoverInterruptedCaptures } from './capture-recovery';

/** One trusted host binding; request UUIDs never grant a different project's scope. */
export class ProjectService {
  readonly files: ProjectFiles;
  readonly store: WorkbenchStore;
  readonly projectId: string;
  readonly jobs: JobCoordinator;
  readonly runner = new ProcessRunner();
  devices: DeviceCoordinator;
  hardware?: { summaries(inputHashes?: Map<string, string>): unknown[] };
  design?: { supports(method: string): boolean; handle(value: unknown): ProjectResponse };
  references?: { supports(method: string): boolean; handle(value: unknown): Promise<ProjectResponse> };
  telemetry?: { supports(method: string): boolean; handle(value: unknown): Promise<ProjectResponse> };
  private closed = false;
  private shuttingDown?: Promise<void>;

  constructor(projectRoot: string, dataRoot: string, devices?: DeviceCoordinator) {
    if (!isAbsolute(projectRoot) || !isAbsolute(dataRoot) || /^\\\\|^\/\//.test(dataRoot) || /^\\\\|^\/\//.test(projectRoot)) {
      throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Use absolute local project and data directories.');
    }
    const root = realpathSync(projectRoot);
    let ancestor = dataRoot;
    const missing: string[] = [];
    while (!existsSync(ancestor)) { missing.unshift(basename(ancestor)); ancestor = dirname(ancestor); }
    const canonicalDataRoot = join(realpathSync(ancestor), ...missing);
    const location = relative(root, canonicalDataRoot);
    if (!location || (!location.startsWith(`..${sep}`) && location !== '..' && !isAbsolute(location))) {
      throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Operational data must live outside the project.');
    }
    this.files = new ProjectFiles(root);
    const current = this.files.inspectManifest();
    this.projectId = current.manifest.projectId;
    this.store = new WorkbenchStore(canonicalDataRoot);
    try {
      this.store.registerProject({ projectId: this.projectId, root, projectRevision: current.manifest.projectRevision, manifestSha256: current.sha256 });
      this.jobs = new JobCoordinator(this.store);
      const dataFiles = new ProjectFiles(this.store.dataRoot), workRoot = dataFiles.resolvePath(`work/${this.projectId}`, true); mkdirSync(workRoot, { recursive: true });
      recoverInterruptedCaptures(this, workRoot);
      this.devices = devices ?? new DeviceCoordinator({ open: async () => { throw new WorkbenchError('TOOL_UNAVAILABLE', 'Serial transport is not enabled.'); } });
    } catch (error) { this.store.close(); throw error; }
  }

  handle(value: unknown, options: { inputHashes?: Map<string, string>; includeBuilds?: boolean } = {}): ProjectResponse {
    if (!isProjectRequest(value)) {
      throw new WorkbenchError('INVALID_REQUEST', 'Malformed, oversized or unsupported project request.');
    }
    try {
      if (value.projectId !== this.projectId) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'This connection belongs to a different project.');
      if (value.method === 'operation.get') {
        const result = typeof value.params.operationId === 'string'
          ? this.store.getOperation(this.projectId, value.params.operationId)
          : this.store.getOperationByRequest(this.projectId, String(value.params.requestId));
        return this.response(value.requestId, result);
      }
      if (value.method === 'operation.cancel') {
        const operationId = String(value.params.operationId);
        const admitted = this.store.admitCancellation(this.projectId, value.requestId, operationId, value);
        return this.response(value.requestId, admitted ? this.jobs.requestCancel(this.projectId, operationId) : this.store.getOperation(this.projectId, operationId));
      }
      if (value.method === 'device.status') return this.response(value.requestId, this.devices.status(typeof value.params.deviceId === 'string' ? value.params.deviceId : undefined));
      const current = this.files.inspectManifest();
      if (current.manifest.projectId !== this.projectId) throw new WorkbenchError('REVISION_CONFLICT', 'Project identity changed; reopen the project.');
      const previous = this.store.getProject(this.projectId);
      if (previous && previous.manifestSha256 !== current.sha256 && current.manifest.projectRevision <= previous.projectRevision) {
        throw new WorkbenchError('REVISION_CONFLICT', 'Manifest content changed without an accepted revision; reconcile the file.');
      }
      this.store.updateProject(this.projectId, current.manifest.projectRevision, current.sha256);
      let result: unknown;
      if (value.method === 'project.snapshot') {
        result = { manifest: current.manifest, manifestSha256: current.sha256, epoch: this.store.epoch,
          snapshotSequence: this.store.snapshotWatermark(), builds: options.includeBuilds === false ? [] : this.hardware?.summaries(options.inputHashes) ?? [] };
      } else if (value.method === 'component.inspect') {
        const component = current.manifest.components.find(item => item.componentId === value.params.componentId);
        if (!component) throw new WorkbenchError('NOT_FOUND', 'Component is unavailable in this project.');
        result = { projectRevision: current.manifest.projectRevision, component, codeBindings: current.manifest.codeBindings.filter(item => item.componentId === component.componentId), documents: current.manifest.documents.filter(item => item.componentIds?.includes(component.componentId)), unknowns: ['Definition facts and physical observations must be inspected separately.'] };
      } else if (value.method === 'connections.query') {
        const matches = current.manifest.nets.filter(net => value.params.netId ? net.netId === value.params.netId : net.members.some(member => member.componentId === value.params.componentId));
        let offset = 0;
        if (value.params.cursor) {
          const cursor = JSON.parse(Buffer.from(String(value.params.cursor), 'base64url').toString('utf8'));
          if (cursor.sha256 !== current.sha256 || cursor.componentId !== (value.params.componentId ?? null) || cursor.netId !== (value.params.netId ?? null) || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new WorkbenchError('REVISION_CONFLICT', 'Connection query changed; refresh the fixed snapshot.');
          offset = cursor.offset;
        }
        const items: typeof matches = []; let bytes = 0;
        while (offset < matches.length && items.length < Math.min(100, Number(value.params.limit ?? 100))) {
          const size = Buffer.byteLength(JSON.stringify(matches[offset])); if (size + bytes > 12000) break;
          items.push(matches[offset++]); bytes += size;
        }
        if (!items.length && offset < matches.length) throw new WorkbenchError('INVALID_REQUEST', 'A net exceeds the query preview bound; inspect its manifest.');
        result = { projectRevision: current.manifest.projectRevision, items, totalKnown: matches.length, truncated: offset < matches.length, nextCursor: offset < matches.length ? Buffer.from(JSON.stringify({ sha256: current.sha256, componentId: value.params.componentId ?? null, netId: value.params.netId ?? null, offset })).toString('base64url') : null, unknowns: ['These are intended connections, not measured continuity.'] };
      } else throw new WorkbenchError('UNKNOWN_METHOD', 'This operation is not enabled by the current task.');
      return this.response(value.requestId, result);
    } catch (error) {
      const known = error instanceof WorkbenchError ? error : new WorkbenchError('INTERNAL_ERROR', 'Project operation failed; inspect local storage and manifest.');
      return { schemaVersion: 1, requestId: value.requestId, error: { code: known.code, message: known.message, retryable: known.retryable } };
    }
  }

  attachDevices(devices: DeviceCoordinator): void {
    if (!this.jobs.isIdle || this.devices.status().length) throw new WorkbenchError('DEVICE_BUSY', 'Cannot replace an active device coordinator.');
    this.devices = devices;
  }

  private response(requestId: string, result: unknown): ProjectResponse {
    const response: ProjectResponse = { schemaVersion: 1, requestId, result };
    if (!isProjectResponse(response)) throw new WorkbenchError('INVALID_REQUEST', 'Result exceeds the control-message limit; inspect the local artifact or manifest.');
    return response;
  }

  close(): void {
    if (this.closed) return;
    if (!this.jobs.isIdle) throw new WorkbenchError('DEVICE_BUSY', 'Await operation shutdown before closing storage.');
    this.store.close();
    this.closed = true;
  }

  shutdown(): Promise<void> {
    this.shuttingDown ??= (async () => {
      const results = await Promise.allSettled([this.jobs.shutdown(), this.devices.shutdown(), this.runner.shutdown()]);
      if (results.some(result => result.status === 'rejected')) {
        throw new WorkbenchError('OUTCOME_UNKNOWN', 'Shutdown attempted every owned resource; some outcomes require reconciliation.');
      }
      this.close();
    })();
    return this.shuttingDown;
  }
}
