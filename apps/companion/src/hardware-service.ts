import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ArduinoAdapter, fingerprintTree, fingerprintTreeAsync, type CompileResult } from '@robotics-workbench/arduino';
import { NativeSerialTransport, RawRecorder, captureRaw, readRawWindow, type RawRecord, type RawGap, type RecordingResult } from '@robotics-workbench/serial';
import { canonicalTransportPath, DeviceCoordinator, type DeviceSnapshot, type SerialTransport } from '@robotics-workbench/devices';
import { ProjectFiles, type SourceSnapshot } from '@robotics-workbench/application';
import { canonicalJson, type ArtifactRecord } from '@robotics-workbench/persistence';
import { isProjectRequest, isProjectResponse, WorkbenchError, type OperationReceipt, type ProjectRequest, type ProjectResponse } from '@robotics-workbench/contracts';
import type { ProjectService } from './project-service';

type FileRef = { path: string; artifactId: string; sha256: string; sizeBytes: number };
type Prepared = { sourceSnapshotId: string; manifestSha256: string; sha256: string; projectRevision: number; targetId: string; sketchRelativePath: string; rootSketchName: string; files: FileRef[] };
export type BuildRecord = {
  buildId: string; operationId: string; sourceSnapshotId: string; targetId: string; projectRevision: number;
  fqbn: string; boardOptions: Record<string, string>; succeeded: boolean; inputFingerprint: string; sourceSha256: string;
  diagnostics: CompileResult['diagnostics']; libraryInputs: CompileResult['libraryInputs'];
  toolchain: CompileResult['toolchain']; buildProperties: CompileResult['buildProperties'];
  uploadArtifact?: ArtifactRecord; artifacts: ArtifactRecord[]; limitations: string[];
};
export type StoredRecording = Omit<RecordingResult, 'segments'> & { segments: (RecordingResult['segments'][number] & { artifactId: string })[] };
export type CaptureEvent = { recording: RecordingResult; operationId: string } & (
  { type: 'start' } | { type: 'finish' } | { type: 'record'; record: RawRecord } | { type: 'gap'; gap: RawGap }
);
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const artifactRef = ({ artifactId, sha256, mediaType, relativePath }: ArtifactRecord) => ({ artifactId, sha256, mediaType, relativePath });
const toolIdentity = ({ executablePath, executableSha256, version, cores, configuration, helpSha256 }: CompileResult['toolchain']) => canonicalJson({ executablePath, executableSha256, version, cores, configuration, helpSha256 });
type ArduinoPort = Pick<ArduinoAdapter, 'inspect' | 'discover' | 'compile' | 'upload' | 'assertCurrent'>;
const methods = new Set(['toolchain.inspect', 'device.discover', 'device.select', 'device.reconcile', 'project.prepareBuild', 'project.context', 'build.compile', 'build.diagnostics', 'firmware.upload', 'serial.capture', 'recording.query']);

type UploadAcknowledgement = { operationId: string; deviceId: string; observationId: string; acknowledged: true; firmwareState: 'unknown' };
type UploadReconciliation = { kind: 'upload-reconciliation'; operationId: string; deviceId: string; expectedDeviceObservationId: string; processTerminationConfirmed: true; note: string; basis: 'reported'; observedAt: string; result: UploadAcknowledgement };

/** Every effect is admitted through the existing job and device coordinators. */
export class HardwareService {
  private adapter?: ArduinoPort;
  get arduino(): ArduinoPort {
    if (!this.adapter) {
      if (!this.arduinoPath) throw new WorkbenchError('TOOL_UNAVAILABLE', 'Configure the installed Arduino CLI executable in machine settings.');
      this.adapter = new ArduinoAdapter(this.project.runner, this.arduinoPath, this.workRoot);
    }
    return this.adapter;
  }
  readonly devices: DeviceCoordinator;
  readonly workRoot: string;
  private readonly captures = new Map<string, RawRecorder>();
  private readonly captureOperationIds = new Map<string, string>();
  private readonly captureObserverOmissions = new Map<string, number>();
  private captureObserver?: (event: CaptureEvent) => void;
  private readonly lastDeviceStates = new Map<string, string>();

  constructor(readonly project: ProjectService, private readonly arduinoPath: string, nativeBindingPath?: string, testing?: { arduino?: ArduinoPort; transport?: SerialTransport }) {
    const data = new ProjectFiles(project.store.dataRoot);
    this.workRoot = data.resolvePath(`work/${project.projectId}`, true); mkdirSync(this.workRoot, { recursive: true });
    data.resolvePath(`work/${project.projectId}`);
    this.adapter = testing?.arduino;
    this.devices = new DeviceCoordinator(testing?.transport ?? new NativeSerialTransport(nativeBindingPath), { onState: snapshot => {
      if (this.lastDeviceStates.get(snapshot.observation.deviceId) === snapshot.state) return;
      this.lastDeviceStates.set(snapshot.observation.deviceId, snapshot.state);
      for (const recorder of this.captures.values()) if (recorder.snapshot().deviceId === snapshot.observation.deviceId) {
        if (snapshot.state === 'releasing-monitor') recorder.boundary('upload');
        else if (['disconnected', 'blocked', 'outcome-unknown'].includes(snapshot.state)) recorder.failCapture(new WorkbenchError('DEVICE_DISCONNECTED', 'Capture ended after the selected device became unavailable; retained bytes are partial evidence.'));
      }
    } });
    project.attachDevices(this.devices);
    project.hardware = this;
    for (const operation of this.unreconciledUploads()) {
      const observations = project.store.listRecords<{ snapshot?: DeviceSnapshot }>('observations', project.projectId);
      const prior = observations.map(item => item.snapshot).filter((item): item is DeviceSnapshot => !!item).find(item => item.observation.deviceId === operation.deviceId);
      if (prior) { this.devices.observe({ ...prior.observation, observationId: randomUUID(), connected: false, observedAt: new Date().toISOString() }); this.devices.markOutcomeUnknown(prior.observation.deviceId); }
    }
  }

