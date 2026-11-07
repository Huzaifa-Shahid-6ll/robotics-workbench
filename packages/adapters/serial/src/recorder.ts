import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isRequestId, WorkbenchError } from '@robotics-workbench/contracts';
import type { DeviceCoordinator, MonitorRequest } from '@robotics-workbench/devices';

export type RawRecord = { schemaVersion: 1; recordingId: string; connectionSessionId: string; sequence: number; hostElapsedNs: string; hostReceivedAt: string; bytesBase64: string; quality: 'received' };
export type GapCause = 'upload' | 'disconnect' | 'reconnect' | 'overflow' | 'disk-failure' | 'cancelled' | 'limit' | 'service-restart';
export type RawGap = { cause: GapCause; connectionSessionId: string; startElapsedNs: string; endElapsedNs: string | null; lostBytes: number | null };
export type RawSegment = { path: string; sha256: string; sizeBytes: number; complete: boolean; connectionSessionId: string };
export type RecordingResult = {
  schemaVersion: 1; recordingId: string; projectId: string; projectRevision: number; deviceId: string;
  serial: { baudRate: number; dataBits: 8; parity: 'none'; stopBits: 1; encoding: 'utf8' };
  uploadReceiptId: string | null; firmwareSha256: string | null; parserVersion: 'raw-v1';
  startedAt: string; finishedAt: string | null; status: 'recording' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
  rawBytes: number; rawSha256: string; segments: RawSegment[]; gaps: RawGap[]; error?: { code: string; message: string };
};
export type RecorderOptions = {
  projectId: string; projectRevision: number; deviceId: string; baudRate?: number;
  uploadReceiptId?: string | null; firmwareSha256?: string | null;
  limits?: { segmentBytes?: number; recordingBytes?: number; acquisitionBytes?: number };
  io?: { write(fd: number, bytes: Buffer, offset: number, length: number): number };
  onRecord?: (record: RawRecord) => void;
  onGap?: (gap: RawGap) => void;
};
const MiB = 1024 * 1024;
const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const causes: GapCause[] = ['upload', 'disconnect', 'reconnect', 'overflow', 'disk-failure', 'cancelled', 'limit', 'service-restart'];

function ordinaryFile(path: string, maximum = 64 * MiB): number {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maximum) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Use an ordinary bounded raw recording file.');
  return info.size;
}
function directory(path: string): string {
  if (!isAbsolute(path) || /^\\\\|^\/\//.test(path)) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Use an absolute local recording directory.');
  let ancestor = resolve(path);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  if (realpathSync(ancestor).toLowerCase() !== ancestor.toLowerCase() || lstatSync(ancestor).isSymbolicLink()) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Recording directories cannot traverse junctions or links.');
  mkdirSync(path, { recursive: true });
  return realpathSync(path);
}
function fileHash(path: string): string {
  ordinaryFile(path);
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024), fd = openSync(path, 'r');
  try { let count: number; while ((count = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count)); }
  finally { closeSync(fd); }
  return hash.digest('hex');
}
function rawRecord(value: unknown): RawRecord {
  const record = value as RawRecord;
  if (!record || typeof record !== 'object' || Object.keys(record).sort().join(',') !== 'bytesBase64,connectionSessionId,hostElapsedNs,hostReceivedAt,quality,recordingId,schemaVersion,sequence'
    || record.schemaVersion !== 1 || !isRequestId(record.recordingId) || !isRequestId(record.connectionSessionId)
    || !Number.isSafeInteger(record.sequence) || record.sequence < 0 || typeof record.hostElapsedNs !== 'string' || !/^(0|[1-9][0-9]*)$/.test(record.hostElapsedNs)
    || typeof record.hostReceivedAt !== 'string' || !record.hostReceivedAt.endsWith('Z') || !Number.isFinite(Date.parse(record.hostReceivedAt))
    || typeof record.bytesBase64 !== 'string' || record.bytesBase64.length < 4 || !base64.test(record.bytesBase64) || record.quality !== 'received') {
    throw new WorkbenchError('INVALID_REQUEST', 'Raw segment contains a malformed record.');
  }
  return record;
}

/** Synchronous bounded writes persist each incoming chunk before a display consumer can inspect it. */
export class RawRecorder {
  readonly recordingId = randomUUID();
  readonly directory: string;
  readonly failed: Promise<WorkbenchError>;
  private failure?: WorkbenchError;
  private failPromise!: (error: WorkbenchError) => void;
  private readonly started = process.hrtime.bigint();
  private readonly hash = createHash('sha256');
  private readonly segmentLimit: number;
  private readonly recordingLimit: number;
  private readonly acquisitionLimit: number;
  private session = randomUUID();
  private sequence = 0;
  private fd?: number;
  private activePath?: string;
  private activeSize = 0;
  private previewBytes = Buffer.alloc(0);
  private omittedDisplayEvents = 0;
  private final?: RecordingResult;
  private readonly result: RecordingResult;

