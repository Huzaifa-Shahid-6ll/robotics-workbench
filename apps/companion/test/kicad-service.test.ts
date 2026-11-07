import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { digest, type KicadConfig } from '@robotics-workbench/kicad';
import type { ProcessResult, ProcessSpec } from '@robotics-workbench/application';
import type { KicadExport, KicadPreview, KicadSnapshot, OperationReceipt, ProjectRequest, ProjectResponse } from '@robotics-workbench/contracts';
import { ercReport, fixtureNetlist, kicadFixture, safeSvg } from '../../../packages/test-fixtures/kicad/fixtures';
import { KicadService } from '../src/kicad-service';
import { ProjectService } from '../src/project-service';

const processResult = (stdout = '', exitCode = 0): ProcessResult => ({ exitCode, signal: null, stdout, stderr: '', stdoutBytes: Buffer.byteLength(stdout), stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false, logsTruncated: false, timedOut: false, cancelled: false, terminationObserved: true });
const result = <T>(response: ProjectResponse): T => { assert.equal(response.error, undefined, JSON.stringify(response.error)); return response.result as T; };
function fixture(t: TestContext, config?: KicadConfig) {
  const directory = mkdtempSync(join(tmpdir(), 'kicad-service-')), root = join(directory, 'project'); mkdirSync(root); mkdirSync(join(root, 'components'));
  const { manifest, definition, mapping } = kicadFixture(); writeFileSync(join(root, 'workbench.json'), JSON.stringify(manifest)); writeFileSync(join(root, 'components/catalog.json'), JSON.stringify({ schemaVersion: 1, definitions: [definition] })); writeFileSync(join(root, 'components/kicad.json'), JSON.stringify(mapping));
  const executable = join(directory, 'synthetic-kicad.exe'); writeFileSync(executable, 'synthetic executable marker; all processes are mocked');
  const project = new ProjectService(root, join(directory, 'data')), service = new KicadService(project, config ?? { executable, testedExecutableSha256: digest(readFileSync(executable)) });
  t.after(async () => { await project.shutdown(); assert.equal(dirname(realpathSync(directory)), realpathSync(tmpdir())); rmSync(directory, { recursive: true, force: true }); });
  const behavior: { erc?: 'error' | 'warning'; badNetlist?: boolean; badSvg?: boolean; failSvg?: boolean; onNetlist?: () => void; version?: string; timeout?: boolean; waitForCancel?: () => void } = {};
  const calls: string[][] = [];
  project.runner.run = async (spec: ProcessSpec) => {
    const args = [...spec.args]; calls.push(args);
    if (args[0] === '--version') return processResult(behavior.version ?? '10.0.8');
    if (args.includes('--help')) return processResult('--format json --exit-code-violations --severity-all kicadxml --output');
    if (behavior.timeout) return { ...processResult(), timedOut: true, exitCode: null };
    const output = args[args.indexOf('--output') + 1];
    if (args.includes('netlist') && behavior.waitForCancel) { behavior.waitForCancel(); await new Promise<void>(resolve => { if (spec.signal?.aborted) resolve(); else spec.signal?.addEventListener('abort', () => resolve(), { once: true }); }); return { ...processResult(), exitCode: null, cancelled: true }; }
    if (args.includes('netlist')) { writeFileSync(output, behavior.badNetlist ? fixtureNetlist.replace('<node ref="J2" pin="1"/>', '') : fixtureNetlist); behavior.onNetlist?.(); }
    if (args.includes('erc')) { writeFileSync(output, ercReport(behavior.erc)); return processResult('', behavior.erc ? 5 : 0); }
    if (args.includes('svg')) { if (behavior.failSvg) return processResult('failed', 1); writeFileSync(join(output, 'design.svg'), behavior.badSvg ? safeSvg.replace('</svg>', '<script>alert(1)</script></svg>') : safeSvg); }
    return processResult();
  };
  const request = (method: ProjectRequest['method'], params: Record<string, unknown> = {}, revision?: number): ProjectRequest => ({ schemaVersion: 1, requestId: randomUUID(), projectId: manifest.projectId, method, params, ...(revision === undefined ? {} : { expectedProjectRevision: revision }) });
  const generateRequest = () => request('kicad.generate', { mappingPath: 'components/kicad.json', expectedManifestSha256: project.files.inspectManifest().sha256 }, 1);
  const generate = async (input = generateRequest()) => { const receipt = result<OperationReceipt>(await service.handle(input)); return project.jobs.wait(receipt.operationId); };
  const snapshot = async () => result<KicadSnapshot>(await service.handle(request('kicad.snapshot')));
  return { project, service, root, manifest, mapping, behavior, calls, request, generateRequest, generate, snapshot };
}
test('synthetic generator stores endpoint/ERC/preview evidence and exports a standalone ordinary native project once', async t => {
  const f = fixture(t), input = f.generateRequest(), completed = await f.generate(input); assert.equal(completed.status, 'succeeded', JSON.stringify(completed.error));
  assert.equal(result<OperationReceipt>(await f.service.handle(input)).operationId, completed.operationId);
  const snapshot = await f.snapshot(), generation = snapshot.generations[0]; assert.equal(generation.netlistEquivalent, true); assert.equal(generation.verdict, 'pass'); assert.equal(generation.stale, false);
  const preview = result<KicadPreview>(await f.service.handle(f.request('kicad.preview', { generationId: generation.generationId }))); assert.match(preview.dataUrl, /^data:image\/svg\+xml;base64,/); assert.equal(preview.stale, false);
  const exportRequest = f.request('kicad.export', { generationId: generation.generationId, destinationPath: 'native-handoff' }, 1), exported = result<KicadExport>(await f.service.handle(exportRequest)); assert.ok(exported.files.some(file => file.path === 'Workbench.kicad_sym')); assert.equal(digest(readFileSync(join(exported.path, 'design.kicad_sch'))), generation.sourceSha256);
  assert.equal(JSON.parse(readFileSync(join(exported.path, 'provenance.json'), 'utf8')).endpointMappings.length, 4);
  assert.deepEqual(result<KicadExport>(await f.service.handle(exportRequest)), exported);
  assert.equal((await f.service.handle({ ...exportRequest, params: { ...exportRequest.params, destinationPath: 'changed-intent' } })).error?.code, 'REQUEST_ID_CONFLICT');
  writeFileSync(join(exported.path, 'design.kicad_sch'), 'External native edit');
  assert.equal((await f.service.handle(f.request('kicad.export', { generationId: generation.generationId, destinationPath: 'native-handoff' }, 1))).error?.code, 'REVISION_CONFLICT'); assert.equal(readFileSync(join(exported.path, 'design.kicad_sch'), 'utf8'), 'External native edit');
  assert.deepEqual(f.project.devices.status(), []);
});
test('synthetic ERC exit five succeeds as an operation while carrying a failed validation verdict and severity', async t => {
  const f = fixture(t); f.behavior.erc = 'error'; const completed = await f.generate(); assert.equal(completed.status, 'succeeded'); assert.equal(completed.result?.verdict, 'fail'); const snapshot = await f.snapshot(); assert.equal(snapshot.generations[0].diagnostics[0].severity, 'error');
});
test('native expected-hash race preserves external source and every staged immutable proposal', async t => {
  const f = fixture(t), sourcePath = 'existing.kicad_sch'; writeFileSync(join(f.root, sourcePath), 'Existing external file');
  const input = f.generateRequest(); Object.assign(input.params, { sourcePath, expectedSourceSha256: digest('Existing external file') });
  f.behavior.onNetlist = () => writeFileSync(join(f.root, sourcePath), 'Concurrent native save');
  const completed = await f.generate(input); assert.equal(completed.status, 'failed'); assert.equal(completed.error?.code, 'REVISION_CONFLICT'); assert.equal(readFileSync(join(f.root, sourcePath), 'utf8'), 'Concurrent native save'); assert.equal((await f.snapshot()).generations.length, 0); assert.ok(f.project.store.listOperations(f.project.projectId)[0].status === 'failed');
});
test('failed generation retains last good preview with stale status; timeout and connectivity mismatch never publish', async t => {
  const f = fixture(t); assert.equal((await f.generate()).status, 'succeeded');
  f.behavior.badNetlist = true; const mismatch = await f.generate(); assert.equal(mismatch.error?.code, 'KICAD_CONNECTIVITY_MISMATCH'); assert.equal((await f.snapshot()).generations.length, 1); assert.equal((await f.snapshot()).generations[0].stale, true);
  f.behavior.badNetlist = false; f.behavior.timeout = true; const timeout = await f.generate(); assert.equal(timeout.error?.code, 'KICAD_TIMEOUT');
  const preview = result<KicadPreview>(await f.service.handle(f.request('kicad.preview', { generationId: (await f.snapshot()).generations[0].generationId }))); assert.equal(preview.stale, true);
});
test('missing tools disable only schematic operations, exact versions refuse, and active SVG is never published', async t => {
  const absent = fixture(t, {}); assert.equal((await absent.snapshot()).readiness.available, false); assert.equal((await absent.service.handle(absent.generateRequest())).error?.code, 'TOOL_UNAVAILABLE'); assert.equal(absent.project.handle(absent.request('project.snapshot')).error, undefined);
  const f = fixture(t); f.behavior.version = '11.0.0'; assert.equal((await f.service.handle(f.generateRequest())).error?.code, 'KICAD_UNSUPPORTED_VERSION'); f.behavior.version = undefined; f.behavior.badSvg = true; assert.equal((await f.generate()).error?.code, 'KICAD_UNSAFE_PREVIEW'); assert.equal((await f.snapshot()).generations.length, 0);
});
test('saved native handoff edits and stale source hashes refuse export without replacing user source', async t => {
  const f = fixture(t); assert.equal((await f.generate()).status, 'succeeded'); const generation = (await f.snapshot()).generations[0];
  writeFileSync(generation.nativePath, 'External KiCad saved replacement');
  assert.equal((await f.snapshot()).generations[0].stale, true);
  assert.equal((await f.service.handle(f.request('kicad.export', { generationId: generation.generationId, destinationPath: 'stale-export' }, 1))).error?.code, 'REVISION_CONFLICT');
  writeFileSync(join(f.root, 'native.kicad_sch'), 'Saved user bytes');
  assert.equal((await f.service.handle(f.request('kicad.validate', { sourcePath: 'native.kicad_sch', expectedSourceSha256: 'a'.repeat(64) }, 1))).error?.code, 'REVISION_CONFLICT');
  assert.equal(readFileSync(join(f.root, 'native.kicad_sch'), 'utf8'), 'Saved user bytes');
});
test('mocked process cancellation is observed before terminal cancellation and last good preview remains stale', async t => {
  const f = fixture(t); assert.equal((await f.generate()).status, 'succeeded');
  let started!: () => void; const running = new Promise<void>(resolve => { started = resolve; }); f.behavior.waitForCancel = started;
  const queued = result<OperationReceipt>(await f.service.handle(f.generateRequest())); await running;
  const immediate = f.project.jobs.requestCancel(f.project.projectId, queued.operationId); assert.equal(immediate.status, 'running');
  const stopped = await f.project.jobs.wait(queued.operationId); assert.equal(stopped.status, 'cancelled');
  const snapshot = await f.snapshot(); assert.equal(snapshot.generations.length, 1); assert.equal(snapshot.generations[0].stale, true);
});
test('a queued mapping edit rejects its fixed input inventory and preserves the external definition version', async t => {
  const f = fixture(t); let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const blocking: OperationReceipt = { schemaVersion: 1, operationId: randomUUID(), requestId: randomUUID(), projectId: f.project.projectId, kind: 'document-ingest', status: 'queued', expectedProjectRevision: 1, createdAt: new Date().toISOString(), tool: { name: 'synthetic-blocker', version: '1' }, artifacts: [] };
  f.project.jobs.submit({ receipt: blocking, payload: { synthetic: true }, heavy: true, execute: async () => { await held; } });
  try {
    const queued = result<OperationReceipt>(await f.service.handle(f.generateRequest())), external = JSON.stringify({ ...f.mapping, template: 'externally-reviewed-template' }); writeFileSync(join(f.root, 'components/kicad.json'), external);
    release(); await f.project.jobs.wait(blocking.operationId); const failed = await f.project.jobs.wait(queued.operationId); assert.equal(failed.status, 'failed'); assert.equal(failed.error?.code, 'REVISION_CONFLICT'); assert.equal(readFileSync(join(f.root, 'components/kicad.json'), 'utf8'), external); assert.equal((await f.snapshot()).generations.length, 0);
  } finally { release(); }
});
