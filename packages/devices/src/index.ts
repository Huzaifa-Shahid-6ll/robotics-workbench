import { isRequestId, WorkbenchError } from '@robotics-workbench/contracts';

export type DeviceState = 'disconnected' | 'available' | 'monitoring' | 'releasing-monitor' | 'uploading' | 'reconnecting' | 'blocked' | 'outcome-unknown';
export type DeviceObservation = {
  deviceId: string; observationId: string; transportPath: string; observedAt: string;
  connected: boolean; identityStatus: 'identified' | 'ambiguous';
  identity?: { serialNumber?: string; vid?: string; pid?: string; pnpId?: string };
};
export type SerialOptions = { path: string; baudRate: number; dataBits: 8; stopBits: 1; parity: 'none' };
export interface SerialConnection {
  close(): Promise<void>;
  onData(listener: (bytes: Uint8Array) => void): () => void;
  onDisconnect(listener: (error?: Error) => void): () => void;
}
export interface SerialTransport { open(options: SerialOptions): Promise<SerialConnection> }
export type DeviceSnapshot = { observation: DeviceObservation; state: DeviceState; problem?: { code: string; message: string } };
export type MonitorRequest = { deviceId: string; expectedDeviceObservationId: string; baudRate: number };
export type UploadLeaseRequest = { deviceId: string; expectedDeviceObservationId: string; resumeMonitoring: boolean; validate: () => void | Promise<void> };
type Entry = DeviceSnapshot & {
  connection?: SerialConnection; opening?: Promise<void>; closing?: Promise<void>;
  disposeData?: () => void; disposeDisconnect?: () => void;
  subscribers: Set<(bytes: Uint8Array) => void>; baudRate?: number; desired: boolean; upload: boolean;
};

export function canonicalTransportPath(path: string): string {
  if (typeof path !== 'string' || !/^(?:\\\\\.\\)?COM[1-9][0-9]{0,5}$/i.test(path)) {
    throw new WorkbenchError('UNSUPPORTED_ENVIRONMENT', 'Select an observed local Windows COM port.');
  }
  return path.replace(/^\\\\\.\\/, '').toUpperCase();
}
function copyObservation(value: DeviceObservation): DeviceObservation {
  return { deviceId: value.deviceId, observationId: value.observationId, transportPath: value.transportPath,
    observedAt: value.observedAt, connected: value.connected, identityStatus: value.identityStatus,
    ...(value.identity ? { identity: { ...value.identity } } : {}) };
}
function assertObservation(value: DeviceObservation): void {
  if (!value || !isRequestId(value.deviceId) || !isRequestId(value.observationId) || typeof value.connected !== 'boolean'
    || !['identified', 'ambiguous'].includes(value.identityStatus) || typeof value.observedAt !== 'string'
    || !/^\d{4}-\d\d-\d\dT.*Z$/.test(value.observedAt) || !Number.isFinite(Date.parse(value.observedAt))
    || Object.keys(value).some(key => !['deviceId', 'observationId', 'transportPath', 'observedAt', 'connected', 'identityStatus', 'identity'].includes(key))) {
    throw new WorkbenchError('INVALID_REQUEST', 'Device observations require UUIDs, a UTC timestamp and explicit identity status.');
  }
  canonicalTransportPath(value.transportPath);
  if (value.identity && (typeof value.identity !== 'object' || Object.keys(value.identity).some(key => !['serialNumber', 'vid', 'pid', 'pnpId'].includes(key)) || Object.values(value.identity).some(item => typeof item !== 'string' || item.length > 512))) {
    throw new WorkbenchError('INVALID_REQUEST', 'Device identity evidence must contain bounded strings.');
  }
}

/** Serial handles and upload leases share one owner; the application owns job persistence and admission. */
export class DeviceCoordinator {
  private readonly entries = new Map<string, Entry>();
  private readonly owners = new Map<string, string>();
  private stopping = false;
  private readonly closeTimeoutMs: number;
  constructor(private readonly transport: SerialTransport, private readonly options: { closeTimeoutMs?: number; onState?: (snapshot: DeviceSnapshot) => void } = {}) {
    this.closeTimeoutMs = options.closeTimeoutMs ?? 5000;
    if (!Number.isSafeInteger(this.closeTimeoutMs) || this.closeTimeoutMs < 1 || this.closeTimeoutMs > 60000) throw new WorkbenchError('INVALID_REQUEST', 'Invalid serial-close deadline.');
  }

