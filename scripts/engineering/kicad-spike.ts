import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { KicadExport, KicadSnapshot, OperationReceipt, ProjectRequest, ProjectResponse } from '@robotics-workbench/contracts';
import { digest, inspectKicad, inspectNative, netlistEndpoints } from '@robotics-workbench/kicad';
import { kicadFixture } from '../../packages/test-fixtures/kicad/fixtures';
import { ProjectService } from '../../apps/companion/src/project-service';
import { KicadService } from '../../apps/companion/src/kicad-service';

/** Native compatibility experiment. Output is evidence only when this exact program exits zero. */
async function main() {
  const executable = resolve(process.argv[2] ?? ''), directory = resolve(process.argv[3] ?? 'artifacts/task10-kicad-native');
  mkdirSync(directory, { recursive: true }); const run = join(directory, randomUUID()); mkdirSync(run); const root = join(run, 'project'); mkdirSync(root); mkdirSync(join(root, 'components'));
  const { manifest, mapping, definition } = kicadFixture(); writeFileSync(join(root, 'workbench.json'), JSON.stringify(manifest, null, 2)); writeFileSync(join(root, 'components/kicad.json'), JSON.stringify(mapping, null, 2)); writeFileSync(join(root, 'components/catalog.json'), JSON.stringify({ schemaVersion: 1, definitions: [definition] }, null, 2));
  const config = { executable, testedExecutableSha256: digest(readFileSync(executable)) }, project = new ProjectService(root, join(run, 'data')), kicad = new KicadService(project, config);
  const response = <T>(value: ProjectResponse): T => { assert.equal(value.error, undefined, JSON.stringify(value.error)); return value.result as T; };
  const request = (method: ProjectRequest['method'], params: Record<string, unknown> = {}, revision?: number): ProjectRequest => ({ schemaVersion: 1, requestId: randomUUID(), projectId: manifest.projectId, method, params, ...(revision ? { expectedProjectRevision: revision } : {}) });
  const generate = async () => { const current = project.files.inspectManifest(); const queued = response<OperationReceipt>(await kicad.handle(request('kicad.generate', { mappingPath: 'components/kicad.json', expectedManifestSha256: current.sha256 }, current.manifest.projectRevision))); const complete = await project.jobs.wait(queued.operationId); writeFileSync(join(run, `operation-${complete.operationId}.json`), JSON.stringify(complete, null, 2)); assert.equal(complete.status, 'succeeded', JSON.stringify(complete.error)); return complete; };
  try {
    const capability = await inspectKicad(project.runner, config, root); writeFileSync(join(run, 'capability.json'), JSON.stringify(capability, null, 2));
    const complete = await generate();
    let snapshot = response<KicadSnapshot>(await kicad.handle(request('kicad.snapshot'))), generation = snapshot.generations[0];
    assert.equal(generation.netlistEquivalent, true); assert.equal(generation.verdict, 'pass', JSON.stringify(generation.diagnostics));
    const exported = response<KicadExport>(await kicad.handle(request('kicad.export', { generationId: generation.generationId, destinationPath: 'native-export' }, 1)));
    const nativePath = 'native-export/design.kicad_sch', nativeBytes = readFileSync(join(root, nativePath)); inspectNative(nativeBytes.toString());
    // Reopen the exported ordinary project through a second native invocation, without a live service dependency.
    const reopened = await project.runner.run({ executable, args: ['sch', 'export', 'netlist', '--format', 'kicadxml', '--output', join(run, 'reopened.net'), join(root, nativePath)], cwd: exported.path, timeoutMs: 60000 });
    assert.equal(reopened.exitCode, 0, reopened.stderr); assert.deepEqual(netlistEndpoints(readFileSync(join(run, 'reopened.net'), 'utf8')), [['J1:1', 'J2:1'], ['J1:2', 'J2:2']]);
    const nativeCheck = response<OperationReceipt>(await kicad.handle(request('kicad.validate', { sourcePath: nativePath, expectedSourceSha256: digest(nativeBytes) }, 1))), nativeComplete = await project.jobs.wait(nativeCheck.operationId); assert.equal(nativeComplete.status, 'succeeded', JSON.stringify(nativeComplete.error));
    // Explicit no-connect markers are checked by the actual native parser and ERC too.
    const secondNet = manifest.nets.pop()!; for (const component of mapping.components) component.pins.find(pin => pin.pinId === 'B')!.noConnect = true; manifest.projectRevision++;
    writeFileSync(join(root, 'workbench.json'), JSON.stringify(manifest)); writeFileSync(join(root, 'components/kicad.json'), JSON.stringify(mapping));
    const noConnect = await generate(); assert.equal(noConnect.result?.verdict, 'pass');
    manifest.nets.push(secondNet); for (const component of mapping.components) delete component.pins.find(pin => pin.pinId === 'B')!.noConnect;
    // Two explicit output pins on each intended net create real ERC output/output conflicts.
    for (const pin of definition.pins) { pin.electricalType = 'output'; pin.modes = ['output']; }
    definition.definitionVersion = '2.0.0'; for (const component of manifest.components) component.definition!.definitionVersion = definition.definitionVersion; for (const component of mapping.components) component.definitionVersion = definition.definitionVersion; manifest.projectRevision++;
    writeFileSync(join(root, 'workbench.json'), JSON.stringify(manifest)); writeFileSync(join(root, 'components/kicad.json'), JSON.stringify(mapping));
    writeFileSync(join(root, 'components/catalog.json'), JSON.stringify({ schemaVersion: 1, definitions: [definition] }));
    const violation = await generate(); assert.equal(violation.result?.verdict, 'fail');
    snapshot = response<KicadSnapshot>(await kicad.handle(request('kicad.snapshot'))); generation = snapshot.generations[0]; assert.ok(generation.diagnostics.some(item => item.severity === 'error'));
    // A real CLI generation races an external save; publication fails without replacing either side.
    const guardedPath = 'guarded-native.kicad_sch', guarded = join(root, guardedPath); writeFileSync(guarded, nativeBytes);
    const originalRun = project.runner.run.bind(project.runner); let wroteExternal = false;
    project.runner.run = async spec => { const result = await originalRun(spec); if (spec.args.includes('netlist') && !spec.args.includes('--help') && !wroteExternal) { writeFileSync(guarded, Buffer.concat([nativeBytes, Buffer.from('\n')])); wroteExternal = true; } return result; };
    const race = response<OperationReceipt>(await kicad.handle(request('kicad.generate', { mappingPath: 'components/kicad.json', expectedManifestSha256: project.files.inspectManifest().sha256, sourcePath: guardedPath, expectedSourceSha256: digest(nativeBytes) }, manifest.projectRevision))), raced = await project.jobs.wait(race.operationId);
    assert.equal(raced.status, 'failed'); assert.equal(raced.error?.code, 'REVISION_CONFLICT'); assert.equal(readFileSync(guarded).toString(), nativeBytes.toString() + '\n'); assert.equal(wroteExternal, true);
    const report = { status: 'passed', kind: 'actual-native-cli', physicalHardwareVerified: false, capability, generation: complete, independentReopen: reopened, nativeImportedValidation: nativeComplete, noConnect, actualErcViolation: violation, nativeExternalSaveRace: raced, preservedExternalSha256: digest(readFileSync(guarded)), exported, run };
    writeFileSync(join(run, 'result.json'), JSON.stringify(report, null, 2)); process.stdout.write(`${JSON.stringify({ status: 'passed', run, executableSha256: config.testedExecutableSha256 })}\n`);
  } catch (error) { writeFileSync(join(run, 'failure.json'), JSON.stringify({ status: 'failed', error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : null }, null, 2)); throw error; }
  finally { await project.shutdown(); }
}
void main().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
