import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkbenchError, type OperationReceipt, type ProjectRequest, type ProjectResponse } from '@robotics-workbench/contracts';
import { FakeSerialTransport } from '../../../packages/test-fixtures/devices/fake-serial';
import { ProjectService } from '../src/project-service';
import { HardwareService, type StoredRecording } from '../src/hardware-service';

const result = <T>(response: ProjectResponse): T => { assert.equal(response.error, undefined, JSON.stringify(response.error)); return response.result as T; };
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-upload-reconcile-')), root = join(directory, 'project'), data = join(directory, 'data'); mkdirSync(root);
  const manifest = JSON.parse(readFileSync('examples/workbench.valid.json', 'utf8')); writeFileSync(join(root, 'workbench.json'), JSON.stringify(manifest));
  let project = new ProjectService(root, data), transport = new FakeSerialTransport(), hardware: HardwareService;
  const adapter = { inspect: async () => { throw Error('Unused fixture inspection.'); }, discover: async () => [{ address: 'COM41', protocol: 'serial' as const, label: 'Synthetic original board', properties: { serialNumber: 'synthetic-stable-only', vid: '2341', pid: '0043' }, matchingBoards: [] }], compile: async () => { throw Error('No compiler in reconciliation.'); }, upload: async () => { throw Error('Acknowledgement cannot upload.'); }, assertCurrent: async () => {} };
  hardware = new HardwareService(project, process.execPath, undefined, { arduino: adapter, transport });
  t.after(async () => { await project.shutdown(); assert.equal(dirname(realpathSync(directory)), realpathSync(tmpdir())); rmSync(directory, { recursive: true, force: true }); });
  const request = (method: ProjectRequest['method'], params: Record<string, unknown> = {}, revision?: number): ProjectRequest => ({ schemaVersion: 1, requestId: randomUUID(), projectId: project.projectId, method, params, ...(revision === undefined ? {} : { expectedProjectRevision: revision }) });
  const device = (await hardware.discover())[0];
  const interrupted = () => {
    const operation: OperationReceipt = { schemaVersion: 1, operationId: randomUUID(), requestId: randomUUID(), projectId: project.projectId, kind: 'upload', status: 'queued', deviceId: device.observation.deviceId, sourceSnapshotId: randomUUID(), expectedProjectRevision: 1, createdAt: new Date().toISOString(), tool: { name: 'synthetic-no-device', version: '1' }, artifacts: [] };
    project.store.createOperation(operation, { synthetic: true }); project.store.transitionOperation(project.projectId, operation.operationId, 'running');
    const unknown = project.store.transitionOperation(project.projectId, operation.operationId, 'outcome-unknown'); hardware.devices.markOutcomeUnknown(device.observation.deviceId); return unknown;
  };
  const acknowledge = (operation: OperationReceipt, observationId = hardware.devices.status(device.observation.deviceId)[0].observation.observationId) => request('device.reconcile', { operationId: operation.operationId, deviceId: device.observation.deviceId, expectedDeviceObservationId: observationId, processTerminationConfirmed: true, note: 'Synthetic fixture: old process termination observed; firmware contents remain unknown.' }, 1);
  return { directory, root, data, device, request, interrupted, acknowledge, get project() { return project; }, get hardware() { return hardware; }, get transport() { return transport; }, async restart() { await project.shutdown(); project = new ProjectService(root, data); transport = new FakeSerialTransport(); hardware = new HardwareService(project, process.execPath, undefined, { arduino: adapter, transport }); return (await hardware.discover())[0]; } };
}

test('unknown-upload acknowledgement is durable, idempotent and preserves the original receipt without any physical action', async t => {
  const f = await fixture(t), unknown = f.interrupted(), request = f.acknowledge(unknown);
  const [first, duplicate] = await Promise.all([f.hardware.handle(request), f.hardware.handle(request)]);
  assert.deepEqual(result(first), result(duplicate)); assert.deepEqual(result(first), { operationId: unknown.operationId, deviceId: unknown.deviceId, observationId: f.device.observation.observationId, acknowledged: true, firmwareState: 'unknown' });
  assert.deepEqual(f.project.store.getOperation(f.project.projectId, unknown.operationId), unknown);
  assert.equal(f.project.store.listRecords<{ kind: string }>('observations', f.project.projectId).filter(row => row.kind === 'upload-reconciliation').length, 1);
  assert.equal(f.hardware.devices.status(f.device.observation.deviceId)[0].state, 'available');
  const changed = { ...request, params: { ...request.params, note: 'Different acknowledged intent' } }; assert.equal((await f.hardware.handle(changed)).error?.code, 'REQUEST_ID_CONFLICT');
  assert.equal(f.transport.connections.length, 0);
  assert.equal((await f.restart()).state, 'available'); assert.equal(f.transport.connections.length, 0);
  assert.deepEqual(f.project.store.getOperation(f.project.projectId, unknown.operationId), unknown); assert.deepEqual(result(await f.hardware.handle(request)), result(first));
});