  observe(observation: DeviceObservation): void {
    assertObservation(observation);
    const existing = this.entries.get(observation.deviceId);
    if (!existing) {
      const state = !observation.connected ? 'disconnected' : observation.identityStatus === 'ambiguous' ? 'blocked' : 'available';
      const entry: Entry = { observation: copyObservation(observation), state, subscribers: new Set(), desired: false, upload: false };
      this.entries.set(observation.deviceId, entry); this.changed(entry); return;
    }
    const old = existing.observation;
    const identityChanged = (['serialNumber', 'vid', 'pid', 'pnpId'] as const).some(key => old.identity?.[key] !== observation.identity?.[key]);
    const transportChanged = canonicalTransportPath(old.transportPath) !== canonicalTransportPath(observation.transportPath);
    if (old.observationId === observation.observationId && (transportChanged || old.connected !== observation.connected || old.identityStatus !== observation.identityStatus || old.observedAt !== observation.observedAt || identityChanged)) {
      throw new WorkbenchError('INVALID_REQUEST', 'An observation identity cannot be reused for changed device facts.');
    }
    existing.observation = copyObservation(observation);
    if (existing.state === 'uploading' && (!observation.connected || observation.identityStatus === 'ambiguous' || transportChanged || identityChanged)) {
      this.set(existing, 'outcome-unknown', 'OUTCOME_UNKNOWN', 'Device identity changed during an external upload.');
    } else if (!observation.connected || observation.identityStatus === 'ambiguous' || transportChanged || identityChanged) {
      existing.desired = false;
      if (existing.connection || existing.opening) {
        this.set(existing, 'blocked', 'TARGET_AMBIGUOUS', 'Device facts changed; monitor closure and explicit selection are required.');
        void (existing.opening ?? Promise.resolve()).then(() => this.closeConnection(existing)).catch(() => {});
      } else if (!['blocked', 'outcome-unknown'].includes(existing.state)) this.set(existing, observation.connected ? 'blocked' : 'disconnected');
    } else if (!['blocked', 'outcome-unknown'].includes(existing.state) && !existing.connection && !existing.upload) this.set(existing, 'available');
    else this.changed(existing);
  }

  status(deviceId?: string): DeviceSnapshot[] {
    const entries = deviceId ? [this.entry(deviceId)] : [...this.entries.values()];
    return entries.map(entry => this.snapshot(entry));
  }

  async monitor(request: MonitorRequest, listener: (bytes: Uint8Array) => void): Promise<{ close(): Promise<void> }> {
    const entry = this.current(request.deviceId, request.expectedDeviceObservationId);
    if (this.stopping || entry.upload || ['blocked', 'outcome-unknown'].includes(entry.state)) throw new WorkbenchError('DEVICE_BUSY', 'Device is busy or requires reconciliation.');
    if (!Number.isSafeInteger(request.baudRate) || request.baudRate < 1 || request.baudRate > 4000000 || typeof listener !== 'function') throw new WorkbenchError('INVALID_REQUEST', 'Choose a valid explicit serial baud rate and subscriber.');
    if (entry.baudRate !== undefined && entry.baudRate !== request.baudRate && (entry.connection || entry.opening)) throw new WorkbenchError('DEVICE_BUSY', 'Active subscribers use a different baud rate.');
    const subscriber = (bytes: Uint8Array) => listener(bytes);
    entry.baudRate = request.baudRate; entry.desired = true; entry.subscribers.add(subscriber);
    try { await this.open(entry, request.expectedDeviceObservationId); }
    catch (error) { entry.subscribers.delete(subscriber); throw error; }
    let closed = false;
    return { close: async () => {
      if (closed) return; closed = true; entry.subscribers.delete(subscriber);
      if (!entry.subscribers.size) { entry.desired = false; if (!entry.upload) { await this.closeConnection(entry); if (!['blocked', 'outcome-unknown'].includes(entry.state)) this.set(entry, entry.observation.connected ? 'available' : 'disconnected'); } }
    } };
  }

  async stopMonitoring(deviceId: string): Promise<void> {
    const entry = this.entry(deviceId); entry.desired = false; entry.subscribers.clear();
    if (entry.upload) return;
    await entry.opening;
    await this.closeConnection(entry);
    if (!['blocked', 'outcome-unknown'].includes(entry.state)) this.set(entry, entry.observation.connected ? 'available' : 'disconnected');
  }

