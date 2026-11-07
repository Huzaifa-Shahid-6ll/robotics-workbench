import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { canonicalTransportPath, DeviceCoordinator, type DeviceObservation } from '../src/index';
import { FakeSerialTransport } from '../../test-fixtures/devices/fake-serial';

function observation(path = 'COM3'): DeviceObservation {
  return { deviceId: randomUUID(), observationId: randomUUID(), transportPath: path,
    observedAt: new Date().toISOString(), connected: true, identityStatus: 'identified', identity: { serialNumber: randomUUID() } };
}
function request(value: DeviceObservation) { return { deviceId: value.deviceId, expectedDeviceObservationId: value.observationId, baudRate: 9600 }; }
function upload(value: DeviceObservation) { return { ...request(value), resumeMonitoring: true, validate: () => {} }; }
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

test('restored unknown outcome reserves the physical path before any new handle opens', async () => {
  const transport = new FakeSerialTransport(), coordinator = new DeviceCoordinator(transport), prior = observation('COM7');
  coordinator.observe({ ...prior, connected: false }); coordinator.markOutcomeUnknown(prior.deviceId);
  const replacement = observation('COM7'); coordinator.observe(replacement);
  await assert.rejects(coordinator.withUpload(upload(replacement), async () => {}), { code: 'DEVICE_BUSY' });
  assert.equal(transport.connections.length, 0);
  await coordinator.shutdown();
});