test('stale, unconfirmed, wrong-device and active-job acknowledgements cannot release unknown reservations', async t => {
  const f = await fixture(t), unknown = f.interrupted();
  for (const change of [{ expectedDeviceObservationId: randomUUID() }, { deviceId: randomUUID() }, { processTerminationConfirmed: false }, { note: '' }]) {
    const request = f.acknowledge(unknown); Object.assign(request.params, change);
    if ('processTerminationConfirmed' in change || 'note' in change) await assert.rejects(f.hardware.handle(request), { code: 'INVALID_REQUEST' });
    else assert.ok((await f.hardware.handle(request)).error);
    assert.equal(f.hardware.devices.status(f.device.observation.deviceId)[0].state, 'outcome-unknown');
  }
  const staleRevision = { ...f.acknowledge(unknown), expectedProjectRevision: 2 }; assert.equal((await f.hardware.handle(staleRevision)).error?.code, 'REVISION_CONFLICT');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), receipt: OperationReceipt = { schemaVersion: 1, operationId: randomUUID(), requestId: randomUUID(), projectId: f.project.projectId, kind: 'compile', status: 'queued', expectedProjectRevision: 1, createdAt: new Date().toISOString(), tool: { name: 'synthetic-held-job', version: '1' }, artifacts: [] };
  f.project.jobs.submit({ receipt, payload: { synthetic: true }, execute: async () => { await held; } });
  try { assert.equal((await f.hardware.handle(f.acknowledge(unknown))).error?.code, 'DEVICE_BUSY'); }
  finally { release(); await f.project.jobs.wait(receipt.operationId); }
  assert.equal(f.hardware.devices.status(f.device.observation.deviceId)[0].state, 'outcome-unknown'); assert.equal(f.transport.connections.length, 0);
});

