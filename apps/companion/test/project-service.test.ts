import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProjectService } from '../src/project-service';

test('project scope and file authority survive a stale database projection', () => {
  const temp = mkdtempSync(join(tmpdir(), 'workbench-service-'));
  const root = join(temp, 'project'); mkdirSync(root);
  const manifest = JSON.parse(readFileSync('examples/workbench.valid.json', 'utf8'));
  writeFileSync(join(root, 'workbench.json'), JSON.stringify(manifest));
  const service = new ProjectService(root, join(temp, 'data'));
  const request = { schemaVersion: 1 as const, requestId: randomUUID(), projectId: manifest.projectId, method: 'project.snapshot' as const, params: {} };
  try {
    assert.ok('result' in service.handle(request));
    const operationId = randomUUID();
    service.store.createOperation({ schemaVersion: 1, projectId: manifest.projectId, operationId, requestId: randomUUID(),
      kind: 'compile', status: 'queued', expectedProjectRevision: 1, createdAt: new Date().toISOString(),
      tool: { name: 'synthetic', version: 'fixture' }, artifacts: [] }, { fixture: true });
    assert.equal(service.handle({ ...request, projectId: randomUUID() }).error?.code, 'UNAUTHORIZED_SCOPE');
    manifest.name = 'External accepted change'; manifest.projectRevision++;
    writeFileSync(join(root, 'workbench.json'), JSON.stringify(manifest));
    const snapshot = service.handle(request);
    assert.ok('result' in snapshot);
    assert.equal((snapshot.result as any).manifest.name, manifest.name);
    assert.equal(service.store.getProject(manifest.projectId)?.projectRevision, 2);
    manifest.name = 'Unversioned external edit';
    const external = JSON.stringify(manifest); writeFileSync(join(root, 'workbench.json'), external);
    assert.equal(service.handle(request).error?.code, 'REVISION_CONFLICT');
    assert.equal(readFileSync(join(root, 'workbench.json'), 'utf8'), external);
    writeFileSync(join(root, 'workbench.json'), '{invalid manual edit');
    assert.ok('result' in service.handle({ ...request, method: 'operation.get', params: { operationId } }), 'Receipts remain readable while the manifest needs repair.');
    writeFileSync(join(root, 'workbench.json'), external);
    assert.throws(() => service.handle({ ...request, method: 'arbitrary.shell' }));
    assert.equal(service.handle({ ...request, method: 'operation.get', params: { requestId: randomUUID() } }).error?.code, 'NOT_FOUND');
  } finally { service.close(); rmSync(temp, { recursive: true, force: true }); }
});

test('near-limit manifest produces a bounded error rather than an invalid outbound envelope', () => {
  const temp = mkdtempSync(join(tmpdir(), 'workbench-large-manifest-'));
  const root = join(temp, 'project'); mkdirSync(root);
  const manifest = JSON.parse(readFileSync('examples/workbench.valid.json', 'utf8'));
  manifest.name = '';
  manifest.name = 'x'.repeat(1024 * 1024 - Buffer.byteLength(JSON.stringify(manifest)) - 1);
  writeFileSync(join(root, 'workbench.json'), JSON.stringify(manifest));
  const service = new ProjectService(root, join(temp, 'data'));
  try {
    const response = service.handle({ schemaVersion: 1, requestId: randomUUID(), projectId: manifest.projectId, method: 'project.snapshot', params: {} });
    assert.equal(response.error?.code, 'INVALID_REQUEST');
    assert.ok(Buffer.byteLength(JSON.stringify(response)) < 1024);
  } finally { service.close(); rmSync(temp, { recursive: true, force: true }); }
});
