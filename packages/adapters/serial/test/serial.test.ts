import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, rmSync, writeSync, symlinkSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DeviceCoordinator, type SerialOptions } from '@robotics-workbench/devices';
import { NativeSerialTransport, RawRecorder, readRawWindow, recoverRawSegment, captureRaw, type NativePort, type RecordingResult } from '../src/index';
import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture(t: TestContext) {
  const parent = mkdtempSync(join(tmpdir(), 'workbench-raw-'));
  t.after(() => { assert.ok(!relative(tmpdir(), parent).startsWith('..')); rmSync(parent, { recursive: true, force: true }); });
  return { parent, options: { projectId: randomUUID(), projectRevision: 1, deviceId: randomUUID() } };
}
function rawBytes(result: RecordingResult): Buffer {
  return Buffer.concat(result.segments.flatMap(segment => readFileSync(segment.path, 'utf8').trim().split('\n').filter(Boolean).map(line => Buffer.from(JSON.parse(line).bytesBase64, 'base64'))));
}
const serialOptions: SerialOptions = { path: 'COM7', baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1 };
class Port implements NativePort {
  isOpen = true;
  reads = 0; closes = 0;
  private waiting?: { buffer: Buffer; resolve: (value: { buffer: Buffer; bytesRead: number }) => void; reject: (error: Error) => void };
  read(buffer: Buffer): Promise<{ buffer: Buffer; bytesRead: number }> { this.reads++; return new Promise((resolve, reject) => { this.waiting = { buffer, resolve, reject }; }); }
  feed(bytes: Buffer) { assert.ok(this.waiting); const next = this.waiting; this.waiting = undefined; bytes.copy(next.buffer); next.resolve({ buffer: next.buffer, bytesRead: bytes.length }); }
  disconnect() { this.waiting?.reject(new Error('synthetic unplug')); this.waiting = undefined; }
  async close() { this.closes++; this.isOpen = false; this.waiting?.reject(Object.assign(new Error('read cancelled'), { canceled: true })); this.waiting = undefined; }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('native adapter is lazy, read-only and waits for handle/read closure', async () => {
  const port = new Port(); let loads = 0, opens = 0;
  const transport = new NativeSerialTransport(undefined, () => { loads++; return { open: async options => { opens++; assert.deepEqual(options, serialOptions); return port; } }; });
  assert.equal(loads, 0);
  const connection = await transport.open(serialOptions);
  assert.equal(loads, 1); assert.equal(opens, 1); assert.equal(port.reads, 0, 'No read can race ahead of a subscriber.');
  assert.equal('write' in connection, false);
  const bytes: Buffer[] = [];
  connection.onData(value => bytes.push(Buffer.from(value)));
  await tick(); port.feed(Buffer.from([0xff, 0, 0x41])); await tick();
  assert.deepEqual(Buffer.concat(bytes), Buffer.from([0xff, 0, 0x41]));
  await connection.close(); await connection.close();
  assert.equal(port.closes, 1); assert.equal(port.isOpen, false);
});

test('native disconnect is observable and malformed settings never reach a binding', async () => {
  let opens = 0; const port = new Port();
  const transport = new NativeSerialTransport(undefined, () => ({ open: async () => { opens++; return port; } }));
  await assert.rejects(transport.open({ ...serialOptions, path: '../outside' }), { code: 'UNSUPPORTED_ENVIRONMENT' });
  await assert.rejects(transport.open({ ...serialOptions, baudRate: 0 }), { code: 'INVALID_REQUEST' });
  assert.equal(opens, 0);
  const connection = await transport.open(serialOptions); let disconnects = 0;
  connection.onData(() => {}); connection.onDisconnect(() => { disconnects++; });
  await tick(); port.disconnect(); await tick();
  assert.equal(disconnects, 1); await connection.close(); assert.equal(port.isOpen, false);
});

test('native subscribers are isolated and closure waits for the native close promise', async () => {
  const port = new Port(); let release!: () => void;
  const nativeClose = port.close.bind(port);
  port.close = async () => { await new Promise<void>(resolve => { release = resolve; }); await nativeClose(); };
  const connection = await new NativeSerialTransport(undefined, () => ({ open: async () => port })).open(serialOptions);
  connection.onData(() => { throw new Error('synthetic display failure'); });
  let calls = 0; connection.onData(() => { calls++; });
  await tick(); port.feed(Buffer.from('first')); await tick(); port.feed(Buffer.from('second')); await tick();
  assert.equal(calls, 2);
  let closed = false; const closing = connection.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false); release(); await closing; assert.equal(closed, true);
});

