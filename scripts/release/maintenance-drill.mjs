import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { release } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { vscodePath } from '../vscode-path.mjs';
import { verifyNativeRuntime } from '../native-runtime.mjs';

const repo = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function scoped(root, full) { const child = relative(root, full); assert.ok(!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`), 'Maintenance path leaves its owned root.'); return full; }
function tree(root) {
  const inventory = []; let bytes = 0;
  const visit = directory => {
    scoped(root, realpathSync(directory)); assert.equal(lstatSync(directory).isSymbolicLink(), false);
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(directory, entry.name), info = lstatSync(full); assert.equal(info.isSymbolicLink(), false, 'Linked preservation fixture is refused.');
      if (info.isDirectory()) visit(full);
      else { assert.ok(info.isFile() && info.nlink === 1); bytes += info.size; assert.ok(bytes <= 64 * 1024 * 1024 && inventory.length < 1024); inventory.push({ path: relative(root, full).split(sep).join('/'), sizeBytes: info.size, sha256: hash(readFileSync(full)) }); }
    }
  }; visit(root); return inventory;
}

const { values } = parseArgs({ options: { execute: { type: 'boolean', default: false }, 'self-test': { type: 'boolean', default: false }, vsix: { type: 'string', default: 'artifacts/robotics-workbench-0.1.0.vsix' }, python: { type: 'string', default: '.venv-validation/Scripts/python.exe' } } });
assert.ok(!(values.execute && values['self-test']), 'Self-checks and actual maintenance must be separate runs.');
assert.equal(realpathSync(process.cwd()), repo, 'Run the maintenance drill from the repository root.');
const artifacts = realpathSync(resolve('artifacts')); scoped(repo, artifacts);
const base = join(artifacts, 'task12-maintenance'); if (!existsSync(base)) mkdirSync(base);
assert.equal(lstatSync(base).isSymbolicLink(), false); scoped(repo, realpathSync(base));
const runId = randomUUID(), directory = join(base, runId); mkdirSync(directory);
for (const name of ['profile', 'extensions', 'tmp']) mkdirSync(join(directory, name));
mkdirSync(join(directory, 'profile', 'User'));
const record = { schemaVersion: 1, taskId: 'TASK-12', testId: values.execute ? 'release.maintenance' : 'release.maintenance-self-check', runId, startedAt: new Date().toISOString(), result: 'running', mode: values.execute ? 'actual-isolated-maintenance' : 'software-self-check', appVersion: JSON.parse(readFileSync('apps/extension/package.json', 'utf8')).version, environment: { platform: process.platform, release: release(), architecture: process.arch, node: process.version }, dependencyVersions: { node: process.version, sqlite: process.versions.sqlite ?? 'unknown' }, commandOrProcedure: JSON.stringify([process.execPath, ...process.argv.slice(1)]), sourceFiles: ['scripts/release/maintenance-drill.mjs', 'scripts/release/maintenance-worker.ts', 'scripts/release/version-fixture.py'].map(path => ({ path, sha256: hash(readFileSync(path)) })), directory, checks: [], releaseAccepted: false, limitations: ['Synthetic maintenance source, receipt and artifact; no compiler, provider, USB or firmware operation.', 'The 0.0.0 variant changes only package version manifests; it is not a historical release or evidence of old-version/schema compatibility.', 'CLI install/version mechanics and installed companion probes are distinct from VS Code extension-host/UI activation and complete-release acceptance.', 'All owned test files and failed stages are retained; nothing is purged.'] };
record.sourceDigest = hash(Buffer.from(JSON.stringify(record.sourceFiles)));
record.sourceDigestScope = 'SHA256 of ordered maintenance source file/hash JSON; the actual bundled worker digest additionally identifies imported production boundaries.';
let worker, runner;
const persist = () => { const encoded = Buffer.from(JSON.stringify(record, null, 2) + '\n'); worker?.checkArtifactCredentials(encoded); writeFileSync(join(directory, 'result.json'), encoded); };
try {
  const output = join(directory, 'maintenance-worker.cjs');
  await build({ entryPoints: ['scripts/release/maintenance-worker.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node24', outfile: output, logLevel: 'silent' });
  record.worker = { path: output, sha256: hash(readFileSync(output)) };
  worker = createRequire(import.meta.url)(output); runner = new worker.ProcessRunner();
  const python = realpathSync(resolve(values.python)); assert.ok(statSync(python).isFile());
  const run = async (name, executable, args, timeoutMs = 180000) => {
    const row = { name, executable, executableSha256: hash(readFileSync(executable)), args, startedAt: new Date().toISOString(), result: 'running' }; record.checks.push(row); persist();
    let result;
    try { result = await runner.run({ executable, args, cwd: repo, timeoutMs, maxOutputBytes: 256 * 1024, env: { TEMP: join(directory, 'tmp'), TMP: join(directory, 'tmp') } }); }
    catch (error) { Object.assign(row, { result: 'failed', endedAt: new Date().toISOString(), code: typeof error?.code === 'string' ? error.code : 'PROCESS_FAILED' }); persist(); throw error; }
    const text = result.stdout + result.stderr; worker.checkArtifactCredentials(Buffer.from(text));
    const log = join(directory, `${record.checks.length}-${name}.log`); writeFileSync(log, text, { flag: 'wx' });
    Object.assign(row, { result: result.exitCode === 0 && result.terminationObserved && !result.timedOut && !result.cancelled && !result.stdoutTruncated && !result.stderrTruncated ? 'passed' : 'failed', endedAt: new Date().toISOString(), exitCode: result.exitCode, terminationObserved: result.terminationObserved, timedOut: result.timedOut, log: { path: log, sha256: hash(Buffer.from(text)) } }); persist();
    assert.equal(row.result, 'passed', `Maintenance stage ${name} failed; inspect its retained log.`); return result.stdout;
  };
  assert.throws(() => scoped(directory, resolve(directory, '../outside')));
  assert.throws(() => scoped(directory, resolve(directory, '../../outside')));
  record.fixture = worker.seedFixture(directory);
  const conventionalDefaultRoot = join(directory, 'profile', 'User', 'globalStorage', 'local-workbench.robotics-workbench', 'data');
  cpSync(record.fixture.dataRoot, conventionalDefaultRoot, { recursive: true, errorOnExist: true, force: false });
  record.conventionalDefaultStorageProbe = { path: conventionalDefaultRoot, basis: 'A closed synthetic store copied into the conventional isolated-profile globalStorage location; actual ExtensionContext path resolution is not claimed.', initialInventory: tree(conventionalDefaultRoot) };
  record.storage = worker.storageChecks(directory, record.fixture);
  record.fixtureObservation = worker.verifyFixture(record.fixture);
  if (!values.execute) {
    const result = await run('version-fixture-self-check', python, ['scripts/release/version-fixture.py', '--run-root', directory, '--self-test']);
    record.versionFixtureChecks = JSON.parse(result); assert.equal(record.versionFixtureChecks.result, 'passed'); record.dependencyVersions.python = record.versionFixtureChecks.pythonVersion;
    record.result = 'passed'; record.evidenceClass = 'software-real-sqlite-and-synthetic-zip';
  } else {
    assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64');
    const vsix = realpathSync(resolve(values.vsix)); assert.ok(statSync(vsix).isFile() && statSync(vsix).size <= 128 * 1024 * 1024);
    const inspection = JSON.parse(readFileSync('artifacts/package-inspection.json', 'utf8'));
    assert.equal(inspection.passed, true); assert.equal(hash(readFileSync(vsix)), inspection.sha256, 'Use the exact currently inspected package.');
    record.vsix = { path: vsix, sha256: inspection.sha256 };
    const variant = join(directory, 'SYNTHETIC-same-code-0.0.0.vsix');
    record.versionFixture = JSON.parse(await run('version-fixture', python, ['scripts/release/version-fixture.py', '--run-root', directory, '--source', vsix, '--output', variant]));
    record.dependencyVersions.python = record.versionFixture.pythonVersion; assert.equal(record.versionFixture.originalVersion, record.appVersion);
    assert.equal(record.versionFixture.originalSha256, record.vsix.sha256);
    const executable = realpathSync(vscodePath()), cli = realpathSync(join(dirname(executable), 'bin', 'code.cmd'));
    assert.equal(existsSync(join(dirname(executable), 'data')), false, 'Portable Mode overrides isolation flags; select a normal installed host.');
    const powershell = realpathSync(join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    const adapter = join(directory, 'code-cli.ps1');
    writeFileSync(adapter, 'param([string]$TaskCodeCli,[string]$TaskProfile,[string]$TaskExtensions,[ValidateSet("version","list","install","uninstall")][string]$TaskOperation,[string]$TaskVsix)\n$ErrorActionPreference = "Stop"\n$common = @("--user-data-dir",$TaskProfile,"--extensions-dir",$TaskExtensions)\nswitch ($TaskOperation) {\n "version" { & $TaskCodeCli @common --version }\n "list" { & $TaskCodeCli @common --list-extensions --show-versions }\n "install" { & $TaskCodeCli @common --install-extension $TaskVsix --force }\n "uninstall" { & $TaskCodeCli @common --uninstall-extension local-workbench.robotics-workbench --force }\n}\nexit $LASTEXITCODE\n', { flag: 'wx' });
    const profile = join(directory, 'profile'), extensions = join(directory, 'extensions');
    writeFileSync(join(profile, 'User', 'settings.json'), JSON.stringify({ 'update.mode': 'none', 'extensions.autoUpdate': false, 'telemetry.telemetryLevel': 'off', 'roboticsWorkbench.nodePath': process.execPath, 'roboticsWorkbench.dataRoot': record.fixture.dataRoot }, null, 2), { flag: 'wx' });
    const code = (name, operation, packagePath = '') => run(name, powershell, ['-NoProfile', '-File', adapter, '-TaskCodeCli', cli, '-TaskProfile', profile, '-TaskExtensions', extensions, '-TaskOperation', operation, ...(packagePath ? ['-TaskVsix', packagePath] : [])]);
    record.code = { executable, executableSha256: hash(readFileSync(executable)), cli, cliSha256: hash(readFileSync(cli)), versionOutput: (await code('code-version', 'version')).trim() };
    let baseline = { project: tree(record.fixture.projectRoot), data: tree(record.fixture.dataRoot), conventionalDefaultStorage: tree(conventionalDefaultRoot) };
    const preserved = name => { const current = { project: tree(record.fixture.projectRoot), data: tree(record.fixture.dataRoot), conventionalDefaultStorage: tree(conventionalDefaultRoot) }; assert.deepEqual(current, baseline, `${name} changed source or operational evidence.`); return { result: 'passed', inventory: current, records: worker.verifyFixture(record.fixture) }; };
    const installed = async (name, expectedVersion) => {
      const list = (await code(`${name}-version-list`, 'list')).trim().split(/\r?\n/).filter(Boolean); assert.deepEqual(list, expectedVersion ? [`local-workbench.robotics-workbench@${expectedVersion}`] : []);
      if (!expectedVersion) return null;
      const candidates = readdirSync(extensions, { withFileTypes: true }).filter(item => item.isDirectory() && item.name.startsWith(`local-workbench.robotics-workbench-${expectedVersion}`)).map(item => join(extensions, item.name)).filter(folder => { const manifest = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')); return manifest.publisher === 'local-workbench' && manifest.name === 'robotics-workbench' && manifest.version === expectedVersion; });
      assert.equal(candidates.length, 1); const selected = realpathSync(candidates[0]); scoped(directory, selected);
      for (const file of record.versionFixture.runtimeFiles) { const full = resolve(selected, file.path); scoped(selected, full); assert.equal(hash(readFileSync(full)), file.sha256, `Installed runtime changed: ${file.path}`); }
      await verifyNativeRuntime(join(selected, 'dist')); return selected;
    };
    const probe = async (name, selected, dataRoot, unsupported = false) => {
      const before = unsupported ? tree(dataRoot) : null;
      const client = new worker.CompanionClient(join(selected, 'dist', 'companion.js'), process.execPath, () => {}, () => {}, { projectRoot: record.fixture.projectRoot, dataRoot });
      const row = { name, result: 'running', startedAt: new Date().toISOString(), installedCompanionSha256: hash(readFileSync(join(selected, 'dist', 'companion.js'))), noProviderOrHardwareConfiguration: true }; record.checks.push(row); persist();
      try {
        const request = { schemaVersion: 1, requestId: randomUUID(), projectId: record.fixture.projectId, method: 'project.snapshot', params: {} };
        if (unsupported) await assert.rejects(client.requestProject(request), /UNSUPPORTED_SCHEMA/);
        else { const snapshot = await client.requestProject(request); assert.equal(snapshot.manifest.projectId, record.fixture.projectId); assert.equal(snapshot.manifest.projectRevision, 1); }
        row.result = 'passed';
      } finally { await client.stop(); row.companionExitObserved = true; row.endedAt = new Date().toISOString(); persist(); }
      if (unsupported) { assert.deepEqual(tree(dataRoot), before); row.futureDataUnchanged = true; }
    };
    await code('clean-install', 'install', vsix); let selected = await installed('clean-install', record.versionFixture.originalVersion); record.cleanInstallPreservation = preserved('Clean install');
    await probe('installed-companion-open', selected, record.fixture.dataRoot);
    record.afterCoreOpen = worker.verifyFixture(record.fixture); baseline = { project: tree(record.fixture.projectRoot), data: tree(record.fixture.dataRoot), conventionalDefaultStorage: tree(conventionalDefaultRoot) };
    await code('synthetic-version-rollback', 'install', variant); selected = await installed('synthetic-version-rollback', '0.0.0'); record.rollbackPreservation = preserved('Synthetic version rollback');
    await probe('installed-newer-schema-refusal', selected, join(directory, 'unsupported-future-schema'), true); record.afterRefusal = preserved('Newer-schema refusal');
    await code('update-to-exact-candidate', 'install', vsix); await installed('update-to-exact-candidate', record.versionFixture.originalVersion); record.updatePreservation = preserved('Update to exact candidate');
    await code('uninstall', 'uninstall'); await installed('uninstall', null); record.uninstallPreservation = preserved('Uninstall');
    assert.equal(hash(readFileSync(vsix)), record.vsix.sha256); record.result = 'passed'; record.evidenceClass = 'actual-isolated-vscode-cli-installed-companion-and-real-sqlite-synthetic-data';
  }
} catch (error) {
  record.result = 'failed'; const message = error instanceof Error ? error.message.slice(0, 2048) : 'Maintenance check failed.';
  try { worker?.checkArtifactCredentials(Buffer.from(message)); record.error = message; } catch { record.error = 'Credential-like error details excluded.'; }
  process.exitCode = 1;
} finally {
  try { await runner?.shutdown(); } catch { record.result = 'failed'; record.shutdownError = 'Owned process termination was not observed; inspect preserved run before retrying.'; process.exitCode = 1; }
  record.endedAt = new Date().toISOString(); persist(); console.log(JSON.stringify({ result: record.result, evidence: join(directory, 'result.json'), mode: record.mode }));
}