  async withUpload<T>(request: UploadLeaseRequest, execute: (observation: DeviceObservation) => Promise<T>): Promise<T> {
    const entry = this.current(request.deviceId, request.expectedDeviceObservationId);
    if (this.stopping || entry.upload || ['blocked', 'outcome-unknown'].includes(entry.state)) throw new WorkbenchError('DEVICE_BUSY', 'Device already has an upload lease or needs reconciliation.');
    if (typeof request.validate !== 'function' || typeof execute !== 'function' || typeof request.resumeMonitoring !== 'boolean') throw new WorkbenchError('INVALID_REQUEST', 'Upload requires explicit preflight and execution callbacks.');
    this.reserve(entry); entry.upload = true;
    let started = false;
    let releasedMonitor = false;
    try {
      await request.validate();
      this.current(request.deviceId, request.expectedDeviceObservationId);
      if (this.stopping || ['blocked', 'outcome-unknown'].includes(entry.state)) throw new WorkbenchError('DEVICE_BUSY', 'Upload admission changed during preflight.');
      await entry.opening;
      if (this.stopping || ['blocked', 'outcome-unknown'].includes(entry.state)) throw new WorkbenchError('DEVICE_BUSY', 'Upload admission changed before monitor release.');
      if (entry.connection) { this.set(entry, 'releasing-monitor'); await this.closeConnection(entry); releasedMonitor = true; }
      this.current(request.deviceId, request.expectedDeviceObservationId);
      await request.validate();
      this.current(request.deviceId, request.expectedDeviceObservationId);
      if (this.stopping || ['blocked', 'outcome-unknown'].includes(entry.state)) throw new WorkbenchError('DEVICE_BUSY', 'Upload admission changed before external execution.');
      this.reserve(entry); this.set(entry, 'uploading'); started = true;
      const result = await execute(copyObservation(entry.observation));
      if (entry.state === 'outcome-unknown') throw new WorkbenchError('OUTCOME_UNKNOWN', 'The original upload result requires explicit reconciliation.');
      this.set(entry, 'reconnecting');
      return result;
    } catch (error) {
      if (started && (entry.state === 'outcome-unknown' || !(error instanceof WorkbenchError) || ['OUTCOME_UNKNOWN', 'TIMEOUT'].includes(error.code))) this.set(entry, 'outcome-unknown', 'OUTCOME_UNKNOWN', 'Upload effects are uncertain; no automatic replay or monitor reopen.');
      else if (entry.state !== 'blocked') this.set(entry, entry.connection && entry.desired ? 'monitoring' : entry.observation.connected ? 'available' : 'disconnected');
      if (entry.state === 'outcome-unknown') throw new WorkbenchError('OUTCOME_UNKNOWN', 'Upload effects are uncertain; inspect retained adapter evidence before explicitly retrying.');
      throw error;
    } finally {
      entry.upload = false;
      if (entry.state !== 'outcome-unknown' && !entry.connection && !entry.closing) this.release(entry);
      if (entry.state === 'reconnecting' || ((started || releasedMonitor) && entry.state === 'available')) {
        if (request.resumeMonitoring && entry.desired && entry.subscribers.size) {
          try { this.current(request.deviceId, request.expectedDeviceObservationId); await this.open(entry, request.expectedDeviceObservationId); }
          catch { this.set(entry, 'blocked', 'DEVICE_BUSY', 'Upload ended; monitoring did not reconnect. Inspect the current device observation.'); }
        } else { entry.desired = false; this.set(entry, entry.observation.connected ? 'available' : 'disconnected'); }
      }
    }
  }

  markOutcomeUnknown(deviceId: string): void { const entry = this.entry(deviceId); this.reserve(entry); this.set(entry, 'outcome-unknown', 'OUTCOME_UNKNOWN', 'External effects require explicit reconciliation.'); }

