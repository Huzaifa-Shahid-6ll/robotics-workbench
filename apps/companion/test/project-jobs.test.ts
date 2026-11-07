import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProjectService } from '../src/project-service';
import type { OperationReceipt } from '@robotics-workbench/contracts';

test('project cancellation returns a receipt while execution stops; storage closes after reconciliation', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'workbench-project-jobs-'));
  const root = join(temp, 'project'); mkdirSync(root);
  const manifest = JSON.parse(readFileSync('examples/workbench.valid.json', 'utf8'));
  writeFileSync(join(root, 'workbench.json'), JSON.stringify(manifest));
  const service = new ProjectService(root, join(temp, 'data'));
  let started!: () => void, finish!: () => void;
  const start = new Promise<void>(resolve => { started = resolve; });
  const stopped = new Promise<void>(resolve => { finish = resolve; });
  const receipt: OperationReceipt = { schemaVersion: 1, operationId: randomUUID(), requestId: randomUUID(), projectId: manifest.projectId,
    kind: 'compile', status: 'queued', expectedProjectRevision: 1, createdAt: new Date().toISOString(),
    tool: { name: 'synthetic-no-tool', version: 'fixture' }, artifacts: [] };
  try {
    service.jobs.submit({ receipt, payload: { synthetic: true }, execute: async () => { started(); await stopped; } });
    await start;
    assert.throws(() => service.close(), { code: 'DEVICE_BUSY' });
    const cancel = { schemaVersion: 1, requestId: randomUUID(), projectId: manifest.projectId, method: 'operation.cancel', params: { operationId: receipt.operationId } };
    const response = service.handle(cancel);
    assert.equal((response.result as OperationReceipt).status, 'running');
    assert.equal((service.handle(cancel).result as OperationReceipt).operationId, receipt.operationId);
    const other = { ...receipt, operationId: randomUUID(), requestId: randomUUID() };
    service.store.createOperation(other, { synthetic: 'other' });
    assert.equal(service.handle({ ...cancel, params: { operationId: other.operationId } }).error?.code, 'REQUEST_ID_CONFLICT');
    assert.throws(() => service.store.createOperation({ ...other, requestId: cancel.requestId }, {}), { code: 'REQUEST_ID_CONFLICT' });
    const otherRoot = join(temp, 'other-project'); mkdirSync(otherRoot);
    const otherProjectId = randomUUID();
    service.store.registerProject({ projectId: otherProjectId, root: otherRoot, projectRevision: 1, manifestSha256: 'b'.repeat(64) });
    assert.throws(() => service.store.createOperation({ ...other, projectId: otherProjectId, requestId: cancel.requestId }, {}), { code: 'UNAUTHORIZED_SCOPE' });
    finish();
    assert.equal((await service.jobs.wait(receipt.operationId)).status, 'cancelled');
    assert.deepEqual(service.handle({ schemaVersion: 1, requestId: randomUUID(), projectId: manifest.projectId, method: 'device.status', params: {} }).result, []);
    await service.shutdown(); await service.shutdown();
  } finally { finish(); await service.shutdown(); rmSync(temp, { recursive: true, force: true }); }
});

test('shutdown attempts every resource even when one stop path rejects', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'workbench-stop-failure-'));
  const root = join(temp, 'project'); mkdirSync(root);
  writeFileSync(join(root, 'workbench.json'), readFileSync('examples/workbench.valid.json'));
  const service = new ProjectService(root, join(temp, 'data'));
  const attempted: string[] = [];
  service.jobs.shutdown = async () => { attempted.push('jobs'); throw new Error('synthetic stop failure'); };
  service.devices.shutdown = async () => { attempted.push('devices'); };
  service.runner.shutdown = async () => { attempted.push('runner'); };
  try {
    await assert.rejects(service.shutdown(), { code: 'OUTCOME_UNKNOWN' });
    assert.deepEqual(attempted, ['jobs', 'devices', 'runner']);
    service.close();
  } finally { service.close(); rmSync(temp, { recursive: true, force: true }); }
});
