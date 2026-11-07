import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JobCoordinator } from '../src/jobs/index';
import { WorkbenchStore } from '@robotics-workbench/persistence';
import { WorkbenchError, type OperationReceipt } from '@robotics-workbench/contracts';

function gate<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-jobs-')); const root = join(directory, 'project'); mkdirSync(root);
  const store = new WorkbenchStore(join(directory, 'data')); const projectId = randomUUID();
  store.registerProject({ projectId, root, projectRevision: 1, manifestSha256: 'a'.repeat(64) });
  const jobs = new JobCoordinator(store);
  t.after(async () => { await jobs.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const receipt = (kind: OperationReceipt['kind'] = 'compile'): OperationReceipt => ({ schemaVersion: 1, operationId: randomUUID(), requestId: randomUUID(), projectId, kind, status: 'queued',
    expectedProjectRevision: 1, createdAt: new Date().toISOString(), tool: { name: 'synthetic-no-device', version: 'fixture-1' }, artifacts: [],
    ...(kind === 'upload' ? { deviceId: randomUUID(), sourceSnapshotId: randomUUID() } : {}) });
  return { store, jobs, projectId, receipt };
}

test('admission is durable and queued, duplicate requests execute once, and heavy jobs serialize', async t => {
  const { store, jobs, projectId, receipt } = fixture(t); const entered = gate(), release = gate(); let executions = 0;
  const first = receipt();
  assert.equal(jobs.submit({ receipt: first, payload: { task: 'first' }, execute: async () => { executions++; entered.resolve(); await release.promise; } }).status, 'queued');
  assert.equal(store.getOperation(projectId, first.operationId).status, 'queued');
  const second = receipt();
  jobs.submit({ receipt: second, payload: { task: 'second' }, execute: async () => { executions++; } });
  assert.equal(jobs.submit({ receipt: { ...first, operationId: randomUUID() }, payload: { task: 'first' }, execute: async () => { executions += 100; } }).operationId, first.operationId);
  await entered.promise;
  assert.equal(executions, 1); assert.equal(store.getOperation(projectId, second.operationId).status, 'queued');
  release.resolve();
  assert.equal((await jobs.wait(first.operationId)).status, 'succeeded');
  assert.equal((await jobs.wait(second.operationId)).status, 'succeeded'); assert.equal(executions, 2);
});

test('preflight revalidates frozen queued target before any effect and never substitutes a new target', async t => {
  const { jobs, receipt } = fixture(t); const entered = gate(), release = gate(); let target = 'original'; let effects = 0;
  const blocker = receipt(); jobs.submit({ receipt: blocker, payload: {}, execute: async () => { entered.resolve(); await release.promise; } });
  const upload = receipt('upload'); const original = target;
  jobs.submit({ receipt: upload, payload: { target: original }, heavy: true, preflight: () => { if (target !== original) throw new WorkbenchError('TARGET_AMBIGUOUS', 'Frozen target changed.'); }, execute: async () => { effects++; } });
  await entered.promise; target = 'replacement'; release.resolve();
  const result = await jobs.wait(upload.operationId); assert.equal(result.status, 'failed'); assert.equal(result.error?.code, 'TARGET_AMBIGUOUS'); assert.equal(effects, 0);
});

test('cancel acknowledgement stays running until termination settles; interrupted upload is immutable unknown', async t => {
  const { jobs, store, projectId, receipt } = fixture(t);
  for (const kind of ['compile', 'upload'] as const) {
    const entered = gate(), stopRequested = gate(), terminated = gate(); const input = receipt(kind);
    jobs.submit({ receipt: input, payload: { kind }, execute: async ({ signal }) => { entered.resolve(); await new Promise<void>(resolve => signal.addEventListener('abort', () => { stopRequested.resolve(); resolve(); }, { once: true })); await terminated.promise; } });
    await entered.promise;
    assert.equal(jobs.requestCancel(projectId, input.operationId).status, 'running'); await stopRequested.promise;
    assert.equal(store.getOperation(projectId, input.operationId).status, 'running'); terminated.resolve();
    const result = await jobs.wait(input.operationId); assert.equal(result.status, kind === 'upload' ? 'outcome-unknown' : 'cancelled');
    assert.equal(jobs.requestCancel(projectId, input.operationId).status, result.status);
    assert.throws(() => store.transitionOperation(projectId, input.operationId, 'succeeded'), { code: 'INVALID_REQUEST' });
  }
});

test('queued cancellation and cancellation during preflight never execute the job', async t => {
  const { jobs, projectId, receipt } = fixture(t); const entered = gate(), release = gate(); let effects = 0;
  const input = receipt(); jobs.submit({ receipt: input, payload: {}, preflight: async () => { entered.resolve(); await release.promise; }, execute: async () => { effects++; } });
  await entered.promise; assert.equal(jobs.requestCancel(projectId, input.operationId).status, 'cancelled'); release.resolve();
  assert.equal((await jobs.wait(input.operationId)).status, 'cancelled'); assert.equal(effects, 0);
});

test('shutdown cancels queued work and waits for active work; new admissions are refused', async t => {
  const { jobs, receipt } = fixture(t); const entered = gate(); let secondEffects = 0;
  const first = receipt(), second = receipt();
  jobs.submit({ receipt: first, payload: {}, execute: async ({ signal }) => { entered.resolve(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); } });
  jobs.submit({ receipt: second, payload: {}, execute: async () => { secondEffects++; } });
  await entered.promise; assert.equal(jobs.isIdle, false); await jobs.shutdown();
  assert.equal((await jobs.wait(first.operationId)).status, 'cancelled'); assert.equal((await jobs.wait(second.operationId)).status, 'cancelled');
  assert.equal(secondEffects, 0); assert.equal(jobs.isIdle, true);
  assert.throws(() => jobs.submit({ receipt: receipt(), payload: {}, execute: async () => {} }), { code: 'DEVICE_BUSY' });
});

test('fresh coordinator reconciles previous unknown effects and queued jobs without replay', t => {
  const { store, projectId, receipt } = fixture(t); const running = receipt('upload'), queued = receipt('upload');
  store.createOperation(running, {}); store.transitionOperation(projectId, running.operationId, 'running'); store.createOperation(queued, {});
  const restarted = new JobCoordinator(store);
  assert.equal(restarted.isIdle, true); assert.equal(store.getOperation(projectId, running.operationId).status, 'outcome-unknown');
  assert.equal(store.getOperation(projectId, queued.operationId).status, 'cancelled');
});

test('every delayed job checks the current project revision even without a custom preflight', async t => {
  const { jobs, store, projectId, receipt } = fixture(t); const entered = gate(), release = gate(); let effects = 0;
  jobs.submit({ receipt: receipt(), payload: { blocker: true }, execute: async () => { entered.resolve(); await release.promise; } });
  const queued = receipt(); jobs.submit({ receipt: queued, payload: { queued: true }, execute: async () => { effects++; } });
  await entered.promise; store.updateProject(projectId, 2, 'b'.repeat(64)); release.resolve();
  const result = await jobs.wait(queued.operationId); assert.equal(result.status, 'failed'); assert.equal(result.error?.code, 'REVISION_CONFLICT'); assert.equal(effects, 0);
  assert.equal(jobs.submit({ receipt: { ...queued, operationId: randomUUID() }, payload: { queued: true }, execute: async () => { effects++; } }).operationId, queued.operationId);
  assert.equal(effects, 0);
});

test('uncertain preflight without execution is a durable failed admission, not an impossible terminal transition', async t => {
  const { jobs, store, projectId, receipt } = fixture(t); const input = receipt('upload'); let effects = 0;
  jobs.submit({ receipt: input, payload: {}, preflight: () => { throw new WorkbenchError('OUTCOME_UNKNOWN', 'An earlier observation is unresolved.'); }, execute: async () => { effects++; } });
  const result = await jobs.wait(input.operationId);
  assert.equal(result.status, 'failed'); assert.equal(result.error?.code, 'OUTCOME_UNKNOWN'); assert.equal(effects, 0);
  assert.equal(store.getOperation(projectId, input.operationId).status, 'failed'); assert.equal(jobs.isIdle, true);
  await jobs.shutdown();
});