test('canonical COM aliases share one resource and malformed device facts fail before opening', () => {
  assert.equal(canonicalTransportPath('com30'), 'COM30');
  assert.equal(canonicalTransportPath('\\\\.\\COM30'), 'COM30');
  for (const path of ['COM03', 'COM0', 'COM3 ', '/dev/ttyUSB0', '//./COM3', 'COM3:']) assert.throws(() => canonicalTransportPath(path));
  const transport = new FakeSerialTransport(); const coordinator = new DeviceCoordinator(transport);
  const value = observation(); coordinator.observe(value);
  const snapshot = coordinator.status(value.deviceId)[0]; snapshot.observation.identity!.serialNumber = 'changed';
  assert.notEqual(coordinator.status(value.deviceId)[0].observation.identity!.serialNumber, 'changed');
  assert.throws(() => coordinator.observe({ ...value, transportPath: 'COM4' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => coordinator.observe({ ...value, observationId: randomUUID(), identity: { token: 'secret' } } as any), { code: 'INVALID_REQUEST' });
  assert.equal(transport.connections.length, 0);
});

test('separate subscriptions share one handle even with the same callback; failed listener is isolated', async () => {
  const transport = new FakeSerialTransport(); const coordinator = new DeviceCoordinator(transport); const value = observation(); coordinator.observe(value);
  const seen: number[] = []; const listener = (bytes: Uint8Array) => { seen.push(bytes[0]); bytes[0] = 99; };
  const [first, second] = await Promise.all([coordinator.monitor(request(value), listener), coordinator.monitor(request(value), listener)]);
  const failed = await coordinator.monitor(request(value), () => { throw Error('Synthetic capture sink failed.'); });
  assert.equal(transport.connections.length, 1);
  transport.emit('COM3', new Uint8Array([7])); assert.deepEqual(seen, [7, 7]);
  await first.close(); transport.emit('COM3', new Uint8Array([8])); assert.deepEqual(seen, [7, 7, 8]);
  assert.equal(transport.connection('COM3').closed, false);
  await second.close(); await failed.close();
  assert.equal(transport.connections[0].closed, true);
  assert.equal(coordinator.status(value.deviceId)[0].state, 'blocked');
});

test('upload waits for actual close, excludes concurrent opens/uploads and resumes one stream', async () => {
  const transport = new FakeSerialTransport(true); const coordinator = new DeviceCoordinator(transport); const value = observation(); coordinator.observe(value);
  const subscriber = await coordinator.monitor(request(value), () => {});
  const original = transport.connection('COM3'); let executed = false;
  const pending = coordinator.withUpload(upload(value), async selected => { executed = true; assert.equal(selected.observationId, value.observationId); assert.equal(original.closed, true); return 'adapter-observed-result'; });
  await original.closeStarted;
  assert.equal(executed, false); assert.equal(coordinator.status(value.deviceId)[0].state, 'releasing-monitor');
  await assert.rejects(coordinator.monitor(request(value), () => {}), { code: 'DEVICE_BUSY' });
  await assert.rejects(coordinator.withUpload(upload(value), async () => { throw Error('Forbidden second uploader.'); }), { code: 'DEVICE_BUSY' });
  transport.finishPendingCloses();
  assert.equal(await pending, 'adapter-observed-result');
  assert.equal(transport.connections.length, 2); assert.equal(coordinator.status(value.deviceId)[0].state, 'monitoring');
  await subscriber.close(); await coordinator.shutdown();
});

test('two device aliases cannot obtain competing handles or uploader leases', async () => {
  const transport = new FakeSerialTransport(); const coordinator = new DeviceCoordinator(transport); const first = observation(), alias = observation('\\\\.\\com3');
  coordinator.observe(first); coordinator.observe(alias);
  const monitor = await coordinator.monitor(request(first), () => {});
  await assert.rejects(coordinator.monitor(request(alias), () => {}), { code: 'DEVICE_BUSY' });
  await assert.rejects(coordinator.withUpload(upload(alias), async () => {}), { code: 'DEVICE_BUSY' });
  assert.equal(transport.connections.length, 1);
  await monitor.close(); coordinator.reconcile(alias.deviceId, alias.observationId);
  await coordinator.withUpload({ ...upload(alias), resumeMonitoring: false }, async () => {});
  await coordinator.shutdown();
});

test('changed observation during monitor release blocks the original upload rather than substituting a target', async () => {
  const transport = new FakeSerialTransport(true); const coordinator = new DeviceCoordinator(transport); const value = observation(); coordinator.observe(value);
  await coordinator.monitor(request(value), () => {}); const connection = transport.connection('COM3'); let uploads = 0;
  const pending = coordinator.withUpload(upload(value), async () => { uploads++; });
  await connection.closeStarted;
  const changed = { ...value, observationId: randomUUID(), transportPath: 'COM4' }; coordinator.observe(changed);
  transport.finishPendingCloses();
  await assert.rejects(pending, { code: 'TARGET_AMBIGUOUS' });
  assert.equal(uploads, 0); assert.equal(coordinator.status(value.deviceId)[0].state, 'blocked');
  assert.equal(transport.connections.length, 1);
  coordinator.reconcile(changed.deviceId, changed.observationId); await coordinator.shutdown();
});

test('preflight revalidation can reject changed artifact intent after a confirmed serial release', async () => {
  const transport = new FakeSerialTransport(true); const coordinator = new DeviceCoordinator(transport); const value = observation(); coordinator.observe(value);
  await coordinator.monitor(request(value), () => {}); const connection = transport.connection('COM3'); let currentArtifact = true, uploads = 0;
  const pending = coordinator.withUpload({ ...upload(value), validate: () => { if (!currentArtifact) throw Object.assign(Error('Artifact changed.'), { code: 'ARTIFACT_MISMATCH' }); } }, async () => { uploads++; });
  await connection.closeStarted; currentArtifact = false; transport.finishPendingCloses();
  await assert.rejects(pending, /Artifact changed/); assert.equal(uploads, 0);
  assert.equal(coordinator.status(value.deviceId)[0].state, 'monitoring');
  await coordinator.shutdown();
});

test('preflight rejection before releasing monitoring leaves its original stream intact', async () => {
  const transport = new FakeSerialTransport(); const coordinator = new DeviceCoordinator(transport); const value = observation(); coordinator.observe(value);
  const subscriber = await coordinator.monitor(request(value), () => {});
  await assert.rejects(coordinator.withUpload({ ...upload(value), validate: () => { throw Error('Synthetic preflight failure.'); } }, async () => { throw Error('Forbidden uploader.'); }), /preflight failure/);
  assert.equal(coordinator.status(value.deviceId)[0].state, 'monitoring'); assert.equal(transport.connections.length, 1); assert.equal(transport.connections[0].closed, false);
  await subscriber.close(); await coordinator.shutdown();
});

test('late close acknowledgement releases reservation but leaves explicit reconciliation required', async () => {
  const transport = new FakeSerialTransport(true); const coordinator = new DeviceCoordinator(transport, { closeTimeoutMs: 10 }); const value = observation(), alias = observation('com3');
  coordinator.observe(value); coordinator.observe(alias); await coordinator.monitor(request(value), () => {});
  let uploads = 0;
  await assert.rejects(coordinator.withUpload(upload(value), async () => { uploads++; }), { code: 'TIMEOUT' });
  assert.equal(uploads, 0); assert.equal(coordinator.status(value.deviceId)[0].state, 'blocked');
  await assert.rejects(coordinator.withUpload(upload(alias), async () => { uploads++; }), { code: 'DEVICE_BUSY' });
  transport.finishPendingCloses(); await coordinator.stopMonitoring(value.deviceId);
  assert.equal(coordinator.status(value.deviceId)[0].state, 'blocked');
  coordinator.reconcile(value.deviceId, value.observationId);
  assert.equal(coordinator.status(value.deviceId)[0].state, 'available'); await coordinator.shutdown();
});

test('unclassified lost upload effects stay unknown and never auto-reopen monitoring', async () => {
  const transport = new FakeSerialTransport(); const coordinator = new DeviceCoordinator(transport); const value = observation(); coordinator.observe(value);
  await coordinator.monitor(request(value), () => {});
  await assert.rejects(coordinator.withUpload(upload(value), async () => { throw Error('Synthetic connection lost after effect.'); }), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(coordinator.status(value.deviceId)[0].state, 'outcome-unknown'); assert.equal(transport.connections.length, 1);
  const fresh = { ...value, observationId: randomUUID() }; coordinator.observe(fresh);
  assert.equal(coordinator.status(value.deviceId)[0].state, 'outcome-unknown');
  await assert.rejects(coordinator.withUpload(upload(fresh), async () => {}), { code: 'DEVICE_BUSY' });
  coordinator.reconcile(fresh.deviceId, fresh.observationId); assert.equal(coordinator.status(value.deviceId)[0].state, 'available');
  await coordinator.shutdown();
});

test('unknown upload retains the canonical port reservation across another device alias until explicit reconciliation', async () => {
  const transport = new FakeSerialTransport(); const coordinator = new DeviceCoordinator(transport); const value = observation(), alias = observation('\\\\.\\com3'); coordinator.observe(value); coordinator.observe(alias);
  await assert.rejects(coordinator.withUpload(upload(value), async () => { throw Error('Unobserved uploader termination.'); }), { code: 'OUTCOME_UNKNOWN' });
  await assert.rejects(coordinator.withUpload(upload(alias), async () => { throw Error('Forbidden alias bypass.'); }), { code: 'DEVICE_BUSY' });
  await assert.rejects(coordinator.monitor(request(alias), () => {}), { code: 'DEVICE_BUSY' });
  coordinator.reconcile(value.deviceId, value.observationId);
  await coordinator.withUpload({ ...upload(alias), resumeMonitoring: false }, async () => 'new explicitly admitted operation');
  await coordinator.shutdown();
});

test('independent device uploads are not forced into one serial lease', async () => {
  const transport = new FakeSerialTransport(); const coordinator = new DeviceCoordinator(transport); const first = observation('COM3'), second = observation('COM4'); coordinator.observe(first); coordinator.observe(second);
  const barrier = deferred(); const one = deferred(), two = deferred();
  const firstUpload = coordinator.withUpload(upload(first), async () => { one.resolve(); await barrier.promise; });
  const secondUpload = coordinator.withUpload(upload(second), async () => { two.resolve(); await barrier.promise; });
  await Promise.all([one.promise, two.promise]); barrier.resolve(); await Promise.all([firstUpload, secondUpload]);
  assert.equal(coordinator.status().every(snapshot => snapshot.state === 'available'), true); await coordinator.shutdown();
});

test('external contention and unexpected disconnect remain blocked with no synthetic success', async () => {
  const transport = new FakeSerialTransport(); const coordinator = new DeviceCoordinator(transport); const value = observation(); coordinator.observe(value);
  transport.failOpen = Error('Synthetic external holder.');
  await assert.rejects(coordinator.monitor(request(value), () => {}), { code: 'DEVICE_BUSY' });
  assert.equal(coordinator.status(value.deviceId)[0].state, 'blocked');
  transport.failOpen = undefined; coordinator.reconcile(value.deviceId, value.observationId);
  await coordinator.monitor(request(value), () => {}); transport.disconnect('COM3'); await coordinator.stopMonitoring(value.deviceId);
  assert.equal(coordinator.status(value.deviceId)[0].state, 'blocked'); assert.equal(transport.connections.length, 1);
  await coordinator.shutdown();
});

test('shutdown during asynchronous preflight cannot launch a new external upload', async () => {
  const transport = new FakeSerialTransport(); const coordinator = new DeviceCoordinator(transport); const value = observation(); coordinator.observe(value);
  const ready = deferred(), proceed = deferred(); let uploads = 0;
  const pending = coordinator.withUpload({ ...upload(value), validate: async () => { ready.resolve(); await proceed.promise; } }, async () => { uploads++; });
  await ready.promise; await coordinator.shutdown(); proceed.resolve();
  await assert.rejects(pending, { code: 'DEVICE_BUSY' }); assert.equal(uploads, 0);
  await assert.rejects(coordinator.monitor(request(value), () => {}), { code: 'DEVICE_BUSY' });
});

test('disconnect during asynchronous preflight remains blocked and cannot launch the uploader', async () => {
  const transport = new FakeSerialTransport(); const coordinator = new DeviceCoordinator(transport); const value = observation(); coordinator.observe(value);
  await coordinator.monitor(request(value), () => {});
  const ready = deferred(), proceed = deferred(); let uploads = 0;
  const pending = coordinator.withUpload({ ...upload(value), validate: async () => { ready.resolve(); await proceed.promise; } }, async () => { uploads++; });
  await ready.promise; transport.disconnect('COM3', Error('Synthetic preflight disconnect.')); proceed.resolve();
  await assert.rejects(pending, { code: 'DEVICE_BUSY' });
  assert.equal(uploads, 0); assert.equal(coordinator.status(value.deviceId)[0].state, 'blocked');
  assert.equal(transport.connections.length, 1); await coordinator.shutdown();
});

test('disconnect during monitor release is blocked without claiming uncertain uploader effects', async () => {
  const transport = new FakeSerialTransport(true); const coordinator = new DeviceCoordinator(transport); const value = observation(); coordinator.observe(value);
  await coordinator.monitor(request(value), () => {}); const connection = transport.connection('COM3'); let uploads = 0;
  const pending = coordinator.withUpload(upload(value), async () => { uploads++; });
  await connection.closeStarted; transport.disconnect('COM3', Error('Synthetic release disconnect.'));
  await assert.rejects(pending, { code: 'DEVICE_BUSY' });
  assert.equal(uploads, 0); assert.equal(coordinator.status(value.deviceId)[0].state, 'blocked');
  assert.equal(transport.connections.length, 1); await coordinator.shutdown();
});
