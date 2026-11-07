import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { DiagnosticBundleV1, DiagnosticPreviewV1, OperationReceipt, RecoverySnapshot, WorkbenchManifest } from '@robotics-workbench/contracts';
import { RecoveryController, type RecoveryChoice, type RecoveryHost, type RecoveryUi } from '../src/recovery-controller';

function fixture() {
  const manifest: WorkbenchManifest = { schemaVersion: 1, projectId: randomUUID(), projectRevision: 4, name: 'Synthetic recovery project', sketches: [], targets: [], components: [], nets: [], codeBindings: [], documents: [], extensions: {} };
  const bound = { root: 'G:/synthetic project', manifest };
  const operation: OperationReceipt = { schemaVersion: 1, operationId: randomUUID(), requestId: randomUUID(), projectId: manifest.projectId, kind: 'upload', status: 'outcome-unknown', expectedProjectRevision: 4, createdAt: '2026-11-04T00:00:00.000Z', finishedAt: '2026-11-04T00:01:00.000Z', deviceId: randomUUID(), sourceSnapshotId: randomUUID(), tool: { name: 'synthetic', version: '1' }, artifacts: [], error: { code: 'OUTCOME_UNKNOWN', message: 'Synthetic process disappeared', retryable: false } };
  const snapshot: RecoverySnapshot = { projectId: manifest.projectId, projectRevision: 4, operations: [{ operationId: operation.operationId, kind: operation.kind, status: operation.status, createdAt: operation.createdAt, finishedAt: operation.finishedAt, artifactCount: 0, error: operation.error }], nextCursor: null, storage: { quarantined: 0, missing: 0, corrupt: 0 }, notice: 'Synthetic recovery evidence; no device observations.' };
  const calls: { method: string; params?: Record<string, unknown>; revision?: number }[] = [], picks: RecoveryChoice[][] = [], inspections: { title: string; content: string }[] = [], actions: string[] = [], paths: string[] = [], messages: string[] = [];
  let choose: (items: RecoveryChoice[]) => RecoveryChoice | undefined = () => undefined;
  const host: RecoveryHost = { project: async () => bound, prepareArchive: async () => ({ manifestSha256: 'a'.repeat(64), documentHashes: { 'Sketch.ino': 'b'.repeat(64) }, assertUnchanged() {} }), request: async <T>(_bound: typeof bound, method: string, params?: Record<string, unknown>, revision?: number) => {
    calls.push({ method, params, revision });
    if (method === 'recovery.inspect') return structuredClone(snapshot) as T;
    if (method === 'operation.get') return structuredClone(operation) as T;
    if (method === 'project.snapshot') return { manifest, manifestSha256: 'a'.repeat(64) } as T;
    if (method === 'project.export' || method === 'project.restore') return { projectId: manifest.projectId, historical: true } as T;
    throw Error(`Unexpected ${method}`);
  } };
  const ui: RecoveryUi = { pick: async items => { picks.push(items); return choose(items); }, inspect: async (title, content) => { inspections.push({ title, content }); }, path: async () => paths.shift(), saveFile: async () => paths.shift(), confirm: async () => true, input: async () => 'Synthetic operator explicitly confirmed termination', message: async value => { messages.push(value); }, action: async action => { actions.push(action); }, dispose() {} };
  return { bound, manifest, operation, snapshot, host, ui, calls, picks, inspections, actions, paths, messages, setChoose: (value: typeof choose) => { choose = value; }, controller: new RecoveryController(host, ui) };
}

test('recovery inspects an unknown upload without replay, target discovery or firmware claims', async () => {
  const f = fixture(); f.setChoose(items => items.find(item => item.operationId === f.operation.operationId));
  await f.controller.show();
  assert.deepEqual(f.calls.map(item => item.method), ['recovery.inspect', 'operation.get']);
  assert.deepEqual(f.actions, []);
  assert.equal(JSON.parse(f.inspections[0].content).receipt.status, 'outcome-unknown');
  assert.match(JSON.parse(f.inspections[0].content).notice, /never replayed/);
  assert.ok(f.picks[0].every(item => !/retry|replay|upload exact|cancel/i.test(item.label)));
});