test('an owned subprocess or serial handle prevents acknowledgement until termination is observed', { timeout: 15_000 }, async t => {
  const f = await fixture(t), unknown = f.interrupted(), marker = join(f.directory, 'started');
  const controller = new AbortController();
  const running = f.project.runner.run({ executable: process.execPath, args: ['-e', "require('node:fs').writeFileSync(process.argv[1], 'ready');setInterval(()=>{},1000)", marker], cwd: f.root, signal: controller.signal });
  try {
    for (let attempt = 0; !existsSync(marker) && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(existsSync(marker)); assert.equal(f.project.runner.isIdle, false); assert.equal((await f.hardware.handle(f.acknowledge(unknown))).error?.code, 'DEVICE_BUSY');
  } finally { controller.abort(); await running; }
  assert.equal(f.project.runner.isIdle, true);
  result(await f.hardware.handle(f.acknowledge(unknown)));
  const active = await f.hardware.devices.monitor({ deviceId: f.device.observation.deviceId, expectedDeviceObservationId: f.device.observation.observationId, baudRate: 9600 }, () => {});
  const later = f.interrupted();
  try { assert.equal((await f.hardware.handle(f.acknowledge(later))).error?.code, 'DEVICE_BUSY'); }
  finally { await active.close(); }
  assert.equal(f.hardware.devices.status(f.device.observation.deviceId)[0].state, 'outcome-unknown');
  result(await f.hardware.handle(f.acknowledge(later))); assert.deepEqual(f.project.store.getOperation(f.project.projectId, later.operationId), later);
});

test('every unknown upload requires its own acknowledgement; later uncertainty is never cleared by older history', async t => {
  const f = await fixture(t), first = f.interrupted(), second = f.interrupted();
  result(await f.hardware.handle(f.acknowledge(first))); assert.equal(f.hardware.devices.status(f.device.observation.deviceId)[0].state, 'outcome-unknown');
  assert.equal((await f.restart()).state, 'outcome-unknown');
  result(await f.hardware.handle(f.acknowledge(second))); assert.equal((await f.hardware.discover())[0].state, 'available');
  const third = f.interrupted(); assert.equal((await f.hardware.discover())[0].state, 'outcome-unknown');
  assert.deepEqual(f.project.store.getOperation(f.project.projectId, first.operationId), first); assert.deepEqual(f.project.store.getOperation(f.project.projectId, second.operationId), second); assert.deepEqual(f.project.store.getOperation(f.project.projectId, third.operationId), third); assert.equal(f.transport.connections.length, 0);
});

test('failed acknowledgement persistence retains the reservation and missing completion is never silently repeated', async t => {
  const f = await fixture(t), unknown = f.interrupted(), request = f.acknowledge(unknown);
  request.params.note = 'API_KEY="synthetic-private-value-123456789"';
  assert.equal((await f.hardware.handle(request)).error?.code, 'INVALID_REQUEST'); assert.equal(f.hardware.devices.status(f.device.observation.deviceId)[0].state, 'outcome-unknown');
  const admitted = f.acknowledge(unknown); f.project.store.admitRequest(f.project.projectId, admitted.requestId, admitted);
  assert.equal((await f.hardware.handle(admitted)).error?.code, 'OUTCOME_UNKNOWN'); assert.deepEqual(f.project.store.getOperation(f.project.projectId, unknown.operationId), unknown);
});

test('device disconnect finalizes retained partial capture promptly rather than claiming the requested duration completed', { timeout: 15_000 }, async t => {
  const f = await fixture(t), request = f.request('serial.capture', { deviceId: f.device.observation.deviceId, baudRate: 9600, durationMs: 60000 });
  const capture = result<OperationReceipt>(await f.hardware.handle(request));
  for (let attempt = 0; f.hardware.devices.status(f.device.observation.deviceId)[0].state !== 'monitoring' && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.hardware.devices.status(f.device.observation.deviceId)[0].state, 'monitoring');
  const bytes = Buffer.from('range:17\n'); f.transport.emit('COM41', bytes); const started = Date.now(); f.transport.disconnect('COM41', new WorkbenchError('DEVICE_BUSY', 'Synthetic physical removal boundary.'));
  const terminal = await f.project.jobs.wait(capture.operationId); assert.equal(terminal.status, 'failed'); assert.equal(terminal.error?.code, 'CAPTURE_FAILED'); assert.ok(Date.now() - started < 3000);
  const [recording] = f.project.store.listRecords<StoredRecording>('recordings', f.project.projectId); assert.equal(recording.status, 'failed'); assert.equal(recording.rawBytes, bytes.length); assert.equal(recording.error?.code, 'DEVICE_DISCONNECTED'); assert.equal(recording.gaps.filter(gap => gap.cause === 'disconnect').length, 1);
  const raw = result<{ bytesBase64: string }>(await f.hardware.handle(f.request('recording.query', { recordingId: recording.recordingId, range: { startMs: 0, endMs: 60000, timeBasis: 'host-receive' } }))); assert.deepEqual(Buffer.from(raw.bytesBase64, 'base64'), bytes);
  assert.equal(f.transport.connections.length, 1); assert.equal(f.hardware.liveRecordings().length, 0);
});

test('explicit current selection recovers released external contention without probing or assuming port availability', async t => {
  const f = await fixture(t); f.transport.failOpen = new WorkbenchError('DEVICE_BUSY', 'Synthetic external owner.');
  const rejected = result<OperationReceipt>(await f.hardware.handle(f.request('serial.capture', { deviceId: f.device.observation.deviceId, baudRate: 9600, durationMs: 1000 })));
  assert.equal((await f.project.jobs.wait(rejected.operationId)).status, 'failed'); assert.equal(f.hardware.devices.status(f.device.observation.deviceId)[0].state, 'blocked');
  assert.equal((await f.hardware.handle(f.request('device.select', { deviceId: f.device.observation.deviceId, expectedDeviceObservationId: randomUUID() }))).error?.code, 'TARGET_AMBIGUOUS');
  const selected = result<{ state: string }>(await f.hardware.handle(f.request('device.select', { deviceId: f.device.observation.deviceId, expectedDeviceObservationId: f.device.observation.observationId })));
  assert.equal(selected.state, 'available'); assert.equal(f.transport.connections.length, 0);
  // Selection is not a port-open probe; the still-external owner must fail again explicitly.
  const stillBusy = result<OperationReceipt>(await f.hardware.handle(f.request('serial.capture', { deviceId: f.device.observation.deviceId, baudRate: 9600, durationMs: 1000 })));
  assert.equal((await f.project.jobs.wait(stillBusy.operationId)).status, 'failed');
  f.transport.failOpen = undefined;
  result(await f.hardware.handle(f.request('device.select', { deviceId: f.device.observation.deviceId, expectedDeviceObservationId: f.device.observation.observationId })));
  const recovered = result<OperationReceipt>(await f.hardware.handle(f.request('serial.capture', { deviceId: f.device.observation.deviceId, baudRate: 9600, durationMs: 60000 })));
  for (let attempt = 0; f.hardware.devices.status(f.device.observation.deviceId)[0].state !== 'monitoring' && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.hardware.devices.status(f.device.observation.deviceId)[0].state, 'monitoring'); f.transport.emit('COM41', Buffer.from('recovered counter:1\n')); f.project.jobs.requestCancel(f.project.projectId, recovered.operationId); const complete = await f.project.jobs.wait(recovered.operationId); assert.equal(complete.status, 'cancelled'); assert.equal(f.transport.connections.length, 1);
});