  supports(method: string): boolean { return methods.has(method); }
  setCaptureObserver(observer?: (event: CaptureEvent) => void): void { this.captureObserver = observer; }
  liveRecordings(): { recording: RecordingResult; operationId: string; preview: ReturnType<RawRecorder['preview']> }[] {
    return [...this.captures.values()].map(recorder => {
      const preview = recorder.preview(); preview.omittedDisplayEvents += this.captureObserverOmissions.get(recorder.recordingId) ?? 0;
      return { recording: recorder.snapshot(), operationId: this.captureOperationIds.get(recorder.recordingId)!, preview };
    });
  }
  private observeCapture(event: CaptureEvent): void {
    const omitted = () => { if (this.captures.has(event.recording.recordingId)) this.captureObserverOmissions.set(event.recording.recordingId, (this.captureObserverOmissions.get(event.recording.recordingId) ?? 0) + 1); };
    try {
      const pending: unknown = this.captureObserver?.(structuredClone(event));
      if (pending instanceof Promise) void pending.catch(omitted);
    } catch { omitted(); }
  }

  async handle(value: unknown): Promise<ProjectResponse> {
    if (!isProjectRequest(value)) throw new WorkbenchError('INVALID_REQUEST', 'Malformed hardware request.');
    try {
      if (value.projectId !== this.project.projectId) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'This connection belongs to another project.');
      let result: unknown;
      switch (value.method) {
        case 'toolchain.inspect': result = await this.arduino.inspect(); break;
        case 'device.discover': result = { devices: await this.discover() }; break;
        case 'device.select': result = this.select(value); break;
        case 'device.reconcile': result = this.reconcile(value); break;
        case 'project.prepareBuild': result = await this.prepare(value); break;
        case 'project.context': result = await this.context(); break;
        case 'build.compile': result = this.compile(value); break;
        case 'build.diagnostics': result = await this.diagnostics(value); break;
        case 'firmware.upload': result = this.upload(value); break;
        case 'serial.capture': result = this.capture(value); break;
        case 'recording.query': result = this.recording(value); break;
        default: throw new WorkbenchError('UNKNOWN_METHOD', 'Unsupported hardware method.');
      }
      const response: ProjectResponse = { schemaVersion: 1, requestId: value.requestId, result };
      if (!isProjectResponse(response)) throw new WorkbenchError('INVALID_REQUEST', 'Result exceeds the control-message limit. Inspect retained artifacts.');
      return response;
    } catch (error) {
      const known = error instanceof WorkbenchError ? error : new WorkbenchError('INTERNAL_ERROR', 'Hardware operation could not be admitted; inspect tools and retained evidence.');
      return { schemaVersion: 1, requestId: value.requestId, error: { code: known.code, message: known.message.slice(0, 2048), retryable: false } };
    }
  }

  summaries(hashes = new Map<string, string>()): unknown[] {
    return this.project.store.listRecords<BuildRecord>('builds', this.project.projectId).slice(-100).map(build => ({ buildId: build.buildId, operationId: build.operationId, sourceSnapshotId: build.sourceSnapshotId, targetId: build.targetId, fqbn: build.fqbn, succeeded: build.succeeded, sourceCurrent: this.current(build, hashes), ...(build.uploadArtifact ? { uploadArtifact: artifactRef(build.uploadArtifact) } : {}) }));
  }

  async inputHashesAsync(builds = this.project.store.listRecords<BuildRecord>('builds', this.project.projectId).slice(-100), signal?: AbortSignal): Promise<Map<string, string>> {
    const hashes = new Map<string, string>();
    const projectRevision = this.project.files.inspectManifest().manifest.projectRevision;
    for (const path of new Set(builds.filter(build => build.projectRevision === projectRevision).flatMap(build => Array.isArray(build.libraryInputs) ? build.libraryInputs.map(input => input.path) : []))) {
      try { hashes.set(path, (await fingerprintTreeAsync(path, signal)).sha256); }
      catch (error) { if (signal?.aborted) throw error; hashes.set(path, ''); }
    }
    return hashes;
  }

  async currentAsync(build: BuildRecord, signal?: AbortSignal): Promise<boolean> { return this.current(build, await this.inputHashesAsync([build], signal)); }

  private manifest(revision?: number) {
    const current = this.project.files.inspectManifest();
    if (current.manifest.projectId !== this.project.projectId) throw new WorkbenchError('REVISION_CONFLICT', 'Project identity changed; reopen it.');
    const prior = this.project.store.getProject(this.project.projectId);
    if (prior.manifestSha256 !== current.sha256 && current.manifest.projectRevision <= prior.projectRevision) throw new WorkbenchError('REVISION_CONFLICT', 'Manifest content changed without an accepted revision.');
    this.project.store.updateProject(this.project.projectId, current.manifest.projectRevision, current.sha256);
    if (revision !== undefined && current.manifest.projectRevision !== revision) throw new WorkbenchError('REVISION_CONFLICT', 'Design intent changed; refresh and rebuild.');
    return current;
  }

  private async prepare(request: ProjectRequest) {
    if (!this.project.store.admitRequest(request.projectId, request.requestId, request)) {
      try {
        const prior = this.project.store.getRecord<Prepared>('source_snapshots', request.requestId, request.projectId);
        return { sourceSnapshotId: prior.sourceSnapshotId, manifestSha256: prior.manifestSha256 };
      } catch { throw new WorkbenchError('OUTCOME_UNKNOWN', 'Snapshot preparation was admitted but did not finish; inspect retained data and start a new request after reconciliation.'); }
    }
    const { manifest, sha256 } = this.manifest(request.expectedProjectRevision);
    const targetId = String(request.params.targetId), sketch = manifest.sketches.find(item => item.targetId === targetId);
    if (!sketch) throw new WorkbenchError('NOT_FOUND', 'Select a sketch and compiler target from the manifest.');
    const snapshot = this.project.files.snapshotSource({ paths: [sketch.path], host: () => ({ dirtyPaths: [] }) });
    for (const document of request.params.documentHashes as { path: string; sha256: string }[]) {
      const path = this.project.files.resolvePath(document.path);
      if (statSync(path).size > 64 * 1024 ** 2 || digest(readFileSync(path)) !== document.sha256) throw new WorkbenchError('REVISION_CONFLICT', 'A saved editor document changed externally; preserve and reconcile both versions.');
    }
    const files = snapshot.files.map(file => { const stored = this.project.store.storeArtifact(request.projectId, file.bytes, 'application/octet-stream'); return { path: file.path, artifactId: stored.artifactId, sha256: stored.sha256, sizeBytes: stored.sizeBytes }; });
    const record: Prepared = { sourceSnapshotId: request.requestId, manifestSha256: sha256, sha256: snapshot.sha256, projectRevision: manifest.projectRevision, targetId, sketchRelativePath: sketch.path, rootSketchName: basename(this.project.files.root), files };
    this.project.store.putRecord('source_snapshots', record.sourceSnapshotId, request.projectId, record);
    return { sourceSnapshotId: record.sourceSnapshotId, manifestSha256: sha256 };
  }

  private replay(request: ProjectRequest): OperationReceipt | undefined {
    try { const prior = this.project.store.getOperationByRequest(request.projectId, request.requestId); return this.project.store.createOperation({ ...prior, status: 'queued' }, request); }
    catch (error) { if (!(error instanceof WorkbenchError) || error.code !== 'NOT_FOUND') throw error; }
  }

  private source(id: string): SourceSnapshot {
    const record = this.project.store.getRecord<Prepared>('source_snapshots', id, this.project.projectId);
    return { sourceSnapshotId: id, sha256: record.sha256, libraries: [], files: record.files.map(file => ({ path: file.path, sha256: file.sha256, sizeBytes: file.sizeBytes, bytes: this.project.store.readArtifact(this.project.projectId, file.artifactId) })) };
  }

  private receipt(request: ProjectRequest, kind: OperationReceipt['kind'], extra: Partial<OperationReceipt> = {}): OperationReceipt {
    return { schemaVersion: 1, operationId: randomUUID(), requestId: request.requestId, projectId: request.projectId, kind, status: 'queued', expectedProjectRevision: request.expectedProjectRevision ?? this.manifest().manifest.projectRevision, createdAt: new Date().toISOString(), tool: { name: kind === 'serial-capture' ? 'serialport' : 'arduino-cli', version: kind === 'serial-capture' ? 'bindings-cpp-13.0.1' : '1.5.1' }, artifacts: [], ...extra };
  }

  private compile(request: ProjectRequest): OperationReceipt {
    const replay = this.replay(request); if (replay) return replay;
    const id = String(request.params.sourceSnapshotId), targetId = String(request.params.targetId);
    const prepared = this.project.store.getRecord<Prepared>('source_snapshots', id, request.projectId);
    const target = this.manifest(request.expectedProjectRevision).manifest.targets.find(item => item.targetId === targetId);
    if (!target || prepared.targetId !== targetId || prepared.projectRevision !== request.expectedProjectRevision) throw new WorkbenchError('INVALID_REQUEST', 'Snapshot belongs to another compiler target or revision.');
    const frozenTarget = structuredClone(target), buildId = randomUUID();
    return this.project.jobs.submit({ receipt: this.receipt(request, 'compile', { sourceSnapshotId: id }), payload: request,
      preflight: () => { this.manifest(request.expectedProjectRevision); this.source(id); },
      execute: async ({ signal, receipt }) => {
        const result = await this.arduino.compile({ snapshot: this.source(id), sketchRelativePath: prepared.sketchRelativePath, rootSketchName: prepared.rootSketchName, fqbn: frozenTarget.fqbn, boardOptions: frozenTarget.options, signal });
        const artifacts = result.outputs.map(output => {
          const bytes = readFileSync(output.path);
          if (digest(bytes) !== output.sha256) throw new WorkbenchError('ARTIFACT_MISMATCH', 'Compiler output changed before registration.');
          return this.project.store.storeArtifact(request.projectId, bytes, output.mediaType, receipt.operationId);
        });
        const uploadArtifact = result.uploadArtifact ? artifacts.find(item => item.sha256 === result.uploadArtifact!.sha256) : undefined;
        const logs = [result.process.stdoutPath, result.process.stderrPath].filter((path): path is string => !!path).map(path => this.project.store.storeArtifact(request.projectId, readFileSync(path), 'text/plain', receipt.operationId));
        const build: BuildRecord = { buildId, operationId: receipt.operationId, sourceSnapshotId: id, targetId, projectRevision: prepared.projectRevision, fqbn: frozenTarget.fqbn, boardOptions: frozenTarget.options, succeeded: result.succeeded, sourceSha256: prepared.sha256, inputFingerprint: result.inputFingerprint, diagnostics: result.diagnostics, libraryInputs: result.libraryInputs, toolchain: result.toolchain, buildProperties: result.buildProperties, artifacts: [...artifacts, ...logs], ...(uploadArtifact ? { uploadArtifact } : {}), limitations: result.limitations };
        this.project.store.putRecord('builds', buildId, request.projectId, build);
        const output = { artifacts: [...artifacts, ...logs].map(artifactRef), result: { buildId, sourceSnapshotId: id, succeeded: result.succeeded, ...(uploadArtifact ? { uploadArtifact: artifactRef(uploadArtifact) } : {}) } };
        if (!result.succeeded) {
          this.project.store.appendEvent(request.projectId, prepared.projectRevision, 'build.failed', { buildId }, receipt.operationId);
          throw new WorkbenchError('COMPILE_FAILED', `Compilation failed. Inspect diagnostics for build ${buildId}.`);
        }
        return output;
      } });
  }

  private build(id: string): BuildRecord { return this.project.store.getRecord('builds', id, this.project.projectId); }
  private async diagnostics(request: ProjectRequest) {
    const build = this.build(String(request.params.buildId)); let offset = 0;
    if (request.params.cursor) {
      try { const cursor = JSON.parse(Buffer.from(String(request.params.cursor), 'base64url').toString('utf8'));
        if (cursor.buildId !== build.buildId || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset >= build.diagnostics.length) throw Error(); offset = cursor.offset;
      } catch { throw new WorkbenchError('INVALID_REQUEST', 'Diagnostic cursor does not belong to this immutable build.'); }
    }
    const items: CompileResult['diagnostics'] = []; let bytes = 0;
    while (offset < build.diagnostics.length && items.length < Number(request.params.limit ?? 100)) {
      const item = build.diagnostics[offset], size = Buffer.byteLength(JSON.stringify(item));
      if (bytes + size > 24576) break; items.push(item); bytes += size; offset++;
    }
    if (!items.length && offset < build.diagnostics.length) throw new WorkbenchError('INVALID_REQUEST', 'Diagnostic exceeds the bounded preview; inspect retained compiler logs.');
    return { buildId: build.buildId, sourceSnapshotId: build.sourceSnapshotId, items, sourceCurrent: await this.currentAsync(build), nextCursor: offset < build.diagnostics.length ? Buffer.from(JSON.stringify({ buildId: build.buildId, offset })).toString('base64url') : null };
  }
  current(build: BuildRecord, hashes = new Map<string, string>()): boolean {
    try {
      const manifest = this.project.files.inspectManifest().manifest;
      const target = manifest.targets.find(item => item.targetId === build.targetId);
      if (manifest.projectRevision !== build.projectRevision || !target || target.fqbn !== build.fqbn || canonicalJson(target.options) !== canonicalJson(build.boardOptions)) return false;
      const prepared = this.project.store.getRecord<Prepared>('source_snapshots', build.sourceSnapshotId, this.project.projectId);
      if (this.project.files.snapshotSource({ paths: [prepared.sketchRelativePath], host: () => ({ dirtyPaths: [] }) }).sha256 !== build.sourceSha256) return false;
      return build.libraryInputs.every(input => { if (!hashes.has(input.path)) hashes.set(input.path, fingerprintTree(input.path).sha256); return hashes.get(input.path) === input.sha256; });
    } catch { return false; }
  }

  async discover(): Promise<DeviceSnapshot[]> {
    const ports = await this.arduino.discover(), old = this.devices.status(), found = new Set<string>();
    const history = this.project.store.listRecords<{ kind?: string; snapshot?: DeviceSnapshot }>('observations', this.project.projectId);
    for (const port of ports) {
      canonicalTransportPath(port.address);
      const serialNumber = port.properties.serialNumber ?? port.properties.serial_number;
      const identity = { ...(serialNumber ? { serialNumber } : {}), ...(port.properties.vid ? { vid: port.properties.vid } : {}), ...(port.properties.pid ? { pid: port.properties.pid } : {}) };
      const connected = old.find(item => item.observation.connected && canonicalTransportPath(item.observation.transportPath) === canonicalTransportPath(port.address) && canonicalJson(item.observation.identity ?? {}) === canonicalJson(identity));
      const unique = serialNumber && ports.filter(item => (item.properties.serialNumber ?? item.properties.serial_number) === serialNumber && item.properties.vid === identity.vid && item.properties.pid === identity.pid).length === 1;
      const prior = unique ? history.map(item => item.snapshot).filter((item): item is DeviceSnapshot => !!item).find(item => item.observation.identity?.serialNumber === serialNumber && item.observation.identity?.vid === identity.vid && item.observation.identity?.pid === identity.pid) : undefined;
      const deviceId = connected?.observation.deviceId ?? prior?.observation.deviceId ?? randomUUID();
      const status = unique ? 'identified' : serialNumber ? 'ambiguous' : connected?.observation.identityStatus ?? 'ambiguous';
      const same = connected && connected.observation.identityStatus === status;
      const observation = { deviceId, observationId: same ? connected.observation.observationId : randomUUID(), transportPath: port.address, observedAt: same ? connected.observation.observedAt : new Date().toISOString(), connected: true, identityStatus: status, identity } as const;
      this.devices.observe(observation); found.add(deviceId);
      if (this.unreconciledUploads(deviceId).length) this.devices.markOutcomeUnknown(deviceId);
      if (!same) this.project.store.putRecord('observations', observation.observationId, this.project.projectId, { kind: 'device-observation', snapshot: this.devices.status(deviceId)[0], matchingBoards: port.matchingBoards, basis: 'reported' });
    }
    for (const item of old) if (item.observation.connected && !found.has(item.observation.deviceId)) this.devices.observe({ ...item.observation, observationId: randomUUID(), observedAt: new Date().toISOString(), connected: false });
    return this.devices.status();
  }

  private unreconciledUploads(deviceId?: string): OperationReceipt[] {
    const acknowledgements = this.project.store.listRecords<UploadReconciliation>('observations', this.project.projectId).filter(item => item.kind === 'upload-reconciliation' && item.processTerminationConfirmed === true);
    return this.project.store.listOperations(this.project.projectId).filter(operation => operation.kind === 'upload' && operation.status === 'outcome-unknown' && operation.deviceId && (!deviceId || operation.deviceId === deviceId) && !acknowledgements.some(item => item.operationId === operation.operationId && item.deviceId === operation.deviceId));
  }

  private reconcile(request: ProjectRequest): UploadAcknowledgement {
    const { operationId, deviceId, expectedDeviceObservationId, processTerminationConfirmed, note } = request.params;
    if (processTerminationConfirmed !== true || typeof note !== 'string' || !note.trim() || note.length > 2048) throw new WorkbenchError('INVALID_REQUEST', 'Explicitly confirm the old process has stopped and record a bounded note; firmware remains unknown.');
    const admitted = this.project.store.admitRequest(request.projectId, request.requestId, request);
    if (!admitted) {
      try {
        const prior = this.project.store.getRecord<UploadReconciliation>('observations', request.requestId, request.projectId);
        if (prior.kind === 'upload-reconciliation') return prior.result;
      } catch {}
      throw new WorkbenchError('OUTCOME_UNKNOWN', 'Acknowledgement was admitted without a completed record. Inspect history before starting a new acknowledgement.');
    }
    this.manifest(request.expectedProjectRevision);
    const original = this.project.store.getOperation(request.projectId, String(operationId));
    if (original.kind !== 'upload' || original.status !== 'outcome-unknown' || original.deviceId !== deviceId) throw new WorkbenchError('INVALID_REQUEST', 'Choose the exact interrupted upload and its original device.');
    const snapshot = this.devices.status(String(deviceId))[0];
    if (!snapshot || !snapshot.observation.connected || snapshot.observation.identityStatus !== 'identified' || snapshot.observation.observationId !== expectedDeviceObservationId) throw new WorkbenchError('TARGET_AMBIGUOUS', 'Refresh and identify the connected original device before acknowledging its interrupted upload.');
    if (!this.project.jobs.isIdle || !this.project.runner.isIdle) throw new WorkbenchError('DEVICE_BUSY', 'Wait until all owned jobs and processes have stopped before acknowledging upload uncertainty.');
    const result: UploadAcknowledgement = { operationId: original.operationId, deviceId: String(deviceId), observationId: snapshot.observation.observationId, acknowledged: true, firmwareState: 'unknown' };
    // Release only after handle/process checks; a failed durable write restores the unknown reservation.
    this.devices.reconcile(String(deviceId), snapshot.observation.observationId);
    try {
      this.project.store.putRecord('observations', request.requestId, request.projectId, { kind: 'upload-reconciliation', operationId: original.operationId, deviceId: String(deviceId), expectedDeviceObservationId: String(expectedDeviceObservationId), processTerminationConfirmed: true, note: note.trim(), basis: 'reported', observedAt: new Date().toISOString(), result } satisfies UploadReconciliation);
      if (this.unreconciledUploads(String(deviceId)).length) this.devices.markOutcomeUnknown(String(deviceId));
    } catch (error) { this.devices.markOutcomeUnknown(String(deviceId)); throw error; }
    return result;
  }

  private select(request: ProjectRequest): DeviceSnapshot {
    const admitted = this.project.store.admitRequest(request.projectId, request.requestId, request);
    if (!admitted) return this.project.store.getRecord<{ snapshot: DeviceSnapshot }>('observations', request.requestId, request.projectId).snapshot;
    const item = this.devices.status(String(request.params.deviceId))[0];
    if (!item.observation.connected || item.observation.observationId !== request.params.expectedDeviceObservationId || item.state === 'outcome-unknown') throw new WorkbenchError('TARGET_AMBIGUOUS', 'Current target needs explicit identification or unknown-outcome reconciliation.');
    if (item.state === 'blocked' && (!this.project.jobs.isIdle || !this.project.runner.isIdle)) throw new WorkbenchError('DEVICE_BUSY', 'Wait for owned jobs and processes to stop before selecting a blocked target. External port ownership is checked on the next explicit capture or upload.');
    const observation = { ...item.observation, observationId: item.observation.identityStatus === 'identified' ? item.observation.observationId : randomUUID(), identityStatus: 'identified' as const };
    this.devices.observe(observation);
    if (item.state === 'blocked') this.devices.reconcile(observation.deviceId, observation.observationId);
    const snapshot = this.devices.status(observation.deviceId)[0];
    this.project.store.putRecord('observations', request.requestId, request.projectId, { kind: 'user-device-selection', basis: 'reported', snapshot });
    if (observation.observationId !== item.observation.observationId) {
      const prior = this.project.store.getRecord<{ matchingBoards?: { name: string; fqbn: string }[] }>('observations', item.observation.observationId, request.projectId);
      this.project.store.putRecord('observations', observation.observationId, request.projectId, { kind: 'device-observation', basis: 'reported', snapshot, matchingBoards: prior.matchingBoards ?? [] });
    }
    return snapshot;
  }

  private upload(request: ProjectRequest): OperationReceipt {
    const replay = this.replay(request); if (replay) return replay;
    const build = this.build(String(request.params.buildId));
    const validate = async () => {
      this.manifest(request.expectedProjectRevision);
      if (!build.succeeded || !build.uploadArtifact || build.uploadArtifact.artifactId !== request.params.artifactId || build.uploadArtifact.sha256 !== request.params.artifactSha256 || build.fqbn !== request.params.fqbn || !await this.currentAsync(build)) throw new WorkbenchError('ARTIFACT_MISMATCH', 'Select a current successful build and its exact artifact. Rebuild after any source/library/target change.');
      this.project.store.readArtifact(request.projectId, build.uploadArtifact.artifactId);
      await this.arduino.assertCurrent(build);
      await this.discover();
      const observed = this.devices.status(String(request.params.deviceId))[0];
      if (observed.observation.observationId !== request.params.expectedDeviceObservationId || observed.observation.identityStatus !== 'identified' || !observed.observation.connected || observed.state === 'outcome-unknown') throw new WorkbenchError('TARGET_AMBIGUOUS', 'Target connection changed; identify it again.');
      const evidence = this.project.store.getRecord<{ matchingBoards?: { fqbn: string }[] }>('observations', observed.observation.observationId, request.projectId);
      if (evidence.matchingBoards?.length && !evidence.matchingBoards.some(item => item.fqbn === build.fqbn)) throw new WorkbenchError('TARGET_AMBIGUOUS', 'Reported physical board candidates conflict with the compiled target.');
    };
    return this.project.jobs.submit({ receipt: this.receipt(request, 'upload', { sourceSnapshotId: build.sourceSnapshotId, deviceId: String(request.params.deviceId) }), payload: request, heavy: false, preflight: validate,
      execute: ({ signal, receipt }) => this.devices.withUpload({ deviceId: String(request.params.deviceId), expectedDeviceObservationId: String(request.params.expectedDeviceObservationId), resumeMonitoring: request.params.resumeMonitoring === true,
        validate: async () => { if (signal.aborted) throw new WorkbenchError('CANCELLED', 'Upload cancelled before external execution.'); await validate(); } }, async observation => {
          const bytes = this.project.store.readArtifact(request.projectId, build.uploadArtifact!.artifactId);
          const path = join(this.workRoot, `${receipt.operationId}.hex`); writeFileSync(path, bytes, { flag: 'wx' });
          const result = await this.arduino.upload({ artifactPath: path, artifactSha256: build.uploadArtifact!.sha256, fqbn: build.fqbn, boardOptions: build.boardOptions, port: observation.transportPath, signal, beforeExecute: async inspection => {
            const current = await this.currentAsync(build, signal);
            this.manifest(request.expectedProjectRevision);
            const observed = this.devices.status(observation.deviceId)[0];
            if (toolIdentity(inspection) !== toolIdentity(build.toolchain) || !current || observed.observation.observationId !== request.params.expectedDeviceObservationId || !observed.observation.connected || observed.observation.identityStatus !== 'identified') throw new WorkbenchError('REVISION_CONFLICT', 'Inputs or device changed immediately before uploader launch.');
          } });
          let logs: ArtifactRecord[];
          try {
            logs = ([[result.stdoutPath, result.stdout], [result.stderrPath, result.stderr]] as const).map(([path, fallback]) => this.project.store.storeArtifact(request.projectId, path ? readFileSync(path) : Buffer.from(fallback), 'text/plain', receipt.operationId));
            this.project.store.putRecord('observations', randomUUID(), request.projectId, { kind: 'uploader-result', operationId: receipt.operationId, process: result, artifacts: logs });
          } catch { throw new WorkbenchError('OUTCOME_UNKNOWN', 'Uploader ran but its evidence could not be persisted; inspect retained tool logs.'); }
          if (!result.terminationObserved || result.cancelled || result.timedOut) throw new WorkbenchError('OUTCOME_UNKNOWN', 'Uploader was interrupted; firmware outcome is unknown.');
          if (result.exitCode !== 0) throw new WorkbenchError('UPLOAD_FAILED', 'Uploader returned a definitive failure. Inspect retained logs; no automatic retry.');
          try {
            const uploadId = randomUUID();
            this.project.store.putRecord('uploads', uploadId, request.projectId, { uploadId, buildId: build.buildId, artifactId: build.uploadArtifact!.artifactId, artifactSha256: build.uploadArtifact!.sha256, deviceId: observation.deviceId, observation, operationId: receipt.operationId, fqbn: build.fqbn, boardOptions: build.boardOptions, uploadedAt: new Date().toISOString(), uploader: result });
            for (const recorder of this.captures.values()) if (recorder.snapshot().deviceId === observation.deviceId) this.project.store.putRecord('observations', randomUUID(), request.projectId, { kind: 'capture-firmware-transition', recordingId: recorder.recordingId, afterGapIndex: recorder.snapshot().gaps.length - 1, uploadReceiptId: receipt.operationId, firmwareSha256: build.uploadArtifact!.sha256, basis: 'uploader-reported-only' });
            return { artifacts: [build.uploadArtifact!, ...logs].map(artifactRef), result: { uploadId, buildId: build.buildId, artifactSha256: build.uploadArtifact!.sha256, deviceId: observation.deviceId, verification: 'uploader-reported-only' } };
          } catch { throw new WorkbenchError('OUTCOME_UNKNOWN', 'Uploader ended successfully but its durable receipt could not be finalized. Inspect retained evidence.'); }
        }) });
  }

  private capture(request: ProjectRequest): OperationReceipt {
    const replay = this.replay(request); if (replay) return replay;
    const observed = this.devices.status(String(request.params.deviceId))[0];
    if (!observed.observation.connected || observed.observation.identityStatus !== 'identified') throw new WorkbenchError('TARGET_AMBIGUOUS', 'Identify a connected device before capture.');
    return this.project.jobs.submit({ receipt: this.receipt(request, 'serial-capture', { deviceId: observed.observation.deviceId }), payload: request, heavy: false,
      execute: async ({ signal, receipt }) => {
        const uploads = this.project.store.listRecords<{ deviceId: string; operationId: string; artifactSha256: string }>('uploads', request.projectId).filter(item => item.deviceId === observed.observation.deviceId);
        const last = uploads.at(-1);
        const recorder = new RawRecorder(this.workRoot, { projectId: request.projectId, projectRevision: receipt.expectedProjectRevision, deviceId: observed.observation.deviceId, baudRate: Number(request.params.baudRate), uploadReceiptId: last?.operationId ?? null, firmwareSha256: last?.artifactSha256 ?? null,
          onRecord: record => this.observeCapture({ type: 'record', recording: recorder.snapshot(), operationId: receipt.operationId, record }),
          onGap: gap => this.observeCapture({ type: 'gap', recording: recorder.snapshot(), operationId: receipt.operationId, gap }) });
        this.project.store.putRecord('observations', recorder.recordingId, request.projectId, { kind: 'capture-intent', operationId: receipt.operationId, directory: recorder.directory, observation: observed.observation, recording: recorder.snapshot() });
        this.captures.set(recorder.recordingId, recorder);
        this.captureOperationIds.set(recorder.recordingId, receipt.operationId);
        this.observeCapture({ type: 'start', recording: recorder.snapshot(), operationId: receipt.operationId });
        let result: RecordingResult;
        let uncertain: unknown;
        try { result = await captureRaw(this.devices, { deviceId: observed.observation.deviceId, expectedDeviceObservationId: observed.observation.observationId, baudRate: Number(request.params.baudRate) }, recorder, { durationMs: Number(request.params.durationMs), signal }); }
        catch (error) { uncertain = error; result = recorder.finish('failed'); }
        finally { this.captures.delete(recorder.recordingId); this.captureOperationIds.delete(recorder.recordingId); this.captureObserverOmissions.delete(recorder.recordingId); }
        this.observeCapture({ type: 'finish', recording: result, operationId: receipt.operationId });
        const artifacts = result.segments.map(segment => this.project.store.storeArtifact(request.projectId, readFileSync(segment.path), 'application/x-ndjson', receipt.operationId));
        const stored: StoredRecording = { ...result, segments: result.segments.map((segment, index) => ({ ...segment, artifactId: artifacts[index].artifactId })) };
        this.project.store.putRecord('recordings', result.recordingId, request.projectId, stored);
        if (uncertain) throw uncertain;
        if (result.status === 'failed') throw new WorkbenchError('CAPTURE_FAILED', 'Capture stopped with incomplete evidence; retained raw segments and gaps remain inspectable.');
        return { artifacts: artifacts.map(artifactRef), result: { recordingId: result.recordingId, rawBytes: result.rawBytes, rawSha256: result.rawSha256, status: result.status } };
      } });
  }

  private recording(request: ProjectRequest) {
    const record = this.project.store.getRecord<StoredRecording>('recordings', String(request.params.recordingId), request.projectId);
    const range = request.params.range as { startMs: number; endMs: number; timeBasis: string };
    if (range.timeBasis !== 'host-receive' || (request.params.channelIds as string[] | undefined)?.length) throw new WorkbenchError('INVALID_REQUEST', 'Raw recordings support host-receive time and no parsed channels.');
    const binding = digest(canonicalJson({ recordingId: record.recordingId, range, channelIds: request.params.channelIds ?? [] }));
    let segmentIndex = 0, offset = 0, byteOffset = 0;
    if (request.params.cursor) {
      try {
        const cursor = JSON.parse(Buffer.from(String(request.params.cursor), 'base64url').toString('utf8'));
        if (cursor.binding !== binding || !Number.isSafeInteger(cursor.segment) || cursor.segment < 0 || cursor.segment >= record.segments.length || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || !Number.isSafeInteger(cursor.byteOffset) || cursor.byteOffset < 0 || cursor.byteOffset > 8192) throw Error();
        segmentIndex = cursor.segment; offset = cursor.offset; byteOffset = cursor.byteOffset;
      } catch { throw new WorkbenchError('INVALID_REQUEST', 'Recording cursor does not match this recording and interval.'); }
    }
    const chunks: Buffer[] = [];
    let retained = 0, scanned = 0, count = 0, nextCursor: string | null = null;
    const next = (segment: number, position: number, byteOffset = 0) => Buffer.from(JSON.stringify({ binding, segment, offset: position, byteOffset })).toString('base64url');
    for (; segmentIndex < record.segments.length && scanned < 500 && count < Number(request.params.limit ?? 100); segmentIndex++) {
      const segment = record.segments[segmentIndex];
      const artifact = this.project.store.getArtifact(request.projectId, segment.artifactId);
      this.project.store.readArtifact(request.projectId, artifact.artifactId);
      const path = join(this.project.store.dataRoot, artifact.relativePath);
      while (scanned < 500 && count < Number(request.params.limit ?? 100)) {
        const window = readRawWindow(path, { offset, limit: 1, maxBytes: 32768 });
        const item = window.records[0];
        if (!item) { if (byteOffset) throw new WorkbenchError('INVALID_REQUEST', 'Recording byte cursor is outside a raw frame.'); offset = 0; break; }
        scanned++;
        const time = Number(BigInt(item.hostElapsedNs)) / 1e6;
        if (time >= range.startMs && time <= range.endMs) {
          const bytes = Buffer.from(item.bytesBase64, 'base64');
          if (byteOffset >= bytes.length) throw new WorkbenchError('INVALID_REQUEST', 'Recording byte cursor is outside a raw frame.');
          const chunk = bytes.subarray(byteOffset, byteOffset + 4096 - retained);
          chunks.push(chunk); retained += chunk.length; count++;
          if (byteOffset + chunk.length < bytes.length) { nextCursor = next(segmentIndex, offset, byteOffset + chunk.length); break; }
        }
        byteOffset = 0;
        if (window.nextOffset === null) { offset = 0; break; }
        offset = window.nextOffset;
        if (retained >= 4096 || scanned >= 500 || count >= Number(request.params.limit ?? 100)) { nextCursor = next(segmentIndex, offset); break; }
      }
      if (nextCursor) break;
      if (segmentIndex + 1 < record.segments.length && (retained >= 4096 || scanned >= 500 || count >= Number(request.params.limit ?? 100))) { nextCursor = next(segmentIndex + 1, 0); break; }
    }
    const gaps = record.gaps.filter(item => Number(BigInt(item.startElapsedNs)) / 1e6 <= range.endMs && (item.endElapsedNs === null || Number(BigInt(item.endElapsedNs)) / 1e6 >= range.startMs));
    const bytes = Buffer.concat(chunks);
    return { text: bytes.toString('utf8'), bytesBase64: bytes.toString('base64'), gaps: gaps.slice(0, 16), omittedGaps: Math.max(0, gaps.length - 16), truncated: nextCursor !== null, nextCursor, recordingId: record.recordingId, parserVersion: record.parserVersion, timeBasis: 'host-receive', textQuality: 'page-preview; decode bytesBase64 across pages for continuous UTF-8' };
  }

  private async context() {
    const manifest = this.manifest().manifest;
    const context = { schemaVersion: 1, projectId: manifest.projectId, projectRevision: manifest.projectRevision, targets: manifest.targets, sketches: manifest.sketches, devices: this.devices.status().slice(-10), builds: this.summaries(await this.inputHashesAsync()).slice(-10), unknowns: ['Wiring and physical behavior require observations; upload success does not verify either.'], operations: this.project.store.listOperations(manifest.projectId).slice(-10), omitted: false };
    let text = JSON.stringify(context, null, 2);
    while (Buffer.byteLength(text) > 24576 && (context.operations.length || context.builds.length || context.devices.length)) {
      context.omitted = true;
      if (context.operations.length) context.operations.shift(); else if (context.builds.length) context.builds.shift(); else context.devices.shift();
      text = JSON.stringify(context, null, 2);
    }
    if (Buffer.byteLength(text) > 24576) throw new WorkbenchError('INVALID_REQUEST', 'Manifest context exceeds the bounded provider snapshot.');
    return { text, maxBytes: 24576 };
  }
}
