import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { ProjectFiles, type ProcessResult, type ProcessSpec, type SourceSnapshot } from '@robotics-workbench/application';
import { ArduinoAdapter, fingerprintTree, type CompileInput } from '../src/index';
import { WorkbenchError } from '@robotics-workbench/contracts';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function result(stdout: string, exitCode = 0): ProcessResult { return { exitCode, signal: null, stdout, stderr: '', stdoutBytes: Buffer.byteLength(stdout), stderrBytes: 0,
  stdoutTruncated: false, stderrTruncated: false, logsTruncated: false, timedOut: false, cancelled: false, terminationObserved: true }; }

class FakeRunner {
  readonly calls: ProcessSpec[] = [];
  failCompile = false; missingOutput = false; malformed = false;
  compileOutcome: Partial<ProcessResult> = {};
  compilePlatform?: string;
  onCompile?: () => void;
  constructor(readonly data: string, readonly user: string, readonly platform: string) {}
  async run(spec: ProcessSpec): Promise<ProcessResult> {
    this.calls.push(spec); const args = spec.args;
    if (args[0] === 'version') return result(JSON.stringify({ VersionString: '1.5.1' }));
    if (args[0] === 'config') return result(JSON.stringify({ data: this.data, user: this.user, downloads: '' }));
    if (args[0] === 'core') return result(JSON.stringify({ platforms: [{ id: 'arduino:avr', installed_version: '1.8.8', releases: {} }] }));
    if (args[0] === 'lib') return result(JSON.stringify({ installed_libraries: [] }));
    if (args.includes('--help')) return result('--output-dir --build-path --show-properties --board-options --input-file');
    if (args[0] === 'board') return result(JSON.stringify({ detected_ports: [{ port: { address: 'COM22', protocol: 'serial', label: 'Synthetic Uno', properties: { vid: '0x2341', pid: '0x0043', serialNumber: 'fixture' } }, matching_boards: [{ name: 'Arduino Uno', fqbn: 'arduino:avr:uno' }] }] }));
    if (args[0] === 'upload') return result(JSON.stringify({ success: true }));
    const sketch = String(args.at(-1)), buildPath = String(args[args.indexOf('--build-path') + 1]);
    const props = [`runtime.platform.path=${!args.includes('--show-properties=expanded') && this.compilePlatform ? this.compilePlatform : this.platform}`, `build.path=${buildPath}`, `build.source.path=${sketch}`, `build.project_name=${basename(sketch)}.ino`, 'compiler.cpp.flags=-Os'];
    if (args.includes('--show-properties=expanded')) return result(JSON.stringify({ success: true, builder_result: { build_properties: props } }));
    this.onCompile?.();
    const output = String(args[args.indexOf('--output-dir') + 1]); mkdirSync(output, { recursive: true });
    if (!this.failCompile && !this.missingOutput) {
      writeFileSync(join(output, `${basename(sketch)}.ino.hex`), ':00000001FF\n');
      writeFileSync(join(output, `${basename(sketch)}.ino.with_bootloader.hex`), 'never selected for upload');
      writeFileSync(join(output, `${basename(sketch)}.ino.elf`), 'synthetic ELF');
    }
    if (this.malformed) return result('{malformed');
    return { ...result(JSON.stringify({ success: !this.failCompile, compiler_err: this.failCompile ? `${sketch}/Sketch.ino:2:3: error: synthetic compile failure` : '', builder_result: { build_properties: props, used_libraries: [] } }), this.failCompile ? 1 : 0), ...this.compileOutcome };
  }
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-arduino-'));
  const root = join(directory, 'project'), data = join(directory, 'data'), user = join(directory, 'user'), platform = join(data, 'packages', 'arduino', 'hardware', 'avr', '1.8.8');
  mkdirSync(join(root, 'Sketch'), { recursive: true }); mkdirSync(platform, { recursive: true }); mkdirSync(join(user, 'libraries', 'LocalLib'), { recursive: true });
  writeFileSync(join(root, 'Sketch', 'Sketch.ino'), 'void setup() {}\nvoid loop() {}\n');
  writeFileSync(join(platform, 'platform.txt'), 'compiler.cpp.flags=-Os'); writeFileSync(join(user, 'libraries', 'LocalLib', 'header.h'), '#define VALUE 1');
  const files = new ProjectFiles(root), runner = new FakeRunner(data, user, platform), adapter = new ArduinoAdapter(runner, process.execPath, join(directory, 'work'));
  const snapshot = () => files.snapshotSource({ paths: ['Sketch'], host: () => ({ dirtyPaths: [] }) });
  const input = (): CompileInput => ({ snapshot: snapshot(), sketchRelativePath: 'Sketch', fqbn: 'arduino:avr:uno', boardOptions: {} });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, root, data, user, platform, files, runner, adapter, snapshot, input };
}