  constructor(parentDirectory: string, private readonly options: RecorderOptions) {
    if (!isRequestId(options.projectId) || !isRequestId(options.deviceId) || !Number.isSafeInteger(options.projectRevision) || options.projectRevision < 1
      || (options.uploadReceiptId != null && !isRequestId(options.uploadReceiptId)) || (options.firmwareSha256 != null && !/^[a-f0-9]{64}$/.test(options.firmwareSha256))) throw new WorkbenchError('INVALID_REQUEST', 'Recording requires valid project, device and evidence identities.');
    const baudRate = options.baudRate ?? 9600;
    if (!Number.isSafeInteger(baudRate) || baudRate < 1 || baudRate > 4000000) throw new WorkbenchError('INVALID_REQUEST', 'Choose an explicit valid serial baud rate.');
    this.segmentLimit = options.limits?.segmentBytes ?? 64 * MiB;
    this.recordingLimit = options.limits?.recordingBytes ?? 1024 * MiB;
    this.acquisitionLimit = options.limits?.acquisitionBytes ?? 8 * MiB;
    if (![this.segmentLimit, this.recordingLimit, this.acquisitionLimit].every(Number.isSafeInteger) || this.segmentLimit < 1024 || this.segmentLimit > 64 * MiB || this.recordingLimit < 1 || this.recordingLimit > 1024 * MiB || this.acquisitionLimit < 1 || this.acquisitionLimit > 8 * MiB) throw new WorkbenchError('INVALID_REQUEST', 'Invalid bounded recording limits.');
    this.directory = mkdtempSync(join(directory(parentDirectory), 'recording-'));
    this.failed = new Promise(resolve => { this.failPromise = resolve; });
    this.result = { schemaVersion: 1, recordingId: this.recordingId, projectId: options.projectId, projectRevision: options.projectRevision, deviceId: options.deviceId,
      serial: { baudRate, dataBits: 8, parity: 'none', stopBits: 1, encoding: 'utf8' }, uploadReceiptId: options.uploadReceiptId ?? null,
      firmwareSha256: options.firmwareSha256 ?? null, parserVersion: 'raw-v1', startedAt: new Date().toISOString(), finishedAt: null,
      status: 'recording', rawBytes: 0, rawSha256: this.hash.copy().digest('hex'), segments: [], gaps: [] };
    this.metadata();
  }

  receive(bytes: Uint8Array): boolean {
    if (this.final || this.failure) return false;
    if (!(bytes instanceof Uint8Array)) throw new WorkbenchError('INVALID_REQUEST', 'Serial capture accepts bytes only.');
    if (!bytes.byteLength) return true;
    if (bytes.byteLength > this.acquisitionLimit) { this.fail('CAPTURE_OVERFLOW', 'Incoming acquisition exceeded its bounded queue; capture stopped.', 'overflow', bytes.byteLength); return false; }
    if (this.result.rawBytes + bytes.byteLength > this.recordingLimit) { this.fail('RECORDING_LIMIT', 'Recording limit reached; retained evidence was preserved.', 'limit', bytes.byteLength); return false; }
    const openGap = this.result.gaps.at(-1); if (openGap?.endElapsedNs === null) openGap.endElapsedNs = this.elapsed();
    // JSON/base64 framing must fit the bounded segment even in small fault-injection fixtures.
    const fragment = Math.min(8 * 1024, Math.floor((this.segmentLimit - 512) * 3 / 4));
    const receivedAt = new Date().toISOString(), elapsedNs = this.elapsed();
    for (let offset = 0; offset < bytes.byteLength; offset += fragment) {
      const chunk = Buffer.from(bytes.subarray(offset, offset + fragment));
      const record: RawRecord = { schemaVersion: 1, recordingId: this.recordingId, connectionSessionId: this.session, sequence: this.sequence++,
        hostElapsedNs: elapsedNs, hostReceivedAt: receivedAt, bytesBase64: chunk.toString('base64'), quality: 'received' };
      const line = Buffer.from(JSON.stringify(record) + '\n');
      try {
        if (this.fd !== undefined && this.activeSize + line.length > this.segmentLimit) this.closeSegment(true);
        if (this.failure) return false;
        if (this.fd === undefined) { this.activePath = join(this.directory, `${this.result.segments.length + 1}.partial.jsonl`); this.fd = openSync(this.activePath, 'wx', 0o600); this.activeSize = 0; }
        let written = 0;
        while (written < line.length) {
          const count = (this.options.io?.write ?? writeSync)(this.fd, line, written, line.length - written);
          if (!Number.isSafeInteger(count) || count < 1 || count > line.length - written) throw new Error('Raw write did not progress.');
          written += count; this.activeSize += count;
        }
        this.hash.update(chunk); this.result.rawBytes += chunk.length;
        this.previewBytes = Buffer.concat([this.previewBytes, chunk]).subarray(-64 * 1024);
        this.observe(this.options.onRecord, record);
      } catch { this.fail('CAPTURE_STORAGE_FAILED', 'Raw recording storage failed; earlier complete records were preserved.', 'disk-failure', null); return false; }
    }
    return true;
  }

