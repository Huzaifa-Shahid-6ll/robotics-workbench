import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CadService } from '../../apps/companion/src/cad-service';
import { ProjectService } from '../../apps/companion/src/project-service';
import type { CadSnapshot, CadViewer, OperationReceipt, ProjectMethod, ProjectResponse } from '@robotics-workbench/contracts';

async function main() {
  const pythonPath = resolve(process.argv[2] ?? 'artifacts/task10-tools/cad-env/Scripts/python.exe');
  const directory = resolve(process.argv[3] ?? `artifacts/task10-cad-actual/${randomUUID()}`), root = join(directory, 'project'), data = join(directory, 'data');
  mkdirSync(join(root, 'mechanical'), { recursive: true });
  copyFileSync('examples/workbench.valid.json', join(root, 'workbench.json'));
  for (const filename of ['assets.json', 'box.py', 'box_dimensions.py', 'parameters.json']) copyFileSync(`packages/test-fixtures/cad/${filename}`, join(root, 'mechanical', filename));
  const project = new ProjectService(root, data), runnerPath = resolve('packages/adapters/cad/src/runner.py');
  let cad = new CadService(project, { pythonPath, runnerPath, timeoutMs: 300000, trusted: true });
  const evidence: Record<string, unknown> = { schemaVersion: 1, taskId: 'TASK-10', requirement: 'REQ-HW-37-01', evidenceClass: 'actual-native-software-no-physical-fit', directory, pythonPath, startedAt: new Date().toISOString(), checks: [] };
  const checks = evidence.checks as Record<string, unknown>[];
  const request = (method: ProjectMethod, params: Record<string, unknown> = {}) => ({ schemaVersion: 1 as const, requestId: randomUUID(), projectId: project.projectId, method, expectedProjectRevision: 1, params });
  const result = <T>(response: ProjectResponse): T => { assert.equal(response.error, undefined, JSON.stringify(response.error)); return response.result as T; };
  const snapshot = async () => result<CadSnapshot>(await cad.handle(request('cad.snapshot'))).assets[0];
  const assetId = '99999999-9999-4999-8999-999999999999';
  const generate = async (mode = 'production', assumptions?: Record<string, number>) => {
    const admitted = result<OperationReceipt>(await cad.handle(request('cad.generate', { assetId, expectedFingerprint: (await snapshot()).currentFingerprint, mode, ...(assumptions ? { assumptions } : {}) })));
    const completed = await project.jobs.wait(admitted.operationId);
    console.log(`${mode} generation ${completed.status}: ${completed.error?.code ?? completed.operationId}`);
    return completed;
  };
  try {
    const inventory = await project.runner.run({ executable: pythonPath, args: ['-I', '-c', "import importlib.metadata,json,platform;print(json.dumps({'python':platform.python_version(),'packages':{d.metadata['Name'].lower().replace('_','-').replace('.','-'):d.version for d in importlib.metadata.distributions()}}))"], cwd: root, timeoutMs: 120000, maxOutputBytes: 65536, env: { TEMP: directory, TMP: directory } });
    assert.equal(inventory.exitCode, 0); const environment = JSON.parse(inventory.stdout); evidence.environment = environment;
    writeFileSync(join(root, 'mechanical/environment.lock.json'), JSON.stringify(environment, null, 2));
    const good = await generate(); assert.equal(good.status, 'succeeded', JSON.stringify(good.error)); evidence.good = good;
    checks.push({ name: 'actual-headless-geometry-and-staged-output-validation', result: 'passed', geometry: good.result?.geometry, artifacts: good.artifacts });
    const stepId = (good.result!.outputs as Record<string, string>).step, stlId = (good.result!.outputs as Record<string, string>).stl;
    const step = project.store.getArtifact(project.projectId, stepId), stl = project.store.getArtifact(project.projectId, stlId);
    const reopen = await project.runner.run({ executable: pythonPath, args: ['-I', '-c', "import cadquery as cq,json,sys;from OCP.StlAPI import StlAPI_Reader;from OCP.TopoDS import TopoDS_Shape;s=cq.importers.importStep(sys.argv[1]).val();m=TopoDS_Shape();assert s.isValid() and abs(s.Volume()-600)<0.001;assert StlAPI_Reader().Read(m,sys.argv[2]) and not m.IsNull();b=cq.Shape.cast(m).BoundingBox();assert all(abs(a-v)<0.001 for a,v in zip((b.xlen,b.ylen,b.zlen),(20,10,3)));print(json.dumps({'stepVolume':s.Volume(),'stlBounds':[b.xlen,b.ylen,b.zlen]}))", join(data, step.relativePath), join(data, stl.relativePath)], cwd: root, timeoutMs: 300000, env: { TEMP: directory, TMP: directory } });
    assert.equal(reopen.exitCode, 0, reopen.stderr); checks.push({ name: 'independent-fresh-python-consumer-reopen', result: 'passed', observations: JSON.parse(reopen.stdout) });
    const fingerprint = (await snapshot()).currentFingerprint;
    for (const filename of ['box.py', 'box_dimensions.py', 'parameters.json', 'environment.lock.json']) {
      const path = join(root, 'mechanical', filename), original = readFileSync(path, 'utf8');
      const changed = filename.endsWith('.py') ? original + '\n# Actual external saved edit retained\n' : filename === 'parameters.json' ? original.replace('"value": 20', '"value": 21') : original.replace('2.8.0', '2.8.1');
      assert.notEqual(changed, original); writeFileSync(path, changed);
      const stale = await snapshot(); assert.notEqual(stale.currentFingerprint, fingerprint); assert.equal(stale.stale, true); assert.equal(stale.lastGood?.operationId, good.operationId);
      checks.push({ name: `${filename}-fingerprint-invalidation`, result: 'passed' }); writeFileSync(path, original);
    }
    const scriptPath = join(root, 'mechanical/box.py'), script = readFileSync(scriptPath, 'utf8');
    writeFileSync(scriptPath, script + '\nraise ValueError("Deliberate native invalid-regeneration fixture")\n');
    const failed = await generate(); assert.equal(failed.status, 'failed'); assert.equal(failed.error?.code, 'CAD_GENERATION_FAILED');
    assert.equal((await snapshot()).lastGood?.operationId, good.operationId); assert.equal((await snapshot()).stale, true); checks.push({ name: 'actual-failed-regeneration-preserves-good', result: 'passed', receipt: failed });
    writeFileSync(scriptPath, 'import time\ntime.sleep(60)\n');
    cad = new CadService(project, { pythonPath, runnerPath, timeoutMs: 200, trusted: true });
    const timedOut = await generate(); assert.equal(timedOut.status, 'failed'); assert.equal(timedOut.error?.code, 'CAD_TIMEOUT');
    assert.equal((await snapshot()).lastGood?.operationId, good.operationId); checks.push({ name: 'actual-owned-process-timeout-preserves-good', result: 'passed', receipt: timedOut });
    writeFileSync(scriptPath, script); cad = new CadService(project, { pythonPath, runnerPath, timeoutMs: 300000, trusted: true });
    const parameterPath = join(root, 'mechanical/parameters.json'), parameters = JSON.parse(readFileSync(parameterPath, 'utf8')); parameters.width.value = null; parameters.width.basis = 'unknown'; writeFileSync(parameterPath, JSON.stringify(parameters));
    const refused = await cad.handle(request('cad.generate', { assetId, expectedFingerprint: (await snapshot()).currentFingerprint, mode: 'production' }));
    assert.equal(refused.error?.code, 'CAD_DIMENSION_UNKNOWN');
    const exploratory = await generate('exploratory', { width: 20 }); assert.equal(exploratory.status, 'succeeded');
    assert.equal(JSON.parse(readFileSync(parameterPath, 'utf8')).width.value, null);
    const production = await cad.handle(request('cad.export', { assetId, operationId: exploratory.operationId, format: 'step' })); assert.equal(production.error?.code, 'CAD_EXPORT_BLOCKED');
    checks.push({ name: 'actual-exploratory-assumption-keeps-unknown-and-blocks-production-export', result: 'passed', receipt: exploratory });
    const viewer = result<CadViewer>(await cad.handle(request('cad.viewer', { assetId, operationId: good.operationId })));
    assert.match(viewer.script, /from ocp_vscode import show/); assert.match(viewer.script, new RegExp(step.sha256));
    assert.deepEqual(project.store.readArtifact(project.projectId, stepId), readFileSync(join(data, step.relativePath)));
    checks.push({ name: 'documented-public-viewer-handoff-exact-retained-step', result: 'passed', handoff: viewer, viewerDisplayObserved: false });
    evidence.result = 'passed';
  } catch (error) { evidence.result = 'failed'; evidence.failure = error instanceof Error ? error.message : String(error); throw error; }
  finally { evidence.finishedAt = new Date().toISOString(); writeFileSync(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2)); console.log(`CAD native evidence: ${join(directory, 'evidence.json')}`); await project.shutdown(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