test('saved ordinary sketch compiles through literal arguments and selects only the exact non-bootloader artifact', async t => {
  const { root, adapter, runner, input } = fixture(t), original = readFileSync(join(root, 'Sketch', 'Sketch.ino'));
  const compiled = await adapter.compile(input());
  assert.equal(compiled.succeeded, true); assert.equal(compiled.uploadArtifact?.path.endsWith('Sketch.ino.hex'), true);
  assert.equal(compiled.outputs.length, 3); assert.equal(compiled.uploadArtifact?.sha256, hash(':00000001FF\n'));
  assert.deepEqual(readFileSync(join(root, 'Sketch', 'Sketch.ino')), original);
  assert.ok(runner.calls.every(call => !call.args.includes('--upload') && !call.args.includes('--programmer') && !call.args.includes('--port')));
  const second = await adapter.compile(input()); assert.equal(second.inputFingerprint, compiled.inputFingerprint, 'Operation-specific staging paths do not change build currency.');
});

test('board options, source and locally edited library contents change complete build identity', async t => {
  const { root, user, adapter, input } = fixture(t);
  const original = await adapter.compile(input());
  await adapter.assertCurrent(original);
  const changedOptions = await adapter.compile({ ...input(), boardOptions: { cpu: 'atmega328p' } });
  assert.notEqual(changedOptions.inputFingerprint, original.inputFingerprint);
  writeFileSync(join(user, 'libraries', 'LocalLib', 'header.h'), '#define VALUE 2');
  await assert.rejects(adapter.assertCurrent(original), { code: 'REVISION_CONFLICT' });
  const changedLibrary = await adapter.compile(input()); assert.notEqual(changedLibrary.inputFingerprint, original.inputFingerprint);
  writeFileSync(join(root, 'Sketch', 'Sketch.ino'), 'void setup() { }\nvoid loop() { }\n');
  assert.notEqual((await adapter.compile(input())).inputFingerprint, changedLibrary.inputFingerprint);
});

test('failed compile has scoped diagnostics, no outputs and no uploader invocation despite older successful files', async t => {
  const { adapter, runner, input } = fixture(t);
  await adapter.compile(input()); runner.failCompile = true;
  const failed = await adapter.compile(input());
  assert.equal(failed.succeeded, false); assert.deepEqual(failed.outputs, []); assert.equal(failed.uploadArtifact, undefined);
  assert.equal(failed.diagnostics[0].path, 'Sketch/Sketch.ino'); assert.equal(failed.diagnostics[0].line, 2);
  assert.equal(runner.calls.some(call => call.args[0] === 'upload' && !call.args.includes('--help')), false);
});

test('malformed output, missing artifact, changed dependency and mismatched saved source fail closed', async t => {
  const { adapter, runner, input, platform } = fixture(t);
  runner.malformed = true; await assert.rejects(adapter.compile(input()), { code: 'INVALID_REQUEST' });
  runner.malformed = false; runner.missingOutput = true; await assert.rejects(adapter.compile(input()), { code: 'ARTIFACT_MISMATCH' });
  runner.missingOutput = false; runner.onCompile = () => writeFileSync(join(platform, 'platform.txt'), 'changed while compiler ran');
  await assert.rejects(adapter.compile(input()), { code: 'REVISION_CONFLICT' }); runner.onCompile = undefined;
  const invalid = input(); invalid.snapshot.files[0].bytes = Buffer.from('different');
  await assert.rejects(adapter.compile(invalid), { code: 'ARTIFACT_MISMATCH' });
});