  boundary(cause: GapCause, lostBytes: number | null = null): void {
    if (this.final || this.failure) return;
    if (!causes.includes(cause) || (lostBytes !== null && (!Number.isSafeInteger(lostBytes) || lostBytes < 0))) throw new WorkbenchError('INVALID_REQUEST', 'Invalid recording gap.');
    this.gap(cause, lostBytes); this.closeSegment(true); this.session = randomUUID(); this.sequence = 0;
    try { this.metadata(); } catch { this.fail('CAPTURE_STORAGE_FAILED', 'Recording metadata could not be saved.', 'disk-failure', null); }
  }

  preview(maxBytes = 16 * 1024): { text: string; truncated: boolean; rawBytes: number; parserVersion: 'raw-v1'; omittedDisplayEvents: number } {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024) throw new WorkbenchError('INVALID_REQUEST', 'Preview limit must be from 1 to 65536 bytes.');
    const decoded = this.previewBytes.subarray(-maxBytes).toString('utf8'), rows = decoded.split('\n');
    let text = rows.slice(-10000).join('\n');
    const expanded = Buffer.byteLength(text) > maxBytes;
    if (expanded) {
      const suffix: string[] = []; let retained = 0;
      for (const character of [...text].reverse()) { const size = Buffer.byteLength(character); if (retained + size > maxBytes) break; suffix.push(character); retained += size; }
      text = suffix.reverse().join('');
    }
    return { text, truncated: this.result.rawBytes > Math.min(this.previewBytes.length, maxBytes) || rows.length > 10000 || expanded, rawBytes: this.result.rawBytes, parserVersion: 'raw-v1', omittedDisplayEvents: this.omittedDisplayEvents };
  }

  snapshot(): RecordingResult {
    return structuredClone({ ...this.result, rawSha256: this.hash.copy().digest('hex') });
  }

  failCapture(error: WorkbenchError): void {
    this.fail(error.code.slice(0, 128), error.message.slice(0, 2048), 'disconnect', null);
  }

  finish(reason: 'completed' | 'cancelled' | 'failed' | 'interrupted' = 'completed'): RecordingResult {
    if (this.final) return structuredClone(this.final);
    if (reason !== 'completed' && !this.failure) this.gap(reason === 'cancelled' ? 'cancelled' : reason === 'interrupted' ? 'service-restart' : 'disconnect', null);
    this.closeSegment(!this.failure);
    const openGap = this.result.gaps.at(-1); if (openGap?.endElapsedNs === null) openGap.endElapsedNs = this.elapsed();
    this.result.status = this.failure ? 'failed' : reason;
    this.result.finishedAt = new Date().toISOString(); this.result.rawSha256 = this.hash.copy().digest('hex');
    try { this.metadata(); } catch { this.fail('CAPTURE_STORAGE_FAILED', 'Recording metadata could not be finalized; retained raw segments remain recoverable.', 'disk-failure', null); this.result.status = 'failed'; }
    this.final = this.snapshot(); return structuredClone(this.final);
  }

  private elapsed(): string { return (process.hrtime.bigint() - this.started).toString(); }
  private observe<T>(observer: ((value: T) => void) | undefined, value: T): void {
    if (!observer) return;
    try {
      const pending: unknown = observer(structuredClone(value));
      if (pending instanceof Promise) void pending.catch(() => { this.omittedDisplayEvents++; });
    } catch { this.omittedDisplayEvents++; }
  }
  private gap(cause: GapCause, lostBytes: number | null): void {
    if (this.result.gaps.length >= 1000) { this.fail('RECORDING_LIMIT', 'Recording gap limit reached; capture stopped.', 'limit', lostBytes); return; }
    const previous = this.result.gaps.at(-1); if (previous?.endElapsedNs === null) previous.endElapsedNs = this.elapsed();
    this.result.gaps.push({ cause, connectionSessionId: this.session, startElapsedNs: this.elapsed(), endElapsedNs: null, lostBytes });
    this.observe(this.options.onGap, this.result.gaps.at(-1)!);
  }
  private fail(code: string, message: string, cause: GapCause, lostBytes: number | null): void {
    if (this.failure) return;
    this.failure = new WorkbenchError(code, message); this.result.error = { code, message }; this.result.status = 'failed';
    if (this.result.gaps.length < 1000) this.gap(cause, lostBytes);
    this.failPromise(this.failure);
  }
  private closeSegment(complete: boolean): void {
    if (this.fd === undefined || !this.activePath) return;
    const path = this.activePath; const fd = this.fd; this.fd = undefined; this.activePath = undefined;
    try { fsyncSync(fd); } catch { complete = false; this.fail('CAPTURE_STORAGE_FAILED', 'Raw segment could not be synchronized.', 'disk-failure', null); }
    try { closeSync(fd); } catch { complete = false; this.fail('CAPTURE_STORAGE_FAILED', 'Raw segment handle could not close.', 'disk-failure', null); }
    let finalPath = path;
    if (complete) {
      finalPath = path.replace('.partial.jsonl', '.jsonl');
      try { linkSync(path, finalPath); unlinkSync(path); }
      catch { finalPath = path; complete = false; this.fail('CAPTURE_STORAGE_FAILED', 'Raw segment publication failed; staged evidence remains.', 'disk-failure', null); }
    }
    try { this.result.segments.push({ path: finalPath, sha256: fileHash(finalPath), sizeBytes: statSync(finalPath).size, complete, connectionSessionId: this.session }); }
    catch { this.fail('CAPTURE_STORAGE_FAILED', 'Raw segment integrity could not be recorded.', 'disk-failure', null); }
    this.activeSize = 0;
  }
  private metadata(): void {
    const stage = join(this.directory, `metadata-${randomUUID()}.tmp`), target = join(this.directory, 'metadata.json');
    writeFileSync(stage, JSON.stringify(this.snapshot()) + '\n', { flag: 'wx', mode: 0o600 });
    if (existsSync(target)) ordinaryFile(target, MiB);
    renameSync(stage, target);
  }
}

