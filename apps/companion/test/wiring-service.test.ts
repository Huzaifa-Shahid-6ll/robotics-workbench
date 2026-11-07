import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PreparedWiringPlan, ProjectRequest, ProjectResponse, WiringSnapshotData, WorkbenchManifest } from '@robotics-workbench/contracts';
import { syntheticDefinition } from '../../../packages/test-fixtures/components/synthetic';
import { ProjectService } from '../src/project-service';
import { WiringService } from '../src/wiring-service';

function fixture(t: TestContext) {
  const temp = mkdtempSync(join(tmpdir(), 'workbench-wiring-service-')), root = join(temp, 'project'), data = join(temp, 'data'); mkdirSync(root);
  const manifest = JSON.parse(readFileSync('examples/workbench.valid.json', 'utf8')) as WorkbenchManifest;
  manifest.components = [{ componentId: randomUUID(), label: 'Unidentified front module', definition: null, identityStatus: 'unresolved', provisionalPins: [{ pinId: 'SIG', label: 'User-entered signal' }] }];
  const file = join(root, 'workbench.json'); writeFileSync(file, JSON.stringify(manifest));
  let project = new ProjectService(root, data), wiring = new WiringService(project);
  t.after(() => { try { project.close(); } finally { assert.equal(dirname(realpathSync(temp)), realpathSync(tmpdir())); rmSync(temp, { recursive: true, force: true }); } });
  const request = (method: ProjectRequest['method'], params: Record<string, unknown> = {}, expectedProjectRevision?: number): ProjectRequest => ({ schemaVersion: 1, requestId: randomUUID(), projectId: manifest.projectId, method, params, ...(expectedProjectRevision === undefined ? {} : { expectedProjectRevision }) });
  return { root, file, manifest, request, get project() { return project; }, get wiring() { return wiring; },
    snapshot: () => result<WiringSnapshotData>(wiring.handle(request('wiring.snapshot'))),
    restart() { project.close(); project = new ProjectService(root, data); wiring = new WiringService(project); } };
}
function result<T>(response: ProjectResponse): T { assert.equal(response.error, undefined, JSON.stringify(response.error)); return response.result as T; }
const commitRecords = (project: ProjectService) => project.store.listRecords<{ kind: string; migrationArtifactId?: string }>('sessions', project.projectId).filter(record => record.kind === 'wiring-commit');

test('wiring previews leave manifest bytes and hardware operation history unchanged', t => {
  const f = fixture(t), snapshot = f.snapshot(), before = readFileSync(f.file), operations = [{ type: 'component.rename', componentId: f.manifest.components[0].componentId, label: 'Front module design label' }];
  const plan = result<PreparedWiringPlan>(f.wiring.handle(f.request('wiring.plan', { expectedManifestSha256: snapshot.manifestSha256, operations }, 1)));
  assert.equal(plan.expectedProjectRevision, 1); assert.equal(plan.next.projectRevision, 2); assert.equal(plan.next.components[0].label, 'Front module design label');
  assert.equal(plan.confirmationInvalidated, true); assert.equal(plan.previous.components[0].label, f.manifest.components[0].label);
  assert.deepEqual(readFileSync(f.file), before); assert.equal(commitRecords(f.project).length, 0);
  assert.deepEqual(f.project.store.listOperations(f.manifest.projectId), []); assert.equal(f.project.jobs.isIdle, true); assert.deepEqual(f.project.devices.status(), []);
});

