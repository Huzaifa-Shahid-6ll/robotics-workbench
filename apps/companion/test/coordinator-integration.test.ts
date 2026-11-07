import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { DeviceCoordinator, type DeviceObservation } from '@robotics-workbench/devices';
import { JobCoordinator, ProcessRunner } from '@robotics-workbench/application';
import { WorkbenchStore } from '@robotics-workbench/persistence';
import { WorkbenchError, type OperationReceipt } from '@robotics-workbench/contracts';
import { FakeSerialTransport } from '../../../packages/test-fixtures/devices/fake-serial';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function observation(): DeviceObservation {
  return { deviceId: randomUUID(), observationId: randomUUID(), transportPath: 'COM7', observedAt: new Date().toISOString(),
    connected: true, identityStatus: 'identified', identity: { serialNumber: 'synthetic-only' } };
}

function receipt(projectId: string, kind: 'compile' | 'upload' = 'compile', deviceId?: string): OperationReceipt {
  return { schemaVersion: 1, operationId: randomUUID(), requestId: randomUUID(), projectId, kind, status: 'queued',
    expectedProjectRevision: 1, createdAt: new Date().toISOString(), tool: { name: 'synthetic-no-device', version: 'fixture-1' }, artifacts: [],
    ...(kind === 'upload' ? { deviceId, sourceSnapshotId: randomUUID() } : {}) };
}