/** Bounded replay uses byte offsets in a fixed segment; it performs no serial I/O. */
export function readRawWindow(path: string, options: { offset?: number; limit?: number; maxBytes?: number } = {}): { records: RawRecord[]; nextOffset: number | null; incompleteTailBytes: number; truncated: boolean } {
  const size = ordinaryFile(path), offset = options.offset ?? 0, limit = options.limit ?? 100, cap = options.maxBytes ?? 16 * 1024;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > size || !Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(cap) || cap < 512 || cap > 32 * 1024) throw new WorkbenchError('INVALID_REQUEST', 'Invalid bounded raw-record window.');
  const fd = openSync(path, 'r'); const records: RawRecord[] = []; let position = offset, retained = 2, incompleteTailBytes = 0;
  try {
    if (offset) { const previous = Buffer.alloc(1); readSync(fd, previous, 0, 1, offset - 1); if (previous[0] !== 10) throw new WorkbenchError('INVALID_REQUEST', 'Recording cursor must identify a complete record boundary.'); }
    const buffer = Buffer.allocUnsafe(64 * 1024); let pending = Buffer.alloc(0), readPosition = offset;
    while (readPosition < size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - readPosition), readPosition); if (!count) break; readPosition += count;
      pending = Buffer.concat([pending, buffer.subarray(0, count)]);
      let newline: number;
      while ((newline = pending.indexOf(10)) !== -1) {
        const line = pending.subarray(0, newline); if (line.length > MiB) throw new WorkbenchError('INVALID_REQUEST', 'Raw frame exceeds the parser bound.');
        if (retained + line.length + 1 > cap && records.length === 0) throw new WorkbenchError('INVALID_REQUEST', 'Increase the raw window byte limit to fit one complete record.');
        if (records.length >= limit || retained + line.length + 1 > cap) return { records, nextOffset: position, incompleteTailBytes: 0, truncated: true };
        let record: RawRecord; try { record = rawRecord(JSON.parse(line.toString('utf8'))); } catch { throw new WorkbenchError('INVALID_REQUEST', 'Recording contains an invalid complete record.'); }
        records.push(record); retained += line.length + 1; position += newline + 1; pending = pending.subarray(newline + 1);
      }
      if (pending.length > MiB) throw new WorkbenchError('INVALID_REQUEST', 'Incomplete raw frame exceeds the parser bound.');
    }
    incompleteTailBytes = pending.length;
    return { records, nextOffset: null, incompleteTailBytes, truncated: false };
  } finally { closeSync(fd); }
}