test('only exactly saved preview bytes are accepted and duplicate acceptance survives restart', t => {
  const f = fixture(t), snapshot = f.snapshot();
  const plan = result<PreparedWiringPlan>(f.wiring.handle(f.request('wiring.plan', { expectedManifestSha256: snapshot.manifestSha256, operations: [{ type: 'component.rename', componentId: f.manifest.components[0].componentId, label: 'Reviewed label' }] }, 1)));
  assert.deepEqual(result(f.wiring.handle(f.request('wiring.check', { previewId: plan.previewId, expectedManifestSha256: snapshot.manifestSha256 }, 1))), { current: true });
  const unsaved = f.request('wiring.accept', { previewId: plan.previewId, manifestSha256: snapshot.manifestSha256 }, 2);
  assert.equal(f.wiring.handle(unsaved).error?.code, 'REVISION_CONFLICT');
  writeFileSync(f.file, JSON.stringify(plan.next, null, 2));
  const saved = f.snapshot(), acceptance = f.request('wiring.accept', { previewId: plan.previewId, manifestSha256: saved.manifestSha256 }, 2);
  const commit = result<{ migrationArtifactId: string }>(f.wiring.handle(acceptance));
  assert.deepEqual(result(f.wiring.handle(acceptance)), commit); assert.equal(commitRecords(f.project).length, 1);
  const artifact = JSON.parse(f.project.store.readArtifact(f.manifest.projectId, commit.migrationArtifactId).toString('utf8'));
  assert.deepEqual(artifact.previous, plan.previous); assert.deepEqual(artifact.next, plan.next); assert.deepEqual(artifact.inverseOperations, plan.inverseOperations);
  f.restart(); assert.deepEqual(result(f.wiring.handle(acceptance)), commit); assert.equal(commitRecords(f.project).length, 1);
  assert.equal(f.wiring.handle({ ...acceptance, params: { ...acceptance.params, manifestSha256: 'f'.repeat(64) } }).error?.code, 'REQUEST_ID_CONFLICT');
  assert.deepEqual(f.project.store.listOperations(f.manifest.projectId), []);
});

test('stale revision or source hash refuses planning and conflicting saved edits are preserved', t => {
  const f = fixture(t), snapshot = f.snapshot(), operations = [{ type: 'component.rename', componentId: f.manifest.components[0].componentId, label: 'Reviewed label' }];
  assert.equal(f.wiring.handle(f.request('wiring.plan', { expectedManifestSha256: 'f'.repeat(64), operations }, 1)).error?.code, 'REVISION_CONFLICT');
  assert.equal(f.wiring.handle(f.request('wiring.plan', { expectedManifestSha256: snapshot.manifestSha256, operations }, 2)).error?.code, 'REVISION_CONFLICT');
  const plan = result<PreparedWiringPlan>(f.wiring.handle(f.request('wiring.plan', { expectedManifestSha256: snapshot.manifestSha256, operations }, 1)));
  const external = { ...plan.next, name: 'Concurrent external user change' }, bytes = JSON.stringify(external); writeFileSync(f.file, bytes);
  const current = f.snapshot();
  assert.equal(f.wiring.handle(f.request('wiring.check', { previewId: plan.previewId, expectedManifestSha256: snapshot.manifestSha256 }, 1)).error?.code, 'REVISION_CONFLICT');
  assert.equal(f.wiring.handle(f.request('wiring.accept', { previewId: plan.previewId, manifestSha256: current.manifestSha256 }, 2)).error?.code, 'REVISION_CONFLICT');
  assert.equal(readFileSync(f.file, 'utf8'), bytes); assert.equal(commitRecords(f.project).length, 0);
});

test('reported observations are immutable historical reports and become stale after a design change', t => {
  const f = fixture(t), snapshot = f.snapshot();
  const request = f.request('wiring.observe', { subjectIds: [f.manifest.components[0].componentId], procedure: 'Synthetic report procedure; no hardware exercised.', note: 'Reported observation fixture only.', result: 'inconclusive', observedAt: '2026-11-02T12:00:00.000Z', expectedManifestSha256: snapshot.manifestSha256 }, 1);
  const observation = result<{ observationId: string; basis: string; projectRevision: number; evidenceRefs: string[] }>(f.wiring.handle(request));
  assert.equal(observation.observationId, request.requestId); assert.equal(observation.basis, 'reported'); assert.equal(observation.projectRevision, 1);
  const evidence = f.project.store.readArtifact(f.manifest.projectId, observation.evidenceRefs[0]);
  assert.equal(f.snapshot().confirmations[0].applicability, 'current');
  writeFileSync(f.file, JSON.stringify({ ...f.manifest, projectRevision: 2, name: 'Changed design intent' }));
  const changed = f.snapshot(); assert.equal(changed.confirmations[0].applicability, 'stale'); assert.equal(changed.confirmations[0].projectRevision, 1);
  assert.deepEqual(result(f.wiring.handle(request)), observation);
  assert.equal(f.wiring.handle({ ...request, params: { ...request.params, note: 'Replaced historical prose' } }).error?.code, 'REQUEST_ID_CONFLICT');
  assert.equal(f.wiring.handle({ ...request, requestId: randomUUID() }).error?.code, 'REVISION_CONFLICT');
  assert.equal(f.project.store.listRecords('observations', f.manifest.projectId).length, 1); assert.deepEqual(f.project.store.readArtifact(f.manifest.projectId, observation.evidenceRefs[0]), evidence);
  f.restart(); assert.deepEqual(result(f.wiring.handle(request)), observation); assert.deepEqual(f.project.store.listOperations(f.manifest.projectId), []);
});