function fixture(t: TestContext, delayedClose = false) {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-coordinator-'));
  const root = join(directory, 'ordinary project'); mkdirSync(root);
  const store = new WorkbenchStore(join(directory, 'data'));
  const projectId = randomUUID();
  store.registerProject({ projectId, root, projectRevision: 1, manifestSha256: createHash('sha256').update('synthetic manifest').digest('hex') });
  const jobs = new JobCoordinator(store);
  const transport = new FakeSerialTransport(delayedClose);
  const devices = new DeviceCoordinator(transport);
  t.after(async () => {
    transport.finishPendingCloses();
    await jobs.shutdown(); await devices.shutdown(); store.close();
    assert.ok(!relative(tmpdir(), directory).startsWith('..'));
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, root, projectId, store, jobs, transport, devices };
}

async function syntheticOwner(): Promise<void> {
  const [root, dataRoot, projectId, deviceId, observationId, requestId, sourceSnapshotId, marker] = process.argv.slice(process.argv.indexOf('--synthetic-upload-owner') + 1);
  const store = new WorkbenchStore(dataRoot);
  const jobs = new JobCoordinator(store);
  const devices = new DeviceCoordinator(new FakeSerialTransport());
  setInterval(() => {}, 1000);
  devices.observe({ deviceId, observationId, transportPath: 'COM7', observedAt: new Date().toISOString(), connected: true, identityStatus: 'identified' });
  jobs.submit({ receipt: { ...receipt(projectId, 'upload', deviceId), requestId, sourceSnapshotId }, payload: { fixture: 'owned-process-loss', deviceId, sourceSnapshotId },
    execute: () => devices.withUpload({ deviceId, expectedDeviceObservationId: observationId, resumeMonitoring: false, validate: () => {} }, async () => {
      writeFileSync(marker, 'one synthetic effect; no physical device');
      process.send!({ started: true, root });
      await new Promise<void>(() => {});
      return {};
    }) });
}

if (process.argv.includes('--synthetic-upload-owner')) {
  void syntheticOwner().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
} else {
  test('AC-D19-01: durable upload waits for actual monitor close; retry cannot duplicate the effect', { timeout: 30000 }, async t => {
    const { projectId, store, jobs, transport, devices } = fixture(t, true);
    const observed = observation(); devices.observe(observed);
    const first: number[] = [], second: number[] = [];
    await devices.monitor({ deviceId: observed.deviceId, expectedDeviceObservationId: observed.observationId, baudRate: 9600 }, bytes => first.push(...bytes));
    await devices.monitor({ deviceId: observed.deviceId, expectedDeviceObservationId: observed.observationId, baudRate: 9600 }, bytes => second.push(...bytes));
    transport.emit('COM7', new Uint8Array([1]));
    assert.equal(transport.connections.length, 1);
    const connection = transport.connection('COM7');
    const intent = receipt(projectId, 'upload', observed.deviceId);
    let effects = 0;
    const input = { receipt: intent, payload: { fixture: 'exact identified synthetic upload', deviceId: observed.deviceId },
      execute: () => devices.withUpload({ deviceId: observed.deviceId, expectedDeviceObservationId: observed.observationId, resumeMonitoring: true, validate: () => {} }, async () => {
        effects++; transport.trace.push('uploader-started'); return { result: { simulated: true } };
      }) };
    const admitted = jobs.submit(input);
    await connection.closeStarted;
    assert.equal(effects, 0); assert.notEqual(store.getOperation(projectId, admitted.operationId).status, 'succeeded');
    const duplicate = jobs.submit({ ...input, receipt: { ...intent, operationId: randomUUID() } });
    assert.equal(duplicate.operationId, admitted.operationId);
    transport.releaseClose('COM7');
    assert.equal((await jobs.wait(admitted.operationId)).status, 'succeeded');
    assert.equal(effects, 1);
    assert.ok(transport.trace.indexOf('close:COM7') < transport.trace.indexOf('uploader-started'));
    transport.emit('COM7', new Uint8Array([2]));
    assert.deepEqual(first, [1, 2]); assert.deepEqual(second, [1, 2]);
    assert.equal(transport.connections.length, 2, 'One explicit reconnect after upload.');
  });

  for (const change of ['device', 'artifact'] as const) test(`AC-D19-06: queued upload rejects changed ${change} without target substitution`, { timeout: 30000 }, async t => {
    const { projectId, store, jobs, devices } = fixture(t);
    const observed = observation(); devices.observe(observed);
    const blockerStarted = deferred(), release = deferred();
    const blocker = jobs.submit({ receipt: receipt(projectId), payload: { fixture: 'heavy queue blocker' }, heavy: true,
      execute: async () => { blockerStarted.resolve(); await release.promise; return {}; } });
    await blockerStarted.promise;
    const artifact = store.storeArtifact(projectId, Buffer.from('first exact artifact'), 'application/octet-stream');
    let selectedDigest = artifact.sha256;
    let effects = 0;
    const intent = receipt(projectId, 'upload', observed.deviceId);
    const upload = jobs.submit({ receipt: intent, heavy: true, payload: { artifactId: artifact.artifactId, artifactSha256: artifact.sha256,
      deviceId: observed.deviceId, expectedDeviceObservationId: observed.observationId },
      preflight: () => { if (selectedDigest !== artifact.sha256) throw new WorkbenchError('ARTIFACT_MISMATCH', 'Selected build changed.'); },
      execute: () => devices.withUpload({ deviceId: observed.deviceId, expectedDeviceObservationId: observed.observationId, resumeMonitoring: false, validate: () => {} }, async () => {
        effects++; assert.equal(store.readArtifact(projectId, artifact.artifactId).toString(), 'first exact artifact'); return {};
      }) });
    if (change === 'device') devices.observe({ ...observed, observationId: randomUUID(), transportPath: 'COM8' });
    else selectedDigest = store.storeArtifact(projectId, Buffer.from('new unrelated artifact'), 'application/octet-stream').sha256;
    release.resolve(); await jobs.wait(blocker.operationId);
    const terminal = await jobs.wait(upload.operationId);
    assert.equal(terminal.status, 'failed'); assert.equal(effects, 0);
    assert.equal(terminal.error?.code, change === 'device' ? 'TARGET_AMBIGUOUS' : 'ARTIFACT_MISMATCH');
  });

  test('a delayed job revalidates the durable project revision even without a caller preflight', { timeout: 30000 }, async t => {
    const { projectId, store, jobs } = fixture(t);
    const started = deferred(), release = deferred();
    const blocker = jobs.submit({ receipt: receipt(projectId), payload: { fixture: 'revision queue blocker' }, heavy: true,
      execute: async () => { started.resolve(); await release.promise; return {}; } });
    await started.promise;
    let effects = 0;
    const delayed = jobs.submit({ receipt: receipt(projectId), payload: { fixture: 'must not use stale accepted design' }, heavy: true,
      execute: async () => { effects++; return {}; } });
    store.updateProject(projectId, 2, 'b'.repeat(64));
    release.resolve(); await jobs.wait(blocker.operationId);
    const terminal = await jobs.wait(delayed.operationId);
    assert.equal(terminal.status, 'failed'); assert.equal(terminal.error?.code, 'REVISION_CONFLICT'); assert.equal(effects, 0);
  });

  test('AC-D19-02: cancellation acknowledgement does not finish an unsettled operation', { timeout: 30000 }, async t => {
    const { projectId, jobs, store } = fixture(t);
    const started = deferred(), stopped = deferred(), release = deferred();
    const operation = jobs.submit({ receipt: receipt(projectId), payload: { fixture: 'delayed known termination' }, cancellable: true,
      execute: async ({ signal }) => { signal.addEventListener('abort', () => stopped.resolve(), { once: true }); started.resolve(); await release.promise; return {}; } });
    await started.promise;
    const acknowledged = jobs.requestCancel(projectId, operation.operationId);
    await stopped.promise;
    assert.equal(acknowledged.status, 'running');
    assert.equal(store.getOperation(projectId, operation.operationId).finishedAt, undefined);
    release.resolve();
    assert.equal((await jobs.wait(operation.operationId)).status, 'cancelled');
  });

  test('an uncertain synthetic uploader exception keeps device and durable operation outcomes aligned', { timeout: 30000 }, async t => {
    const { projectId, store, jobs, devices } = fixture(t);
    const observed = observation(); devices.observe(observed);
    let effects = 0;
    const intent = receipt(projectId, 'upload', observed.deviceId);
    const input = { receipt: intent, payload: { fixture: 'uncertain external upload exception' }, execute: () => devices.withUpload({
      deviceId: observed.deviceId, expectedDeviceObservationId: observed.observationId, resumeMonitoring: false, validate: () => {}
    }, async () => { effects++; throw new Error('Synthetic process channel lost after execution began.'); }) };
    const operation = jobs.submit(input);
    const terminal = await jobs.wait(operation.operationId);
    assert.equal(terminal.status, 'outcome-unknown');
    assert.equal(terminal.error?.code, 'OUTCOME_UNKNOWN');
    assert.equal(devices.status(observed.deviceId)[0].state, 'outcome-unknown');
    const duplicate = jobs.submit({ ...input, receipt: { ...intent, operationId: randomUUID() } });
    assert.deepEqual(duplicate, store.getOperation(projectId, operation.operationId));
    assert.equal(effects, 1);
  });

  test('AC-D19-03: real owning-process loss leaves one unknown receipt and never replays its synthetic effect', { timeout: 30000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-owner-loss-'));
    const root = join(directory, 'project'); mkdirSync(root); const dataRoot = join(directory, 'data');
    const projectId = randomUUID(), deviceId = randomUUID(), observationId = randomUUID(), requestId = randomUUID(), sourceSnapshotId = randomUUID();
    const marker = join(directory, 'synthetic-effect.txt');
    const initial = new WorkbenchStore(dataRoot);
    initial.registerProject({ projectId, root, projectRevision: 1, manifestSha256: 'a'.repeat(64) }); initial.close();
    const child = fork(__filename, ['--synthetic-upload-owner', root, dataRoot, projectId, deviceId, observationId, requestId, sourceSnapshotId, marker], { execArgv: [], silent: true });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
      assert.ok(!relative(tmpdir(), directory).startsWith('..')); rmSync(directory, { recursive: true, force: true });
    });
    const message = await Promise.race([once(child, 'message'), once(child, 'close').then(() => { throw new Error('Synthetic owner exited before observable execution.'); })]);
    assert.equal(message[0].started, true); assert.equal(readFileSync(marker, 'utf8'), 'one synthetic effect; no physical device');
    const closed = once(child, 'close'); child.kill(); await closed;
    assert.throws(() => process.kill(child.pid!, 0));
    const restored = new WorkbenchStore(dataRoot);
    const jobs = new JobCoordinator(restored);
    try {
      const previous = restored.getOperationByRequest(projectId, requestId);
      assert.equal(previous.status, 'outcome-unknown');
      let repeatedEffects = 0;
      const duplicate = jobs.submit({ receipt: { ...receipt(projectId, 'upload', deviceId), requestId, sourceSnapshotId },
        payload: { fixture: 'owned-process-loss', deviceId, sourceSnapshotId }, execute: async () => { repeatedEffects++; return {}; } });
      assert.equal(duplicate.operationId, previous.operationId); assert.equal(duplicate.status, 'outcome-unknown');
      await new Promise<void>(done => setImmediate(done));
      assert.equal(repeatedEffects, 0); assert.equal(restored.listOperations(projectId).length, 1);
      assert.deepEqual(restored.getOperation(projectId, previous.operationId), previous);
    } finally { await jobs.shutdown(); restored.close(); }
  });

  test('AC-D19-04/05: supervised real subprocess keeps literal arguments and bounds flooded output', { timeout: 30000 }, async t => {
    const { directory, projectId, jobs } = fixture(t);
    const fixtureDirectory = join(directory, 'path with spaces Ω & shell'); mkdirSync(fixtureDirectory);
    const executableFixture = join(fixtureDirectory, 'literal args.mjs'); copyFileSync(resolve('packages/test-fixtures/devices/subprocess.mjs'), executableFixture);
    const args = ['space argument', '日本語', '$(Write-Output synthetic)', 'a&b|c>file', 'quote"slash\\end'];
    const runner = new ProcessRunner();
    const operation = jobs.submit({ receipt: receipt(projectId), payload: { fixture: 'literal arguments' }, execute: async ({ signal }) => {
      const result = await runner.run({ executable: process.execPath, args: [executableFixture, 'argv', ...args], cwd: fixtureDirectory, signal });
      assert.equal(result.exitCode, 0); assert.deepEqual(JSON.parse(result.stdout), args); return {};
    } });
    assert.equal((await jobs.wait(operation.operationId)).status, 'succeeded');
    const flooded = await runner.run({ executable: process.execPath, args: [executableFixture, 'flood'], cwd: fixtureDirectory, maxOutputBytes: 1024 });
    assert.equal(flooded.exitCode, 0);
    assert.equal(flooded.stdoutBytes, 8 * 1024 * 1024); assert.equal(flooded.stderrBytes, 8 * 1024 * 1024);
    assert.ok(Buffer.byteLength(flooded.stdout) <= 1024 && Buffer.byteLength(flooded.stderr) <= 1024);
    assert.equal(flooded.stdoutTruncated, true); assert.equal(flooded.stderrTruncated, true);
    assert.equal(existsSync(join(fixtureDirectory, 'file')), false);
  });
}
