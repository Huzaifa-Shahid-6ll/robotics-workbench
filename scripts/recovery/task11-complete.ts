import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { CompanionClient } from '../../apps/extension/src/companion-client';
import { netlistEndpoints, parseErc } from '@robotics-workbench/kicad';
import { kicadFixture } from '../../packages/test-fixtures/kicad/fixtures';
import { createParserProfile, StreamingTelemetryParser } from '@robotics-workbench/serial';
import { pdfFixture } from '../../packages/test-fixtures/documents/fixtures';
import type { CadExport, CadSnapshot, CadViewer, DocumentExcerpt, ExperimentProcedure, ExperimentRun, KicadExport, KicadPreview, KicadSnapshot, OperationReceipt, ParserProfile, ProjectRequest, RecordingSelection, TelemetryWindow, WorkbenchManifest } from '@robotics-workbench/contracts';
import type { StoredRecording } from '../../apps/companion/src/hardware-service';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'), pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function argsFor(values: string[]) {
  const [projectRoot, dataRoot, ...flags] = values;
  assert.ok(projectRoot && dataRoot && isAbsolute(projectRoot) && isAbsolute(dataRoot), 'Supply absolute projectRoot and dataRoot.');
  const reference = relative(resolve('verification/evidence/task-11/hardware'), resolve(projectRoot)).replaceAll('\\', '/');
  assert.match(reference, /^[a-f0-9-]{36}\/project\/WorkbenchProbe$/i, 'Only the dedicated TASK-11 bench project is authorized.');
  assert.equal(resolve(dataRoot).toLowerCase(), join(dirname(dirname(resolve(projectRoot))), 'data').toLowerCase(), 'Use that bench project\'s existing operational root.');
  for (let index = 0; index < flags.length; index += 2) assert.ok(['--kicad', '--python', '--resume'].includes(flags[index]) && flags[index + 1] && isAbsolute(flags[index + 1]), 'Only explicit existing KiCad/Python overrides or a prior complete-run directory are accepted.');
  return { projectRoot: resolve(projectRoot), dataRoot: resolve(dataRoot), kicad: flags.includes('--kicad') ? flags[flags.indexOf('--kicad') + 1] : undefined, python: flags.includes('--python') ? flags[flags.indexOf('--python') + 1] : undefined, resume: flags.includes('--resume') ? resolve(flags[flags.indexOf('--resume') + 1]) : undefined };
}
function numericEvidence(window: TelemetryWindow) {
  assert.ok(Number.isSafeInteger(window.totalSamples) && window.totalSamples > 0, 'Retained recording has no complete parsed counter samples.');
  assert.ok(window.samples.length > 0 && window.samples.every(sample => sample.channelId === 'counter' && Number.isFinite(sample.value)));
  assert.equal(window.statistics.find(statistic => statistic.channelId === 'counter')?.count, window.totalSamples);
  assert.ok(window.gaps.length > 0, 'Retained interruption/parse gaps must remain disclosed.');
}
function inventory(dataRoot: string, projectId: string) {
  const db = new DatabaseSync(join(dataRoot, 'workbench.sqlite'), { readOnly: true });
  try { return { operations: db.prepare('SELECT receipt FROM operations WHERE project_id=? ORDER BY rowid').all(projectId).map(row => JSON.parse(String(row.receipt)) as OperationReceipt), recordings: db.prepare('SELECT body FROM recordings WHERE project_id=? ORDER BY rowid').all(projectId).map(row => JSON.parse(String(row.body)) as StoredRecording), artifactCount: Number(db.prepare('SELECT COUNT(*) AS count FROM artifacts WHERE project_id=?').get(projectId)!.count) }; }
  finally { db.close(); }
}
function writeNew(path: string, bytes: Uint8Array) { assert.equal(existsSync(path), false, `Existing ordinary file was preserved: ${path}`); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes, { flag: 'wx' }); }