test('upload validates artifact bytes before launch and passes exact file, target and port without fallback', async t => {
  const { adapter, runner, input } = fixture(t);
  const build = await adapter.compile(input()), artifact = build.uploadArtifact!;
  const before = runner.calls.length;
  await assert.rejects(adapter.upload({ artifactPath: artifact.path, artifactSha256: '0'.repeat(64), fqbn: build.fqbn, port: 'COM22' }), { code: 'ARTIFACT_MISMATCH' });
  assert.equal(runner.calls.length, before);
  await adapter.upload({ artifactPath: artifact.path, artifactSha256: artifact.sha256, fqbn: build.fqbn, port: 'COM22' });
  const args = runner.calls.at(-1)!.args;
  assert.deepEqual(args, ['upload', '--fqbn', 'arduino:avr:uno', '--port', 'COM22', '--input-file', artifact.path, '--json']);
  await assert.rejects(adapter.upload({ artifactPath: artifact.path.replace('.ino.hex', '.ino.with_bootloader.hex'), artifactSha256: artifact.sha256, fqbn: build.fqbn, port: 'COM22' }), { code: 'INVALID_REQUEST' });
  await assert.rejects(adapter.upload({ artifactPath: artifact.path, artifactSha256: artifact.sha256, fqbn: 'arduino:avr:nano', port: 'COM22' }), { code: 'UNSUPPORTED_ENVIRONMENT' });
});

test('root-folder sketches preserve matching name and profile metadata cannot silently install dependencies', async t => {
  const { root, adapter, runner, input, files } = fixture(t);
  writeFileSync(join(root, 'RootSketch.ino'), 'void setup() {}\nvoid loop() {}');
  const rootInput = { ...input(), snapshot: files.snapshotSource({ paths: ['RootSketch.ino'], host: () => ({ dirtyPaths: [] }) }), sketchRelativePath: '.', rootSketchName: 'RootSketch' };
  assert.equal((await adapter.compile(rootInput)).uploadArtifact?.path.endsWith('RootSketch.ino.hex'), true);
  writeFileSync(join(root, 'Sketch', 'sketch.yaml'), 'default_profile: online-profile\n');
  const before = runner.calls.length; await assert.rejects(adapter.compile(input()), { code: 'UNSUPPORTED_ENVIRONMENT' });
  assert.equal(runner.calls.length, before);
});

test('discovery parses bounded serial evidence without conflating FQBN and transport identity', async t => {
  const { adapter, runner } = fixture(t);
  const ports = await adapter.discover(); assert.equal(ports[0].address, 'COM22'); assert.equal(ports[0].matchingBoards[0].fqbn, 'arduino:avr:uno');
  assert.equal(runner.calls.length, 1); assert.deepEqual(runner.calls[0].args, ['board', 'list', '--json']);
});

test('missing tools and unobserved compiler termination remain distinct actionable failures', async t => {
  const { adapter, runner, input, directory } = fixture(t);
  assert.throws(() => new ArduinoAdapter(runner, join(directory, 'missing-cli.exe'), join(directory, 'unused')), { code: 'TOOL_UNAVAILABLE' });
  runner.compileOutcome = { terminationObserved: false };
  await assert.rejects(adapter.compile(input()), { code: 'OUTCOME_UNKNOWN' });
  runner.compileOutcome = { timedOut: true };
  await assert.rejects(adapter.compile(input()), { code: 'TIMEOUT' });
  runner.compileOutcome = { cancelled: true };
  await assert.rejects(adapter.compile(input()), { code: 'CANCELLED' });
});

test('last upload check can reject source/target races after inspection and artifact is rehashed after that check', async t => {
  const { adapter, runner, input } = fixture(t), artifact = (await adapter.compile(input())).uploadArtifact!;
  const request = { artifactPath: artifact.path, artifactSha256: artifact.sha256, fqbn: 'arduino:avr:uno', port: 'COM22' };
  const uploads = () => runner.calls.filter(call => call.args[0] === 'upload' && !call.args.includes('--help')).length;
  await assert.rejects(adapter.upload({ ...request, beforeExecute: () => {
    assert.deepEqual(runner.calls.at(-1)!.args, ['upload', '--help']);
    throw new WorkbenchError('REVISION_CONFLICT', 'Saved source changed during inspection.');
  } }), { code: 'REVISION_CONFLICT' });
  assert.equal(uploads(), 0);
  await assert.rejects(adapter.upload({ ...request, beforeExecute: async () => { writeFileSync(artifact.path, 'replaced while awaiting final application check'); } }), { code: 'ARTIFACT_MISMATCH' });
  assert.equal(uploads(), 0);
});

test('compiler selecting different effective toolchain paths after property inspection invalidates the build', async t => {
  const { adapter, runner, input, data } = fixture(t);
  const changed = join(data, 'different-platform'); mkdirSync(changed); writeFileSync(join(changed, 'platform.txt'), 'different recipe');
  runner.compilePlatform = changed;
  await assert.rejects(adapter.compile(input()), { code: 'REVISION_CONFLICT' });
});