test('an observation admission without a completed record remains outcome-unknown', t => {
  const f = fixture(t), snapshot = f.snapshot();
  const request = f.request('wiring.observe', { subjectIds: [f.manifest.components[0].componentId], procedure: 'Synthetic interruption fixture.', note: 'No completed observation exists.', result: 'inconclusive', observedAt: '2026-11-02T12:00:00.000Z', expectedManifestSha256: snapshot.manifestSha256 }, 1);
  assert.equal(f.project.store.admitRequest(f.manifest.projectId, request.requestId, request), true);
  assert.equal(f.wiring.handle(request).error?.code, 'OUTCOME_UNKNOWN'); assert.deepEqual(f.project.store.listRecords('observations', f.manifest.projectId), []);
  const missing = { ...request, requestId: randomUUID(), params: { ...request.params, subjectIds: [randomUUID()] } };
  assert.equal(f.wiring.handle(missing).error?.code, 'NOT_FOUND');
});

test('catalog parse and immutable-version failures preserve supplied bytes across service restart', t => {
  const f = fixture(t), directory = join(f.root, 'components'); mkdirSync(directory); const path = join(directory, 'catalog.json');
  writeFileSync(path, '{invalid external catalog'); assert.equal(f.wiring.handle(f.request('wiring.snapshot')).error?.code, 'INVALID_REQUEST'); assert.equal(readFileSync(path, 'utf8'), '{invalid external catalog');
  const definition = syntheticDefinition(); writeFileSync(path, JSON.stringify({ schemaVersion: 1, definitions: [definition], unexpected: true })); assert.equal(f.wiring.handle(f.request('wiring.snapshot')).error?.code, 'INVALID_REQUEST');
  const original = JSON.stringify({ schemaVersion: 1, definitions: [definition] }); writeFileSync(path, original); assert.ok(f.snapshot().catalog.some(item => item.definitionId === definition.definitionId));
  const modified = JSON.stringify({ schemaVersion: 1, definitions: [{ ...definition, model: 'Silent same-version replacement' }] }); writeFileSync(path, modified);
  assert.equal(f.wiring.handle(f.request('wiring.snapshot')).error?.code, 'REVISION_CONFLICT'); assert.equal(readFileSync(path, 'utf8'), modified);
  f.restart(); assert.equal(f.wiring.handle(f.request('wiring.snapshot')).error?.code, 'REVISION_CONFLICT');
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, definitions: [definition, { ...definition, definitionVersion: '2', model: 'Explicit new version' }] }));
  assert.equal(f.snapshot().catalog.filter(item => item.definitionId === definition.definitionId).length, 2);
});