test('receipt pages are observed explicitly and empty state retains specific recovery actions', async () => {
  const f = fixture(); f.snapshot.operations = []; f.snapshot.nextCursor = 'synthetic-cursor';
  let page = 0;
  f.setChoose(items => page++ === 0 ? items.find(item => item.action === 'next') : items.find(item => item.action === 'inspect'));
  await f.controller.show();
  assert.deepEqual(f.calls.map(item => item.params), [{}, { cursor: 'synthetic-cursor' }]);
  assert.match(f.picks[1].find(item => item.action === 'inspect')!.detail!, /No operation receipts/);
  assert.ok(f.picks[1].some(item => item.action === 'reviewTaskChanges'));
});

test('wrong-project summaries and receipts cannot become inspectable recovery evidence', async () => {
  const f = fixture(); f.snapshot.projectId = randomUUID(); await f.controller.show();
  assert.deepEqual(f.inspections, []); assert.deepEqual(f.calls.map(item => item.method), ['recovery.inspect']);
  assert.deepEqual(f.picks[0].map(item => item.action), ['refresh', 'checkTools']);
  f.operation.projectId = randomUUID(); await assert.rejects(f.controller.inspectOperation(f.bound, f.operation.operationId), { code: 'UNAUTHORIZED_SCOPE' });
  assert.deepEqual(f.inspections, []);
});

test('companion failure offers read refresh and tool check without mutation retry', async () => {
  const f = fixture(); f.host.request = async () => { throw Error('Companion disconnected'); };
  f.setChoose(items => items.find(item => item.action === 'checkTools')); await f.controller.show();
  assert.deepEqual(f.actions, ['checkTools']); assert.deepEqual(f.inspections, []);
});

test('backup obtains editor preconditions after dialogs and binds exact saved manifest revision', async () => {
  const f = fixture(); f.paths.push('G:/backup'); await f.controller.exportProject();
  const write = f.calls.find(item => item.method === 'project.export')!;
  assert.equal(write.revision, 4); assert.deepEqual(write.params, { destination: 'G:/backup', expectedManifestSha256: 'a'.repeat(64), documentHashes: { 'Sketch.ino': 'b'.repeat(64) } });
  assert.equal(f.calls[0].method, 'project.snapshot');
});

test('changed manifest, cancelled dialog or failed editor save cannot submit a backup', async () => {
  const f = fixture(); f.paths.push('G:/backup'); f.host.prepareArchive = async () => ({ manifestSha256: 'c'.repeat(64), documentHashes: {}, assertUnchanged() {} });
  await assert.rejects(f.controller.exportProject(), { code: 'REVISION_CONFLICT' }); assert.equal(f.calls.some(item => item.method === 'project.export'), false);
  f.calls.length = 0; await f.controller.exportProject(); assert.equal(f.calls.length, 0);
  f.paths.push('G:/backup'); f.host.prepareArchive = async () => { throw Error('Dirty/provider conflict'); };
  await assert.rejects(f.controller.exportProject(), /Dirty\/provider conflict/); assert.equal(f.calls.length, 0);
});

test('an editor becoming dirty during final snapshot read blocks backup submission', async () => {
  const f = fixture(), request = f.host.request; let dirty = false;
  f.paths.push('G:/backup');
  f.host.prepareArchive = async () => ({ manifestSha256: 'a'.repeat(64), documentHashes: {}, assertUnchanged() { if (dirty) throw Error('Independent unsaved editor change was preserved'); } });
  f.host.request = async <T>(bound: typeof f.bound, method: string, params?: Record<string, unknown>, revision?: number) => { const result = await request<T>(bound, method as Parameters<typeof request>[1], params, revision); if (method === 'project.snapshot') dirty = true; return result; };
  await assert.rejects(f.controller.exportProject(), /Independent unsaved editor change/);
  assert.equal(f.calls.some(item => item.method === 'project.export'), false);
});

test('restore names separate destinations and keeps current ownership and historical device truth', async () => {
  const f = fixture(); f.paths.push('G:/backup', 'G:/restored', 'G:/restored-data'); await f.controller.restoreProject();
  assert.deepEqual(f.calls, [{ method: 'project.restore', params: { archiveDirectory: 'G:/backup', newProjectRoot: 'G:/restored', newDataRoot: 'G:/restored-data' }, revision: 4 }]);
  assert.deepEqual(f.actions, []); assert.match(f.messages[0], /historical/); assert.match(f.messages[0], /No firmware or physical wiring was restored/);
});