async function main() {
  if (process.argv.includes('--self-test')) {
    assert.throws(() => argsFor(['relative', 'data']));
    const root = resolve('verification/evidence/task-11/hardware/00000000-0000-4000-8000-000000000001/project/WorkbenchProbe'), data = join(dirname(dirname(root)), 'data');
    assert.equal(argsFor([root, data]).projectRoot, root); assert.throws(() => argsFor([root, root])); assert.throws(() => argsFor([root, data, '--upload', 'anything']));
    assert.equal(argsFor([root, data, '--resume', resolve('verification/evidence/task-11/complete/prior')]).resume, resolve('verification/evidence/task-11/complete/prior'));
    const profile = createParserProfile({ schemaVersion: 1, id: '00000000-0000-4000-8000-000000000001', parserVersion: 'telemetry-v1', mode: 'labeled-numeric', channels: [{ channelId: 'counter', label: 'Counter', source: 'counter', unit: 'ms' }] });
    const record = (text: string, sequence: number) => ({ schemaVersion: 1 as const, recordingId: root.split(sep)[0], connectionSessionId: '00000000-0000-4000-8000-000000000002', sequence, hostElapsedNs: String(sequence * 1000000), hostReceivedAt: new Date(0).toISOString(), bytesBase64: Buffer.from(text).toString('base64'), quality: 'received' as const });
    const incomplete = new StreamingTelemetryParser(profile); assert.equal(incomplete.push({ ...record('counter:0', 0), recordingId: profile.id }).samples.length, 0); assert.equal(incomplete.finish().samples.length, 0);
    const complete = new StreamingTelemetryParser(profile); assert.equal(complete.push({ ...record('counter:', 0), recordingId: profile.id }).samples.length, 0); assert.equal(complete.push({ ...record('0\r\n', 1), recordingId: profile.id }).samples.length, 1);
    assert.throws(() => numericEvidence({ totalSamples: 0 } as TelemetryWindow), /no complete/);
    console.log('TASK-11 complete-journey argument and fragmented-counter self-check passed; no files, companion, native tools or hardware were opened.'); return;
  }
  const options = argsFor(process.argv.slice(2)), { projectRoot, dataRoot } = options;
  for (const path of [projectRoot, dataRoot]) assert.equal(realpathSync(path).toLowerCase(), path.toLowerCase(), 'Fixture roots cannot traverse junctions.');
  const benchDirectory = dirname(dirname(projectRoot)), benchPath = join(benchDirectory, 'result.json'), benchBytes = readFileSync(benchPath), bench = JSON.parse(benchBytes.toString('utf8'));
  assert.equal(bench.taskId, 'TASK-11'); assert.equal(bench.serial, 'PRIVATE_BENCH_SERIAL_WITHHELD'); assert.equal(bench.upload?.status, 'succeeded', 'Known exact-upload evidence is required. A human unplug timeout remains separate.');
  const sourcePath = join(projectRoot, 'WorkbenchProbe.ino'), source = readFileSync(sourcePath), expectedSource = readFileSync('packages/test-fixtures/arduino/WorkbenchProbe/WorkbenchProbe.ino');
  assert.equal(sha(source), sha(expectedSource)); assert.equal(sha(source), bench.sourceSha256);
  const manifestPath = join(projectRoot, 'workbench.json'), originalManifest = readFileSync(manifestPath), manifest = JSON.parse(originalManifest.toString('utf8')) as WorkbenchManifest;
  const priorPath = options.resume ? join(options.resume, 'result.json') : undefined, priorBytes = priorPath ? readFileSync(priorPath) : undefined, prior = priorBytes ? JSON.parse(priorBytes.toString('utf8')) : undefined;
  assert.equal(manifest.projectId, bench.projectId);
  if (prior) {
    assert.equal(prior.taskId, 'TASK-11'); assert.equal(prior.projectRoot, projectRoot); assert.equal(prior.dataRoot, dataRoot); assert.equal(prior.sourceSha256, sha(source)); assert.equal(manifest.projectRevision, prior.projectRevision);
    assert.equal((manifest.extensions.task11CompleteFixture as { runId: string }).runId, prior.runId);
    for (const file of prior.seededFiles) assert.equal(sha(readFileSync(join(projectRoot, file.path))), file.sha256, `Seeded source changed: ${file.path}`);
    for (const id of ['task11.complete.document', 'task11.complete.kicad', 'task11.complete.cad']) assert.ok(prior.checks.some((check: { testId: string; result: string }) => check.testId === id && check.result === 'passed'));
  } else { assert.equal(manifest.projectRevision, bench.projectRevision); assert.equal(manifest.components.length, 0); assert.equal(manifest.nets.length, 0); }
  const before = inventory(dataRoot, manifest.projectId); assert.ok(before.operations.every(operation => !['queued', 'running', 'awaiting-input'].includes(operation.status)), 'Finish existing operations before extending the fixture.'); assert.equal(before.operations.filter(operation => operation.kind === 'upload').length, 1);
  const runId = randomUUID(), directory = resolve('verification/evidence/task-11/complete', runId); mkdirSync(directory, { recursive: true });
  const evidence: Record<string, unknown> = { schemaVersion: 1, taskId: 'TASK-11', runId, evidenceClass: 'actual-native-software-with-retained-hardware-evidence', startedAt: new Date().toISOString(), projectId: manifest.projectId, projectRoot, dataRoot, bench: { path: benchPath, sha256: sha(benchBytes), runId: bench.runId, result: bench.result }, sourceSha256: sha(source), environment: { platform: platform(), release: release(), arch: arch(), node: process.version }, commands: [], checks: [], limitations: ['CAD geometry and logical connector wiring are explicitly synthetic design choices, never measurements of physical hardware.', 'The document is a synthetic PDF extraction fixture, not a manufacturer datasheet.', 'The actual Uno bytes are historical recording evidence. No USB port, compile or upload is requested by this runner.', 'Viewer handoff creation proves an exact selected artifact and public instructions; it does not assert GUI rendering or physical fit.', 'Any unresolved human unplug/replug or accessibility gate remains unresolved by these software/native checks.'] };
  const save = () => writeFileSync(join(directory, 'result.json'), JSON.stringify(evidence, null, 2) + '\n'), phase = (name: string) => { evidence.phase = name; save(); console.log(`TASK11_COMPLETE ${name} ${directory}`); };
  const native = async (id: string, executable: string, args: string[], cwd = directory, timeout = 300000) => {
    const startedAt = new Date().toISOString(), command = { id, executable, executableSha256: sha(readFileSync(executable)), args, cwd, startedAt, endedAt: '', result: 'failed', stdout: '', stderr: '' };
    try { const result = await promisify(execFile)(executable, args, { cwd, timeout, windowsHide: true, maxBuffer: 1024 * 1024, env: Object.fromEntries([...['SystemRoot', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE'].filter(key => process.env[key]).map(key => [key, process.env[key]!] as [string, string]), ['TEMP', directory], ['TMP', directory], ['LC_ALL', 'C'], ['LANG', 'C']]) }); command.stdout = result.stdout; command.stderr = result.stderr; command.result = 'passed'; return result.stdout; }
    catch (error) { command.stderr = String(error); throw error; }
    finally { command.endedAt = new Date().toISOString(); (evidence.commands as unknown[]).push(command); save(); }
  };
  let client: CompanionClient | undefined;
  try {
    phase('inspect-installed-tools');
    const referenceKiCad = JSON.parse(readFileSync('verification/evidence/task-10/installed-kicad/665ec7ad-27a2-4c63-8538-1f4a5a9375ea/result.json', 'utf8')).capability;
    const referenceCad = JSON.parse(readFileSync('verification/evidence/task-10/native/cad/13494b10-37aa-4bcc-b868-f3230c0da1d6/evidence.json', 'utf8'));
    const kicadPath = options.kicad ?? referenceKiCad.executable, pythonPath = options.python ?? referenceCad.pythonPath;
    for (const path of [kicadPath, pythonPath]) assert.ok(isAbsolute(path) && existsSync(path) && lstatSync(path).isFile(), `TOOL_UNAVAILABLE: configure an existing previously validated executable; no install was attempted: ${path}`);
    assert.equal(sha(readFileSync(kicadPath)), referenceKiCad.executableSha256, 'KiCad executable differs from its native compatibility evidence.');
    assert.equal((await native('kicad.version', kicadPath, ['--version'], directory, 15000)).trim(), '10.0.8');
    const pythonCode = "import importlib.metadata,json,platform;print(json.dumps({'python':platform.python_version(),'packages':{d.metadata['Name'].lower().replace('_','-').replace('.','-'):d.version for d in importlib.metadata.distributions()}}))";
    const environment = JSON.parse(await native('cad.environment', pythonPath, ['-B', '-I', '-c', pythonCode], directory, 30000)); assert.deepEqual(environment, referenceCad.environment); evidence.tools = { kicadPath, kicadSha256: referenceKiCad.executableSha256, pythonPath, pythonSha256: sha(readFileSync(pythonPath)), environment };
    const electrical = kicadFixture();
    let documentId = prior?.documentCitation.documentId ?? randomUUID(), profileId = '', procedureId = '', seeded: Record<string, Uint8Array> = {}, next = manifest;
    let generated: OperationReceipt = prior?.kicadGeneration, geometry: OperationReceipt = prior?.cadGeneration;
    let citation: { documentId: string; artifactSha256: string; extractorVersion: string; page: number; region?: DocumentExcerpt['region']; textRange?: DocumentExcerpt['textRange'] } = prior?.documentCitation;
    if (!prior) {
    phase('extend-ordinary-fixture'); writeNew(join(directory, 'manifest.before.json'), originalManifest);
    profileId = randomUUID(); procedureId = randomUUID();
    seeded = { 'components/catalog.json': Buffer.from(JSON.stringify({ schemaVersion: 1, definitions: [electrical.definition] }, null, 2)), 'components/kicad.json': Buffer.from(JSON.stringify(electrical.mapping, null, 2)), 'documents/synthetic-reference.pdf': pdfFixture() };
    for (const name of ['assets.json', 'box.py', 'box_dimensions.py', 'parameters.json']) seeded[`mechanical/${name}`] = readFileSync(`packages/test-fixtures/cad/${name}`);
    const assetSource = JSON.parse(Buffer.from(seeded['mechanical/assets.json']).toString('utf8')); assetSource.assets[0].componentIds = [electrical.manifest.components[0].componentId]; seeded['mechanical/assets.json'] = Buffer.from(JSON.stringify(assetSource, null, 2));
    seeded['mechanical/environment.lock.json'] = Buffer.from(JSON.stringify(environment, null, 2));
    const profile: ParserProfile = { schemaVersion: 1, id: profileId, parserVersion: 'telemetry-v1', mode: 'labeled-numeric', channels: [{ channelId: 'counter', label: 'Recorded firmware millis counter', source: 'counter', unit: 'ms' }] };
    const procedure: ExperimentProcedure = { schemaVersion: 1, procedureId, version: 1, purpose: 'Offline inspection of previously recorded dedicated Uno counter evidence', setup: ['Retained actual Uno bytes; no new acquisition or sensor/actuator action.'], controlledInputs: ['Exact recording, parser and host-receive interval.'], instruments: ['Previously recorded UART bytes, not a physical measurement instrument.'], steps: ['Derive exact retained counter samples.', 'Inspect gaps and immutable identities.', 'Record an inconclusive physical judgment.'], expectedOutputs: ['Finite reported counter values and explicit capture interruption gaps.'], tolerances: ['No physical accuracy or sensor acceptance threshold is specified.'], stopConditions: ['Do not open a port or repeat an upload.'], decisionRules: ['Physical function remains inconclusive; a valid plot is not a hardware pass.'] };
    seeded['telemetry/parsers.json'] = Buffer.from(JSON.stringify({ schemaVersion: 1, profiles: [profile] }, null, 2)); seeded['experiments/procedures.json'] = Buffer.from(JSON.stringify({ schemaVersion: 1, procedures: [procedure] }, null, 2));
    for (const [path, bytes] of Object.entries(seeded)) assert.equal(existsSync(join(projectRoot, path)), false, `Existing feature source requires review: ${path}`);
    assert.deepEqual(readFileSync(manifestPath), originalManifest); assert.deepEqual(readFileSync(sourcePath), source);
    for (const [path, bytes] of Object.entries(seeded)) writeNew(join(projectRoot, path), bytes);
    next = { ...manifest, projectRevision: manifest.projectRevision + 1, components: electrical.manifest.components, nets: electrical.manifest.nets, documents: [...manifest.documents, { documentId, path: 'documents/synthetic-reference.pdf', title: 'Synthetic PDF extraction fixture; no electrical authority', componentIds: electrical.manifest.components.map(component => component.componentId) }], extensions: { ...manifest.extensions, task11CompleteFixture: { runId, syntheticDesign: true, physicalWiring: 'unknown' } } };
    writeFileSync(manifestPath, JSON.stringify(next, null, 2)); evidence.projectRevision = next.projectRevision; evidence.seededFiles = Object.entries(seeded).map(([path, bytes]) => ({ path, sha256: sha(bytes) }));
    } else {
      seeded = Object.fromEntries(prior.seededFiles.map((file: { path: string }) => [file.path, readFileSync(join(projectRoot, file.path))]));
      profileId = JSON.parse(Buffer.from(seeded['telemetry/parsers.json']).toString()).profiles[0].id;
      procedureId = JSON.parse(Buffer.from(seeded['experiments/procedures.json']).toString()).procedures[0].procedureId;
      evidence.resumedFrom = { path: priorPath, sha256: sha(priorBytes!), runId: prior.runId };
      for (const key of ['projectRevision', 'seededFiles', 'documentIngest', 'documentCitation', 'kicadGeneration', 'kicadExport', 'cadGeneration', 'independentCad', 'viewer']) evidence[key] = prior[key];
      evidence.checks = prior.checks.map((check: Record<string, unknown>) => ({ ...check, sourceRunId: prior.runId }));
    }
    const procedure = JSON.parse(Buffer.from(seeded['experiments/procedures.json']).toString()).procedures[0] as ExperimentProcedure;
    const assetId = '99999999-9999-4999-8999-999999999999';
    const script = resolve('apps/extension/dist/companion.js'), companionSha256 = sha(readFileSync(script)); evidence.companionSha256 = companionSha256;
    const connect = (root: string, data: string) => new CompanionClient(script, process.execPath, line => console.log(line), () => {}, { projectRoot: root, dataRoot: data, kicadPath, kicadSha256: referenceKiCad.executableSha256, cadPythonPath: pythonPath });
    client = connect(projectRoot, dataRoot);
    const rpc = <T>(method: ProjectRequest['method'], params: Record<string, unknown> = {}, revision?: number) => client!.requestProject({ schemaVersion: 1, requestId: randomUUID(), projectId: manifest.projectId, method, params, ...(revision === undefined ? {} : { expectedProjectRevision: revision }) }) as Promise<T>;
    const finish = async (operation: OperationReceipt) => { const until = Date.now() + 360000; while (['queued', 'running', 'awaiting-input'].includes(operation.status)) { assert.ok(Date.now() < until, 'Native job did not produce a terminal receipt; it was not replayed.'); await pause(200); operation = await rpc('operation.get', { operationId: operation.operationId }); } assert.equal(operation.status, 'succeeded', JSON.stringify(operation.error)); return operation; };
    await client.start(); assert.deepEqual(await rpc('device.status'), []);
    if (!prior) {
    phase('document-and-exact-citation');
    evidence.documentIngest = await finish(await rpc('document.ingest', { documentId, expectedSha256: sha(seeded['documents/synthetic-reference.pdf']) }, next.projectRevision));
    const query = await rpc<{ excerpts: DocumentExcerpt[] }>('document.query', { query: 'Supply', documentIds: [documentId], limit: 5 }); assert.ok(query.excerpts.length); const excerpt = query.excerpts[0]; assert.equal(excerpt.page, 1); assert.equal(excerpt.artifactSha256, sha(seeded['documents/synthetic-reference.pdf']));
    citation = { documentId, artifactSha256: excerpt.artifactSha256, extractorVersion: excerpt.extractorVersion, page: excerpt.page, ...(excerpt.region ? { region: excerpt.region } : {}), ...(excerpt.textRange ? { textRange: excerpt.textRange } : {}) };
    const page = await rpc<{ citation: DocumentExcerpt; text: string; image: { dataUrl: string } | null }>('document.page', citation); assert.match(page.text, /Supply/); assert.equal(page.citation.documentId, documentId); assert.ok(page.image, 'Actual PDF page render must be available.'); evidence.documentCitation = citation; writeFileSync(join(directory, 'document-page.png'), Buffer.from(page.image.dataUrl.split(',')[1], 'base64'));
    (evidence.checks as unknown[]).push({ testId: 'task11.complete.document', result: 'passed', citation, pngSha256: sha(readFileSync(join(directory, 'document-page.png'))) });
    phase('native-kicad-generation');
    const schematic = await rpc<KicadSnapshot>('kicad.snapshot'); assert.equal(schematic.readiness.available, true, schematic.readiness.reason); generated = await finish(await rpc('kicad.generate', { mappingPath: 'components/kicad.json', expectedManifestSha256: schematic.manifestSha256 }, next.projectRevision)); assert.equal(generated.result!.netlistEquivalent, true); assert.equal(generated.result!.verdict, 'pass'); evidence.kicadGeneration = generated;
    const preview = await rpc<KicadPreview>('kicad.preview', { generationId: generated.result!.generationId }); assert.equal(preview.stale, false); writeFileSync(join(directory, 'schematic.svg'), Buffer.from(preview.dataUrl.split(',')[1], 'base64'));
    mkdirSync(join(projectRoot, 'engineering'), { recursive: true }); const exported = await rpc<KicadExport>('kicad.export', { generationId: generated.result!.generationId, destinationPath: 'engineering/task11-schematic' }, next.projectRevision); evidence.kicadExport = exported;
    const reopenedNetlist = join(directory, 'independent.net'); await native('kicad.independent-reopen', kicadPath, ['sch', 'export', 'netlist', '--format', 'kicadxml', '--output', reopenedNetlist, join(exported.path, 'design.kicad_sch')], exported.path, 120000); assert.deepEqual(netlistEndpoints(readFileSync(reopenedNetlist, 'utf8')), [['J1:1', 'J2:1'], ['J1:2', 'J2:2']]);
    const ercPath = join(directory, 'independent-erc.json'); await native('kicad.independent-erc', kicadPath, ['sch', 'erc', '--format', 'json', '--severity-all', '--exit-code-violations', '--output', ercPath, join(exported.path, 'design.kicad_sch')], exported.path, 120000); assert.equal(parseErc(readFileSync(ercPath, 'utf8'), 0).verdict, 'pass'); (evidence.checks as unknown[]).push({ testId: 'task11.complete.kicad', result: 'passed', operationId: generated.operationId, generationId: generated.result!.generationId, endpointSets: [['J1:1', 'J2:1'], ['J1:2', 'J2:2']] });
    phase('native-cad-generation');
    const cad = await rpc<CadSnapshot>('cad.snapshot'), asset = cad.assets.find(asset => asset.assetId === assetId)!; assert.ok(asset?.currentFingerprint); assert.equal(cad.capabilities.configured, true); geometry = await finish(await rpc('cad.generate', { assetId, expectedFingerprint: asset.currentFingerprint, mode: 'production' }, next.projectRevision)); evidence.cadGeneration = geometry;
    const step = await rpc<CadExport>('cad.export', { assetId, operationId: geometry.operationId, format: 'step' }), stl = await rpc<CadExport>('cad.export', { assetId, operationId: geometry.operationId, format: 'stl' }); assert.equal(step.productionAllowed, true); assert.equal(step.unit, 'mm'); assert.equal(sha(readFileSync(step.path)), step.sha256); assert.equal(sha(readFileSync(stl.path)), stl.sha256);
    const reopenCode = "import cadquery as cq,json,sys;from OCP.StlAPI import StlAPI_Reader;from OCP.TopoDS import TopoDS_Shape;s=cq.importers.importStep(sys.argv[1]).val();b=s.BoundingBox();assert s.isValid() and abs(s.Volume()-600)<0.001;assert all(abs(a-v)<0.001 for a,v in zip((b.xlen,b.ylen,b.zlen),(20,10,3)));m=TopoDS_Shape();assert StlAPI_Reader().Read(m,sys.argv[2]) and not m.IsNull();print(json.dumps({'valid':True,'volumeMm3':s.Volume(),'boundsMm':[b.xlen,b.ylen,b.zlen]}))";
    evidence.independentCad = JSON.parse(await native('cad.independent-step-stl-reopen', pythonPath, ['-B', '-I', '-c', reopenCode, step.path, stl.path], projectRoot));
    const viewer = await rpc<CadViewer>('cad.viewer', { assetId, operationId: geometry.operationId }); assert.match(viewer.script, /from ocp_vscode import show/); assert.ok(viewer.script.includes(step.sha256)); evidence.viewer = viewer;
    writeNew(join(projectRoot, 'mechanical/exports/task11-model.step'), readFileSync(step.path)); writeNew(join(projectRoot, 'mechanical/exports/task11-model.stl'), readFileSync(stl.path));
    (evidence.checks as unknown[]).push({ testId: 'task11.complete.cad', result: 'passed', operationId: geometry.operationId, stepSha256: step.sha256, stlSha256: stl.sha256, viewerStatus: viewer.status, physicalFit: 'unknown' });
    } else {
      phase('verify-retained-native-phases');
      assert.deepEqual(await rpc('operation.get', { operationId: generated.operationId }), generated);
      assert.deepEqual(await rpc('operation.get', { operationId: geometry.operationId }), geometry);
      assert.equal((await rpc<{ citation: DocumentExcerpt }>('document.page', citation)).citation.artifactSha256, citation.artifactSha256);
    }
    const step = await rpc<CadExport>('cad.export', { assetId, operationId: geometry.operationId, format: 'step' });
    assert.equal(sha(readFileSync(step.path)), step.sha256);
    phase('derive-real-recording-and-experiment');
    const telemetry = await rpc<{ recordings: { recordingId: string; completion: string }[] }>('telemetry.snapshot'), originalRecordings = before.recordings;
    const candidates = originalRecordings.filter(recording => recording.rawBytes > 0 && !recording.gaps.some(gap => gap.cause === 'upload') && telemetry.recordings.some(item => item.recordingId === recording.recordingId)).sort((a, b) => Number(b.gaps.some(gap => gap.cause === 'disconnect')) - Number(a.gaps.some(gap => gap.cause === 'disconnect')) || b.rawBytes - a.rawBytes);
    let recording: StoredRecording | undefined, window: TelemetryWindow | undefined;
    evidence.recordingCandidates = [];
    for (const candidate of candidates) {
      const derived = await finish(await rpc('telemetry.derive', { recordingId: candidate.recordingId, profileId }, next.projectRevision));
      const queried = await rpc<TelemetryWindow>('telemetry.query', { derivationId: derived.result!.derivationId, channelIds: ['counter'], timeBasis: 'host-receive', start: 0, end: 3600000 });
      (evidence.recordingCandidates as unknown[]).push({ recordingId: candidate.recordingId, rawBytes: candidate.rawBytes, derivationId: queried.derivationId, totalSamples: queried.totalSamples, statistics: queried.statistics, gaps: queried.gaps, issues: queried.issues.slice(0, 3) }); save();
      if (!queried.totalSamples) continue;
      numericEvidence(queried); recording = candidate; window = queried; break;
    }
    assert.ok(recording && window, 'No actual retained recording contains complete parsed counter samples. Raw-only crash records remain valid interruption evidence.');
    const selection: RecordingSelection = { schemaVersion: 1, recordingId: recording.recordingId, derivationId: window.derivationId, configurationSha256: window.configurationSha256, parserVersion: window.parserVersion, channelIds: ['counter'], timeBasis: 'host-receive', start: window.start, end: window.end, projectRevision: bench.projectRevision };
    assert.deepEqual((await rpc<{ selection: RecordingSelection }>('telemetry.selection', { selection })).selection, selection); evidence.recordingSelection = selection;
    let run = await rpc<ExperimentRun>('experiment.create', { procedureId, recordingId: recording.recordingId, setup: procedure.setup[0], parameters: {} }, next.projectRevision);
    for (const lifecycle of ['ready', 'running', 'completed'] as const) { if (lifecycle === 'running') run = await rpc('experiment.attach', { experimentId: run.experimentId, expectedRevisionId: run.revisionId, selection }, next.projectRevision); run = await rpc('experiment.transition', { experimentId: run.experimentId, expectedRevisionId: run.revisionId, lifecycle }, next.projectRevision); }
    run = await rpc('experiment.judge', { experimentId: run.experimentId, expectedRevisionId: run.revisionId, outcome: 'inconclusive', criterion: 'Retained UART counter data and explicit gaps establish software evidence handling only; no sensor/actuator acceptance procedure or physical measurement exists.' }, next.projectRevision); assert.equal(run.judgment.outcome, 'inconclusive'); evidence.experiment = run;
    const linked = await rpc<{ projectRevision: number; component: { componentId: string }; documents: { documentId: string }[] }>('component.inspect', { componentId: electrical.manifest.components[0].componentId }); assert.equal(linked.component.componentId, electrical.manifest.components[0].componentId); assert.ok(linked.documents.some(document => document.documentId === documentId)); assert.equal(linked.projectRevision, next.projectRevision);
    (evidence.checks as unknown[]).push({ testId: 'task11.complete.retained-recording', result: 'passed', derivationId: window.derivationId, selection, experimentId: run.experimentId, outcome: run.judgment.outcome, componentId: linked.component.componentId, documentId });
    phase('portable-full-project-archive');
    assert.deepEqual(await rpc('operation.get', { operationId: bench.upload.operationId }), bench.upload); assert.deepEqual(await rpc('device.status'), []); assert.deepEqual(readFileSync(sourcePath), source);
    const beforeExport = inventory(dataRoot, manifest.projectId), snapshot = await rpc<{ manifestSha256: string }>('project.snapshot'), archiveDirectory = join(directory, 'archive');
    evidence.archive = await rpc('project.export', { destination: archiveDirectory, expectedManifestSha256: snapshot.manifestSha256, documentHashes: { 'WorkbenchProbe.ino': sha(source), ...Object.fromEntries(Object.entries(seeded).map(([path, bytes]) => [path, sha(bytes)])) } }, next.projectRevision);
    const restoredRoot = join(directory, 'restored-project'), restoredData = join(directory, 'restored-data'); evidence.restore = await rpc('project.restore', { archiveDirectory, newProjectRoot: restoredRoot, newDataRoot: restoredData }, next.projectRevision); await client.stop();
    const archive = JSON.parse(readFileSync(join(archiveDirectory, 'archive.json'), 'utf8')), backup = JSON.parse(readFileSync(join(archiveDirectory, 'operational/backup.json'), 'utf8'));
    for (const file of archive.files) assert.equal(sha(readFileSync(join(restoredRoot, file.path))), file.sha256);
    for (const artifact of backup.artifacts) assert.equal(sha(readFileSync(join(restoredData, artifact.relativePath))), artifact.sha256);
    const restored = inventory(restoredData, manifest.projectId); for (const original of beforeExport.operations) assert.deepEqual(restored.operations.find(operation => operation.operationId === original.operationId), original); assert.equal(restored.artifactCount, backup.artifacts.length);
    assert.equal(restored.operations.filter(operation => operation.kind === 'upload').length, 1); assert.equal(restored.operations.filter(operation => operation.kind === 'serial-capture').length, before.operations.filter(operation => operation.kind === 'serial-capture').length);
    client = connect(restoredRoot, restoredData); await client.start(); assert.deepEqual(await rpc('device.status'), []); assert.deepEqual(await rpc('operation.get', { operationId: bench.upload.operationId }), bench.upload); assert.equal((await rpc<{ citation: DocumentExcerpt }>('document.page', citation)).citation.artifactSha256, citation.artifactSha256);
    const restoredViewer = await rpc<CadViewer>('cad.viewer', { assetId, operationId: geometry.operationId }); assert.ok(restoredViewer.script.includes(restoredData.replaceAll('\\', '\\\\')) || restoredViewer.script.includes(restoredData.replaceAll('\\', '/'))); assert.ok(restoredViewer.script.includes(step.sha256));
    const restoredNet = join(directory, 'restored-independent.net'); await native('kicad.restored-independent-reopen', kicadPath, ['sch', 'export', 'netlist', '--format', 'kicadxml', '--output', restoredNet, join(restoredRoot, 'engineering/task11-schematic/design.kicad_sch')], join(restoredRoot, 'engineering/task11-schematic'), 120000); assert.deepEqual(netlistEndpoints(readFileSync(restoredNet, 'utf8')), [['J1:1', 'J2:1'], ['J1:2', 'J2:2']]);
    assert.deepEqual(await rpc('device.status'), []); await client.stop(); assert.equal(inventory(dataRoot, manifest.projectId).operations.filter(operation => operation.kind === 'upload').length, 1); assert.deepEqual(readFileSync(sourcePath), source);
    (evidence.checks as unknown[]).push({ testId: 'task11.complete.archive-restore', result: 'passed', sourceFiles: archive.files.length, artifactCount: backup.artifacts.length, preservedOperations: beforeExport.operations.length, originalUploadUnchanged: true, newUploadCount: 0, newCaptureCount: 0, restoredDeviceState: [] });
    evidence.crossView = { componentIds: electrical.manifest.components.map(component => component.componentId), documentCitation: citation, recordingSelection: selection, experimentId: run.experimentId, kicadGenerationId: generated.result!.generationId, cadOperationId: geometry.operationId }; evidence.result = 'passed'; phase('completed');
  } catch (error) { evidence.result = /TOOL_UNAVAILABLE/.test(String(error)) ? 'blocked' : 'failed'; evidence.error = String(error); phase(String(evidence.result)); throw error; }
  finally { await client?.stop(); evidence.endedAt = new Date().toISOString(); save(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