for (const change of ['same-version mutation', 'new-version addition'] as const) {
  test(`catalog ${change} invalidates both pre-save check and post-save acceptance`, t => {
    const f = fixture(t), directory = join(f.root, 'components'); mkdirSync(directory); const path = join(directory, 'catalog.json'), definition = syntheticDefinition();
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, definitions: [definition] }));
    const snapshot = f.snapshot(), plan = result<PreparedWiringPlan>(f.wiring.handle(f.request('wiring.plan', { expectedManifestSha256: snapshot.manifestSha256, operations: [{ type: 'component.rename', componentId: f.manifest.components[0].componentId, label: 'Reviewed label' }] }, 1)));
    const check = f.request('wiring.check', { previewId: plan.previewId, expectedManifestSha256: snapshot.manifestSha256 }, 1);
    assert.deepEqual(result(f.wiring.handle(check)), { current: true });
    const definitions = change === 'same-version mutation' ? [{ ...definition, model: 'Changed under immutable identity' }] : [definition, { ...definition, definitionVersion: '2' }];
    const external = JSON.stringify({ schemaVersion: 1, definitions }); writeFileSync(path, external);
    assert.equal(f.wiring.handle(check).error?.code, 'REVISION_CONFLICT'); assert.equal(readFileSync(f.file, 'utf8'), JSON.stringify(f.manifest));
    // Simulate an external save after the preview check; acceptance must independently recheck the catalog.
    const saved = JSON.stringify(plan.next); writeFileSync(f.file, saved); const manifestSha256 = f.project.files.inspectManifest().sha256;
    assert.equal(f.wiring.handle(f.request('wiring.accept', { previewId: plan.previewId, manifestSha256 }, 2)).error?.code, 'REVISION_CONFLICT');
    assert.equal(readFileSync(path, 'utf8'), external); assert.equal(readFileSync(f.file, 'utf8'), saved); assert.equal(commitRecords(f.project).length, 0); assert.deepEqual(f.project.store.listOperations(f.manifest.projectId), []);
  });
}

test('invalid external manifest and layout JSON is left available for manual repair', t => {
  const f = fixture(t); f.snapshot();
  const invalidManifest = '{invalid external manifest'; writeFileSync(f.file, invalidManifest);
  assert.ok(f.wiring.handle(f.request('wiring.snapshot')).error); assert.equal(readFileSync(f.file, 'utf8'), invalidManifest);
  writeFileSync(f.file, JSON.stringify(f.manifest)); const layout = join(f.root, '.workbench-layout.json'), invalidLayout = '{invalid external layout'; writeFileSync(layout, invalidLayout);
  assert.equal(f.wiring.handle(f.request('wiring.snapshot')).error?.code, 'INVALID_REQUEST'); assert.equal(readFileSync(layout, 'utf8'), invalidLayout);
  assert.deepEqual(f.project.store.listOperations(f.manifest.projectId), []);
});

test('known driven-output to ground design errors block acceptance without starting hardware', t => {
  const f = fixture(t), reference = { definitionId: 'arduino:uno-r3-a000066', definitionVersion: '1' };
  f.manifest.components = [0, 1].map(index => ({ componentId: randomUUID(), label: `Reference board ${index}`, definition: reference, identityStatus: 'resolved' }));
  // The initial manifest was registered by the constructor; advance its revision for this external fixture edit.
  f.manifest.projectRevision = 2; writeFileSync(f.file, JSON.stringify(f.manifest)); const snapshot = f.snapshot();
  const plan = result<PreparedWiringPlan>(f.wiring.handle(f.request('wiring.plan', { expectedManifestSha256: snapshot.manifestSha256, operations: [{ type: 'net.set', net: { netId: randomUUID(), members: [{ componentId: f.manifest.components[0].componentId, pinId: '5V' }, { componentId: f.manifest.components[1].componentId, pinId: 'GND' }] } }] }, 2)));
  assert.ok(plan.rules.some(rule => rule.ruleId === 'wiring.signal-direction' && rule.outcome === 'fail' && rule.severity === 'error'));
  writeFileSync(f.file, JSON.stringify(plan.next)); const saved = f.project.files.inspectManifest();
  assert.equal(f.wiring.handle(f.request('wiring.accept', { previewId: plan.previewId, manifestSha256: saved.sha256 }, 3)).error?.code, 'INVALID_REQUEST');
  assert.equal(commitRecords(f.project).length, 0); assert.deepEqual(f.project.store.listOperations(f.manifest.projectId), []); assert.deepEqual(f.project.devices.status(), []);
});