export function recoverRawSegment(path: string): { recoveredPath: string; quarantinePath: string | null; completeRecords: number; incompleteTailBytes: number; rawBytes: number; rawSha256: string } {
  const size = ordinaryFile(path), parent = directory(dirname(path)), recoveredPath = join(parent, `recovered-${randomUUID()}.jsonl`);
  const output = openSync(recoveredPath, 'wx', 0o600), source = openSync(path, 'r'), hash = createHash('sha256');
  let cursor = 0, completeRecords = 0, rawBytes = 0;
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024); let pending = Buffer.alloc(0), position = 0, invalid = false;
    while (position < size && !invalid) {
      const count = readSync(source, buffer, 0, Math.min(buffer.length, size - position), position); if (!count) break; position += count;
      pending = Buffer.concat([pending, buffer.subarray(0, count)]);
      let newline: number;
      while ((newline = pending.indexOf(10)) !== -1) {
        const line = pending.subarray(0, newline); let record: RawRecord;
        try { if (line.length > MiB) throw new Error('Oversized raw frame.'); record = rawRecord(JSON.parse(line.toString('utf8'))); }
        catch { invalid = true; break; }
        const bytes = Buffer.from(record.bytesBase64, 'base64'); hash.update(bytes); rawBytes += bytes.length; completeRecords++;
        writeFileSync(output, pending.subarray(0, newline + 1)); cursor += newline + 1; pending = pending.subarray(newline + 1);
      }
      if (pending.length > MiB) invalid = true;
    }
    fsyncSync(output);
  } finally { closeSync(source); closeSync(output); }
  const incompleteTailBytes = size - cursor; let quarantinePath: string | null = null;
  if (incompleteTailBytes) {
    quarantinePath = join(parent, `incomplete-${randomUUID()}.bin`);
    const input = openSync(path, 'r'), output = openSync(quarantinePath, 'wx', 0o600), tail = Buffer.allocUnsafe(64 * 1024);
    try { let position = cursor; while (position < size) { const count = readSync(input, tail, 0, Math.min(tail.length, size - position), position); if (!count) break; writeFileSync(output, tail.subarray(0, count)); position += count; } fsyncSync(output); }
    finally { closeSync(input); closeSync(output); }
  }
  return { recoveredPath, quarantinePath, completeRecords, incompleteTailBytes, rawBytes, rawSha256: hash.digest('hex') };
}

export async function captureRaw(coordinator: DeviceCoordinator, request: MonitorRequest, recorder: RawRecorder, options: { durationMs: number; signal?: AbortSignal }): Promise<RecordingResult> {
  if (!Number.isSafeInteger(options.durationMs) || options.durationMs < 1000 || options.durationMs > 3600000) throw new WorkbenchError('INVALID_REQUEST', 'Native capture duration must be from 1 second to 60 minutes.');
  if (options.signal?.aborted) return recorder.finish('cancelled');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let subscription: { close(): Promise<void> } | undefined;
  let reason: 'completed' | 'cancelled' | 'failed' = 'completed';
  try {
    subscription = await coordinator.monitor(request, bytes => { recorder.receive(bytes); });
    const ended = await Promise.race([
      new Promise<'completed'>(resolve => { timer = setTimeout(() => resolve('completed'), options.durationMs); }),
      new Promise<'cancelled'>(resolve => { onAbort = () => resolve('cancelled'); options.signal?.addEventListener('abort', onAbort, { once: true }); if (options.signal?.aborted) onAbort(); }),
      recorder.failed.then(() => 'failed' as const)
    ]);
    reason = ended;
  } catch (error) {
    reason = 'failed';
    recorder.failCapture(error instanceof WorkbenchError ? error : new WorkbenchError('INTERNAL_ERROR', 'Capture could not acquire the selected serial stream.'));
  }
  finally {
    clearTimeout(timer); if (onAbort) options.signal?.removeEventListener('abort', onAbort);
    try { await subscription?.close(); }
    catch { recorder.finish('failed'); throw new WorkbenchError('OUTCOME_UNKNOWN', 'Serial closure was not confirmed; retained capture requires reconciliation.'); }
  }
  return recorder.finish(reason);
}