test('failed native load and external port ownership are explicit errors', async () => {
  await assert.rejects(new NativeSerialTransport(undefined, () => { throw new Error('load failed'); }).open(serialOptions), { code: 'TOOL_UNAVAILABLE' });
  await assert.rejects(new NativeSerialTransport(undefined, () => ({ open: async () => { throw new Error('owned externally'); } })).open(serialOptions), { code: 'DEVICE_BUSY' });
});

test('raw byte identity survives arbitrary chunks, invalid UTF-8 and incomplete text lines', t => {
  const { parent, options } = fixture(t);
  const bytes = Buffer.from([0x41, 0xe2, 0x82, 0xac, 0xff, 0, 10, 0x42]);
  const split = new RawRecorder(parent, options), joined = new RawRecorder(parent, options);
  for (const part of [bytes.subarray(0, 2), bytes.subarray(2, 3), bytes.subarray(3)]) assert.equal(split.receive(part), true);
  joined.receive(bytes);
  const a = split.finish(), b = joined.finish();
  assert.deepEqual(rawBytes(a), bytes); assert.deepEqual(rawBytes(b), bytes);
  assert.equal(a.rawSha256, b.rawSha256); assert.equal(a.rawSha256, sha(bytes));
  assert.equal(a.rawBytes, bytes.length); assert.equal(a.status, 'completed');
  for (const segment of a.segments) assert.equal(segment.sha256, sha(readFileSync(segment.path)));
  const validator = new Ajv(); addFormats(validator); const valid = validator.compile(JSON.parse(readFileSync('contracts/serial-record.schema.json', 'utf8')));
  for (const segment of a.segments) for (const line of readFileSync(segment.path, 'utf8').trim().split('\n')) assert.equal(valid(JSON.parse(line)), true, JSON.stringify(valid.errors));
  assert.equal(joined.receive(Buffer.from('late')), false);
});

test('upload/disconnect boundaries retain explicit gaps and new connection segments', t => {
  const { parent, options } = fixture(t); const recorder = new RawRecorder(parent, options);
  recorder.receive(Buffer.from('before\n')); recorder.boundary('upload'); recorder.receive(Buffer.from('after\n'));
  recorder.boundary('disconnect'); const result = recorder.finish('interrupted');
  assert.equal(result.status, 'interrupted');
  assert.deepEqual(rawBytes(result), Buffer.from('before\nafter\n'));
  assert.notEqual(result.segments[0].connectionSessionId, result.segments[1].connectionSessionId);
  assert.deepEqual(result.gaps.map(gap => gap.cause), ['upload', 'disconnect', 'service-restart']);
  assert.ok(result.gaps.every(gap => gap.lostBytes === null && gap.endElapsedNs !== null));
  assert.equal(result.uploadReceiptId, null); assert.equal(result.firmwareSha256, null);
});

test('bounded segment rotation and previews retain all raw evidence', t => {
  const { parent, options } = fixture(t); const recorder = new RawRecorder(parent, { ...options, limits: { segmentBytes: 1024 } });
  const bytes = Buffer.alloc(10000, 120); recorder.receive(bytes);
  const preview = recorder.preview(512); const result = recorder.finish();
  assert.ok(Buffer.byteLength(preview.text) <= 512); assert.equal(preview.truncated, true);
  assert.ok(result.segments.length > 1); assert.ok(result.segments.every(segment => segment.sizeBytes <= 1024));
  assert.deepEqual(rawBytes(result), bytes); assert.equal(result.rawSha256, sha(bytes));
  const invalid = new RawRecorder(parent, options); invalid.receive(Buffer.alloc(1024, 0xff));
  assert.ok(Buffer.byteLength(invalid.preview(512).text) <= 512); assert.equal(invalid.preview(512).truncated, true); invalid.finish();
});