test('unknown upload acknowledgment binds exact observation, affirmative operator check and note without replay', async () => {
  const f = fixture(), observationId = randomUUID(), request = f.host.request;
  f.host.request = async <T>(bound: typeof f.bound, method: string, params?: Record<string, unknown>, revision?: number) => {
    if (method === 'device.discover') { f.calls.push({ method, params, revision }); return { devices: [{ state: 'outcome-unknown', observation: { deviceId: f.operation.deviceId, observationId, connected: true, transportPath: 'COM-synthetic', identity: { serialNumber: 'synthetic' } } }] } as T; }
    if (method === 'device.reconcile') { f.calls.push({ method, params, revision }); return { acknowledged: true, firmwareState: 'unknown' } as T; }
    return request(bound, method as Parameters<typeof request>[1], params, revision);
  };
  await f.controller.acknowledgeUnknownUpload(f.bound, f.operation.operationId);
  assert.deepEqual(f.calls.map(item => item.method), ['operation.get', 'device.discover', 'device.reconcile']);
  assert.deepEqual(f.calls.at(-1)!.params, { operationId: f.operation.operationId, deviceId: f.operation.deviceId, expectedDeviceObservationId: observationId, processTerminationConfirmed: true, note: 'Synthetic operator explicitly confirmed termination' });
  assert.equal(f.calls.at(-1)!.revision, 4); assert.equal(f.operation.status, 'outcome-unknown'); assert.deepEqual(f.actions, []);
  f.calls.length = 0; f.ui.confirm = async () => false;
  await f.controller.acknowledgeUnknownUpload(f.bound, f.operation.operationId); assert.equal(f.calls.some(item => item.method === 'device.reconcile'), false);
  f.calls.length = 0; f.ui.input = async () => ' ';
  await f.controller.acknowledgeUnknownUpload(f.bound, f.operation.operationId); assert.equal(f.calls.some(item => item.method === 'device.reconcile'), false);
});

test('unknown-upload acknowledgment refuses absent or ambiguous original device without a mutation', async () => {
  const f = fixture(), request = f.host.request;
  f.host.request = async <T>(bound: typeof f.bound, method: string, params?: Record<string, unknown>, revision?: number) => method === 'device.discover' ? { devices: [] } as T : request(bound, method as Parameters<typeof request>[1], params, revision);
  await assert.rejects(f.controller.acknowledgeUnknownUpload(f.bound, f.operation.operationId), { code: 'TARGET_AMBIGUOUS' });
  assert.equal(f.calls.some(item => item.method === 'device.reconcile'), false);
});

function diagnosticFixture() {
  const f = fixture(), createdAt = new Date().toISOString();
  const bundle: DiagnosticBundleV1 = {
    schemaVersion: 1, kind: 'workbench-diagnostics', privacy: 'default-private', observedAt: createdAt,
    scope: { projectId: f.manifest.projectId, projectRevision: f.manifest.projectRevision, epoch: randomUUID(), snapshotSequence: 0 },
    versions: { app: '0.1.0', companionNode: '24.18.0', sqlite: null, modulesAbi: null, platform: 'win32', arch: 'x64', osRelease: null },
    configuration: { dataRoot: 'external-local', companionRuntime: 'detected-local-node', telemetry: 'disabled', privatePayloadsIncluded: false },
    tools: (['arduino-cli', 'kicad-cli', 'cadquery', 'codex', 'opencode'] as const).map(toolId => ({ toolId, version: null, basis: 'not-recorded' as const, observedAt: null, currentVerified: false as const })),
    operations: [], logs: [], storage: { databaseBytes: 0, freeBytes: null, recoveryBasis: 'companion-startup-scan', quarantined: 0, missing: 0, corrupt: 0 }, omitted: { operations: 0, olderLogWindow: false },
    notice: 'Historical receipts do not establish current tool readiness, firmware, physical wiring or behavior. Source, serial bytes, document text, provider transcripts, credentials, private paths and raw log text are excluded.'
  };
  const text = JSON.stringify(bundle), preview: DiagnosticPreviewV1 = { schemaVersion: 1, previewId: randomUUID(), projectId: f.manifest.projectId, projectRevision: f.manifest.projectRevision, createdAt, bundleSha256: createHash('sha256').update(text).digest('hex'), byteLength: Buffer.byteLength(text), text };
  const request = f.host.request;
  f.host.request = async <T>(bound: typeof f.bound, method: Parameters<typeof request>[1], params?: Record<string, unknown>, revision?: number) => {
    if (method === 'diagnostics.preview' || method === 'diagnostics.export') {
      f.calls.push({ method, params, revision });
      return (method === 'diagnostics.preview' ? structuredClone(preview) : { previewId: preview.previewId, bundleSha256: preview.bundleSha256, byteLength: preview.byteLength, destination: params!.destination }) as T;
    }
    return request<T>(bound, method, params, revision);
  };
  return { ...f, preview };
}