  reconcile(deviceId: string, expectedDeviceObservationId: string): void {
    const entry = this.current(deviceId, expectedDeviceObservationId);
    if (entry.upload || entry.opening || entry.closing || entry.connection) throw new WorkbenchError('DEVICE_BUSY', 'Observe external process and serial-handle termination before reconciliation.');
    this.release(entry); this.set(entry, 'available');
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    const results = await Promise.allSettled([...this.entries.values()].map(async entry => {
      entry.desired = false; entry.subscribers.clear();
      if (entry.upload) { if (entry.state === 'uploading') this.markOutcomeUnknown(entry.observation.deviceId); else this.set(entry, 'blocked', 'DEVICE_BUSY', 'Coordinator is stopping before external upload execution.'); return; }
      try { await entry.opening; } catch (error) { if (entry.connection) throw error; }
      await this.closeConnection(entry);
    }));
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  private entry(deviceId: string): Entry {
    const entry = this.entries.get(deviceId);
    if (!entry) throw new WorkbenchError('NOT_FOUND', 'Device has no current observation.');
    return entry;
  }
  private current(deviceId: string, expected: string): Entry {
    const entry = this.entry(deviceId);
    if (entry.observation.observationId !== expected) throw new WorkbenchError('TARGET_AMBIGUOUS', 'Device observation changed; reselect the intended target.');
    if (!entry.observation.connected || entry.observation.identityStatus !== 'identified') throw new WorkbenchError('TARGET_AMBIGUOUS', 'Connected device identity is unresolved.');
    return entry;
  }
  private reserve(entry: Entry): void {
    const path = canonicalTransportPath(entry.observation.transportPath);
    const owner = this.owners.get(path);
    if (owner && owner !== entry.observation.deviceId) throw new WorkbenchError('DEVICE_BUSY', 'Another workbench device lease owns this serial port.');
    this.owners.set(path, entry.observation.deviceId);
  }
  private release(entry: Entry): void {
    for (const [path, owner] of this.owners) if (owner === entry.observation.deviceId) this.owners.delete(path);
  }
  private async open(entry: Entry, expected: string): Promise<void> {
    if (entry.connection) return;
    if (entry.opening) return entry.opening;
    this.reserve(entry);
    entry.opening = (async () => {
      try {
        const observation = copyObservation(this.current(entry.observation.deviceId, expected).observation);
        const connection = await this.transport.open({ path: canonicalTransportPath(observation.transportPath), baudRate: entry.baudRate!, dataBits: 8, stopBits: 1, parity: 'none' });
        entry.connection = connection;
        entry.disposeData = connection.onData(bytes => {
          for (const listener of [...entry.subscribers]) {
            try { listener(bytes.slice()); } catch { entry.subscribers.delete(listener); this.set(entry, 'blocked', 'INTERNAL_ERROR', 'A serial subscriber failed; inspect its capture result.'); }
          }
        });
        entry.disposeDisconnect = connection.onDisconnect(error => {
          entry.desired = false;
          const externalUploadStarted = entry.state === 'uploading';
          this.set(entry, externalUploadStarted ? 'outcome-unknown' : 'blocked', externalUploadStarted ? 'OUTCOME_UNKNOWN' : 'DEVICE_BUSY', error ? 'Serial transport disconnected unexpectedly.' : 'Serial transport disconnected.');
          void this.closeConnection(entry).catch(() => {});
        });
        this.current(entry.observation.deviceId, expected);
        if (!entry.desired || this.stopping) { await this.closeConnection(entry); throw new WorkbenchError('DEVICE_BUSY', 'Monitoring was stopped before the serial open completed.'); }
        this.set(entry, 'monitoring');
      } catch (error) {
        if (entry.connection) { try { await this.closeConnection(entry); } catch {} }
        if (!entry.connection && !entry.upload) this.release(entry);
        this.set(entry, 'blocked', error instanceof WorkbenchError ? error.code : 'DEVICE_BUSY', 'Serial port could not be opened or identity changed. Inspect external port contention and current selection.');
        throw error instanceof WorkbenchError ? error : new WorkbenchError('DEVICE_BUSY', 'Serial port open failed; another application may own it.');
      }
    })();
    try { await entry.opening; } finally { entry.opening = undefined; }
  }
  private async closeConnection(entry: Entry): Promise<void> {
    if (!entry.connection && !entry.closing) return;
    if (!entry.closing) {
      const connection = entry.connection!;
      const closing = Promise.resolve().then(() => connection.close()).then(() => {
        if (entry.connection === connection) { entry.disposeData?.(); entry.disposeDisconnect?.(); entry.connection = undefined; }
        if (!entry.upload && entry.state !== 'outcome-unknown') this.release(entry);
      });
      entry.closing = closing;
      void closing.finally(() => { if (entry.closing === closing) entry.closing = undefined; }).catch(() => {});
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([entry.closing, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new WorkbenchError('TIMEOUT', 'Serial close was not observed; the port lease remains blocked.')), this.closeTimeoutMs); })]);
    } catch (error) {
      this.set(entry, 'blocked', error instanceof WorkbenchError ? error.code : 'DEVICE_BUSY', 'Serial handle release was not confirmed; no uploader may start.');
      throw error instanceof WorkbenchError ? error : new WorkbenchError('DEVICE_BUSY', 'Serial handle release failed.');
    } finally { clearTimeout(timer); }
  }
  private snapshot(entry: Entry): DeviceSnapshot { return { observation: copyObservation(entry.observation), state: entry.state, ...(entry.problem ? { problem: { ...entry.problem } } : {}) }; }
  private set(entry: Entry, state: DeviceState, code?: string, message?: string): void {
    entry.state = state; entry.problem = code ? { code, message: message! } : undefined; this.changed(entry);
  }
  private changed(entry: Entry): void {
    // View notifications are hints; a throwing observer cannot change lease ownership.
    try { this.options.onState?.(this.snapshot(entry)); } catch {}
  }
}