test('disk failure retains earlier complete raw records and labels partial evidence', async t => {
  const { parent, options } = fixture(t); let writes = 0;
  const recorder = new RawRecorder(parent, { ...options, io: { write(fd, bytes, offset, length) { if (++writes > 1) throw Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' }); return writeSync(fd, bytes, offset, length); } } });
  assert.equal(recorder.receive(Buffer.from('retained\n')), true);
  assert.equal(recorder.receive(Buffer.from('not persisted\n')), false);
  assert.equal((await recorder.failed).code, 'CAPTURE_STORAGE_FAILED');
  const result = recorder.finish(); assert.equal(result.status, 'failed'); assert.equal(result.segments[0].complete, false);
  assert.deepEqual(rawBytes(result), Buffer.from('retained\n'));
  assert.equal(result.gaps.at(-1)?.cause, 'disk-failure'); assert.equal(result.gaps.at(-1)?.lostBytes, null);
});

test('acquisition/recording caps stop capture explicitly without deleting prior bytes', t => {
  const { parent, options } = fixture(t);
  const overflow = new RawRecorder(parent, { ...options, limits: { acquisitionBytes: 4 } });
  assert.equal(overflow.receive(Buffer.from('12345')), false);
  assert.equal(overflow.finish().gaps[0].lostBytes, 5);
  const limited = new RawRecorder(parent, { ...options, limits: { recordingBytes: 5 } });
  limited.receive(Buffer.from('1234')); assert.equal(limited.receive(Buffer.from('56')), false);
  const result = limited.finish(); assert.deepEqual(rawBytes(result), Buffer.from('1234')); assert.equal(result.error?.code, 'RECORDING_LIMIT');
});

test('bounded raw windows page without serial writes and reject forged offsets', t => {
  const { parent, options } = fixture(t); const recorder = new RawRecorder(parent, options);
  recorder.receive(Buffer.from('one')); recorder.receive(Buffer.from('two')); const result = recorder.finish();
  const path = result.segments[0].path;
  const first = readRawWindow(path, { limit: 1 }); assert.equal(first.records.length, 1); assert.ok(first.nextOffset);
  const second = readRawWindow(path, { offset: first.nextOffset!, limit: 1 });
  assert.deepEqual(Buffer.from(second.records[0].bytesBase64, 'base64'), Buffer.from('two')); assert.equal(second.nextOffset, null);
  assert.throws(() => readRawWindow(path, { offset: 1 }), { code: 'INVALID_REQUEST' });
  const larger = new RawRecorder(parent, options); larger.receive(Buffer.alloc(4096, 65)); const segment = larger.finish().segments[0];
  assert.throws(() => readRawWindow(segment.path, { maxBytes: 512 }), { code: 'INVALID_REQUEST' }, 'An undersized page must not return a cursor that never advances.');
  assert.equal(readRawWindow(segment.path, { maxBytes: 16384 }).records.length, 1);
});

test('repeated boundaries replace metadata and record reconnect without inventing bytes', t => {
  const { parent, options } = fixture(t); const recorder = new RawRecorder(parent, options);
  for (let index = 0; index < 20; index++) recorder.boundary(index % 2 ? 'reconnect' : 'disconnect');
  const result = recorder.finish();
  assert.deepEqual(readdirSync(recorder.directory), ['metadata.json']);
  assert.equal(result.rawBytes, 0); assert.equal(result.segments.length, 0); assert.equal(result.gaps.length, 20);
  assert.deepEqual(JSON.parse(readFileSync(join(recorder.directory, 'metadata.json'), 'utf8')), result);
});

test('crash recovery preserves the original segment and quarantines incomplete final JSON', t => {
  const { parent, options } = fixture(t); const recorder = new RawRecorder(parent, options);
  recorder.receive(Buffer.from('retained bytes')); const result = recorder.finish(); const path = result.segments[0].path;
  appendFileSync(path, '{"incomplete":'); const original = readFileSync(path);
  const recovered = recoverRawSegment(path);
  assert.deepEqual(readFileSync(path), original); assert.equal(recovered.completeRecords, 1);
  assert.equal(recovered.rawSha256, sha(Buffer.from('retained bytes'))); assert.ok(recovered.incompleteTailBytes > 0);
  assert.equal(readRawWindow(recovered.recoveredPath).incompleteTailBytes, 0);
  assert.equal(readFileSync(recovered.quarantinePath!, 'utf8'), '{"incomplete":');
});

test('recovery quarantines malformed complete records and all following bytes', t => {
  const { parent, options } = fixture(t); const recorder = new RawRecorder(parent, options);
  recorder.receive(Buffer.from('valid')); const path = recorder.finish().segments[0].path;
  appendFileSync(path, '{}\nfollow-on bytes'); const before = readFileSync(path);
  const result = recoverRawSegment(path);
  assert.equal(result.completeRecords, 1); assert.equal(result.rawBytes, 5);
  assert.equal(readFileSync(result.quarantinePath!, 'utf8'), '{}\nfollow-on bytes');
  assert.deepEqual(readFileSync(path), before);
});

test('recording paths reject junction escape before creating evidence', t => {
  const { parent, options } = fixture(t); const target = join(parent, 'target'); mkdirSync(target);
  const linked = join(parent, 'linked'); symlinkSync(target, linked, 'junction');
  assert.throws(() => new RawRecorder(join(linked, 'new'), options), { code: 'UNAUTHORIZED_SCOPE' });
});

test('timed capture cancellation observes close and preserves acquired raw bytes', async t => {
  const { parent, options } = fixture(t); const port = new Port();
  const coordinator = new DeviceCoordinator(new NativeSerialTransport(undefined, () => ({ open: async () => port })));
  const observationId = randomUUID(); coordinator.observe({ deviceId: options.deviceId, observationId, observedAt: new Date().toISOString(), transportPath: 'COM7', connected: true, identityStatus: 'identified' });
  const recorder = new RawRecorder(parent, options), controller = new AbortController();
  const task = captureRaw(coordinator, { deviceId: options.deviceId, expectedDeviceObservationId: observationId, baudRate: 9600 }, recorder, { durationMs: 600000, signal: controller.signal });
  await tick(); port.feed(Buffer.from('captured')); await tick(); controller.abort();
  const result = await task; assert.equal(result.status, 'cancelled'); assert.deepEqual(rawBytes(result), Buffer.from('captured'));
  assert.equal(port.isOpen, false); await coordinator.shutdown();
});

test('capture rejects uncertain close while preserving a finalized failed recording', async t => {
  const { parent, options } = fixture(t); const port = new Port();
  port.close = async () => { throw new Error('synthetic unconfirmed close'); };
  const coordinator = new DeviceCoordinator(new NativeSerialTransport(undefined, () => ({ open: async () => port })));
  const observationId = randomUUID(); coordinator.observe({ deviceId: options.deviceId, observationId, observedAt: new Date().toISOString(), transportPath: 'COM7', connected: true, identityStatus: 'identified' });
  const recorder = new RawRecorder(parent, options), controller = new AbortController();
  const capture = captureRaw(coordinator, { deviceId: options.deviceId, expectedDeviceObservationId: observationId, baudRate: 9600 }, recorder, { durationMs: 1000, signal: controller.signal });
  await tick(); port.feed(Buffer.from('retained')); await tick(); controller.abort();
  await assert.rejects(capture, { code: 'OUTCOME_UNKNOWN' });
  assert.equal(coordinator.status(options.deviceId)[0].state, 'blocked');
  const result = recorder.snapshot(); assert.equal(result.status, 'failed'); assert.deepEqual(rawBytes(result), Buffer.from('retained'));
  port.disconnect();
});