test('diagnostics keeps the native preview readable before exporting exactly its reviewed bytes', async () => {
  const f = diagnosticFixture(); f.paths.push('G:/diagnostic.json');
  f.ui.confirm = async (_message, action, modal) => { assert.equal(action, 'Save diagnostic bundle'); assert.equal(modal, false); assert.equal(f.inspections[0].content, f.preview.text); return true; };
  await f.controller.exportDiagnostics();
  assert.deepEqual(f.calls, [{ method: 'diagnostics.preview', params: undefined, revision: undefined }, { method: 'diagnostics.export', params: { previewId: f.preview.previewId, expectedBundleSha256: f.preview.bundleSha256, destination: 'G:/diagnostic.json' }, revision: 4 }]);
  assert.match(f.messages[0], /saved locally/); assert.deepEqual(f.actions, []);
});

test('diagnostic review and file-picker cancellation cannot export', async () => {
  const f = diagnosticFixture(); f.ui.confirm = async () => false;
  f.ui.saveFile = async () => { assert.fail('A declined preview cannot open the file picker.'); };
  await f.controller.exportDiagnostics(); assert.deepEqual(f.calls.map(call => call.method), ['diagnostics.preview']);
  f.calls.length = 0; f.ui.confirm = async () => true; f.ui.saveFile = async () => undefined;
  await f.controller.exportDiagnostics(); assert.deepEqual(f.calls.map(call => call.method), ['diagnostics.preview']); assert.deepEqual(f.messages, []);
});

test('diagnostic preview tampering or wrong scope is refused before presentation or export', async () => {
  for (const field of ['bundleSha256', 'projectId', 'byteLength'] as const) {
    const f = diagnosticFixture();
    if (field === 'byteLength') f.preview.byteLength++; else f.preview[field] = field === 'projectId' ? randomUUID() : '0'.repeat(64);
    await assert.rejects(f.controller.exportDiagnostics(), { code: 'INVALID_REQUEST' });
    assert.deepEqual(f.inspections, []); assert.deepEqual(f.calls.map(call => call.method), ['diagnostics.preview']);
  }
});

test('changing project during diagnostic review blocks export without disturbing source', async () => {
  const f = diagnosticFixture(); let reads = 0; f.paths.push('G:/diagnostic.json');
  f.host.project = async () => ++reads === 1 ? f.bound : { ...f.bound, root: 'G:/other-project' };
  await assert.rejects(f.controller.exportDiagnostics(), { code: 'REVISION_CONFLICT' });
  assert.deepEqual(f.calls.map(call => call.method), ['diagnostics.preview']); assert.deepEqual(f.messages, []);
});

test('an unattributable diagnostic export response never becomes a success notice or automatic retry', async () => {
  const f = diagnosticFixture(), request = f.host.request; f.paths.push('G:/diagnostic.json');
  f.host.request = async <T>(bound: typeof f.bound, method: Parameters<typeof request>[1], params?: Record<string, unknown>, revision?: number) => {
    const value = await request<T>(bound, method, params, revision);
    return method === 'diagnostics.export' ? { ...value, previewId: randomUUID() } : value;
  };
  await assert.rejects(f.controller.exportDiagnostics(), { code: 'INVALID_REQUEST' });
  assert.deepEqual(f.calls.map(call => call.method), ['diagnostics.preview', 'diagnostics.export']); assert.deepEqual(f.messages, []);
});
