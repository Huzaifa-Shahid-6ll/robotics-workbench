import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const npm = process.env.npm_execpath;
assert.ok(npm, 'Run via npm run verify.');
await mkdir('verification/evidence', { recursive: true });
const paths = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' });
assert.equal(paths.status, 0);
const sourceFiles = [...new Set(paths.stdout.trim().split(/\r?\n/))].filter(path => path && !path.startsWith('verification/')).sort();
const digest = createHash('sha256');
for (const path of sourceFiles) digest.update(path+'\0').update(await readFile(path));
const sourceDigest = digest.digest('hex');
const runId = randomUUID();
const checks = [];
let providerRecord;
try { providerRecord = await readFile('artifacts/compatibility/providers.json', 'utf8'); }
catch { providerRecord = await readFile('verification/evidence/providers.json', 'utf8'); }
const providers = JSON.parse(providerRecord);
const python = '.venv-validation/Scripts/python';
const stages = [
  ['compatibility.environment', process.execPath, [npm, 'run', 'doctor'], 'npm run doctor'],
  ['compatibility.sqlite', process.execPath, ['scripts/compatibility/sqlite-probe.mjs'], 'node scripts/compatibility/sqlite-probe.mjs'],
  ['compatibility.arduino-compile', python, ['scripts/compatibility/compile-probe.py', '--cli', 'C:/Program Files/Arduino IDE/resources/app/lib/backend/resources/arduino-cli.exe'], `${python} scripts/compatibility/compile-probe.py --cli 'C:/Program Files/Arduino IDE/resources/app/lib/backend/resources/arduino-cli.exe'`],
  ['compatibility.providers', python, ['scripts/compatibility/provider-probes.py', '--codex', providers.codex.executablePath, '--opencode', providers.opencode.executablePath], `${python} scripts/compatibility/provider-probes.py --codex '${providers.codex.executablePath}' --opencode '${providers.opencode.executablePath}'`],
  ['documentation.contracts', '.venv-validation/Scripts/python', ['scripts/validate_pack.py', '--contracts', '--report', 'artifacts/document-validation.json'], '.venv-validation/Scripts/python scripts/validate_pack.py --contracts --report artifacts/document-validation.json'],
  ['software.boundaries', process.execPath, [npm, 'run', 'check'], 'npm run check'],
  ['software.lifecycle', process.execPath, [npm, 'test'], 'npm test'],
  ['host.development', process.execPath, [npm, 'run', 'test:host'], 'npm run test:host'],
  ['package.inspection', process.execPath, [npm, 'run', 'package'], 'npm run package'],
  ['host.installed-vsix', process.execPath, [npm, 'run', 'test:packaged'], 'npm run test:packaged'],
  ['dependencies.audit', process.execPath, [npm, 'audit', '--json'], 'npm audit --json']
];
for (const [testId, executable, args, commandOrProcedure] of stages) {
  const startedAt = new Date().toISOString();
  console.log(`Checking ${commandOrProcedure}`);
  const child = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  const output = (child.stdout ?? '')+(child.stderr ?? '')+(child.error ? '\n'+String(child.error) : '');
  const path = `verification/evidence/${testId}.log`;
  await writeFile(path, output);
  checks.push({ runId, testId, sourceDigest, appVersion: '0.1.0', startedAt, endedAt: new Date().toISOString(), commandOrProcedure,
    result: child.status === 0 ? 'passed' : 'failed', exitCode: child.status,
    evidence: { path, sha256: createHash('sha256').update(output).digest('hex') } });
  if (child.status !== 0) {
    await writeFile('verification/failed-run.json', JSON.stringify({ runId, sourceDigest, checks }, null, 2)+'\n');
    throw new Error(`${commandOrProcedure} failed; see ${path}`);
  }
}
for (const [from, to] of [
  ['artifacts/compatibility/environment.json', 'environment.json'],
  ['artifacts/compatibility/providers.json', 'providers.json'],
  ['artifacts/compatibility/arduino/result.json', 'arduino-compile.json'],
  ['artifacts/compatibility/sqlite.json', 'sqlite.json'],
  ['artifacts/package-inspection.json', 'package-inspection.json'],
  ['artifacts/license-inventory.json', 'license-inventory.json'],
  ...['development-trusted', 'development-restricted', 'packaged-trusted', 'packaged-restricted'].map(name => [`artifacts/${name}.json`, `${name}.json`])
]) await copyFile(from, `verification/evidence/${to}`);
const inventory = JSON.parse((await readFile('verification/evidence/environment.json', 'utf8')).replace(/^\uFEFF/, ''));
const artifactPaths = ['environment.json', 'providers.json', 'arduino-compile.json', 'sqlite.json', 'package-inspection.json', 'license-inventory.json', 'development-trusted.json', 'development-restricted.json', 'packaged-trusted.json', 'packaged-restricted.json'];
const artifacts = [];
for (const name of artifactPaths) {
  const path = `verification/evidence/${name}`;
  artifacts.push({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
}
const taskRecord = JSON.parse(await readFile('verification/task-00-01.json', 'utf8'));
Object.assign(taskRecord, { runId, sourceDigest, sourceDigestScope: 'Sorted tracked and nonignored working files except verification outputs; path NUL bytes followed by file bytes.', appVersion: '0.1.0', environment: inventory.os, dependencies: { node: process.version, npm: '11.16.0', vscode: '1.144.0', typescript: '5.9.3', esbuild: '0.28.2' }, checks, artifacts });
for (const check of checks) {
  check.environment = inventory.os;
  check.dependencyVersions = taskRecord.dependencies;
  check.evidenceClass = check.testId.startsWith('compatibility.providers') ? 'live-provider-protocol-only'
    : check.testId.startsWith('host.installed') ? 'packaged-windows'
    : check.testId.startsWith('documentation') ? 'document' : 'software';
}
for (const task of taskRecord.tasks) {
  task.checks = checks.filter(check => task.taskId === 'TASK-00' ? check.testId.startsWith('compatibility.') : !check.testId.startsWith('compatibility.')).map(check => ({ testId: check.testId, commandOrProcedure: check.commandOrProcedure, result: check.result, evidence: check.evidence.path }));
  task.changedFiles = task.taskId === 'TASK-00'
    ? sourceFiles.filter(path => path.startsWith('scripts/compatibility/') || path.startsWith('packages/test-fixtures/compatibility/') || path === 'docs/dependencies-and-compatibility.md')
    : sourceFiles.filter(path => path.startsWith('apps/') || path.startsWith('packages/contracts/') || path.startsWith('packages/webviews/') || path.startsWith('.vscode/') || ['.gitattributes', '.gitignore', 'package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'doc-manifest.json', 'tasks/task-index.json', 'tasks/TASK-00-01.md', 'docs/internal-api-and-webview-protocol.md', 'contracts/companion-control.schema.json', 'contracts/companion-result.schema.json'].includes(path) || (path.startsWith('scripts/') && !path.startsWith('scripts/compatibility/') && !['scripts/read_doc.py', 'scripts/requirements-validation.txt'].includes(path)));
  task.changedFiles.push('verification/task-00-01.json', 'verification/traceability.json');
}
await writeFile('verification/task-00-01.json', JSON.stringify(taskRecord, null, 2)+'\n');
console.log(`Verification passed: ${checks.length} stages. Evidence: verification/task-00-01.json`);
