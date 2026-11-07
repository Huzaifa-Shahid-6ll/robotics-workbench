// Records executed local checks; live model turns must be run explicitly beforehand.
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

const destination = 'verification/evidence/task-00-completion';
await mkdir(destination, { recursive: true });
const sha256 = value => createHash('sha256').update(value).digest('hex');
const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const codex = await json('artifacts/compatibility/lifecycle/codex.json');
const opencode = await json('artifacts/compatibility/lifecycle/opencode.json');
const arduino = await json('artifacts/compatibility/arduino-existing/latest.json');
assert.equal(codex.disposition, 'passed');
assert.equal(codex.completedTurnStatus, 'completed');
assert.equal(codex.interruptedTurnStatus, 'interrupted');
assert.equal(codex.resumedTurnIds.length, 2);
assert.equal(opencode.disposition, 'passed');
assert.equal(opencode.firstMessageFinish, 'stop');
assert.equal(opencode.userMessageIdsAfterReconnect.length, 2);
assert.ok(opencode.interruptedMessages.some(message => message.error === 'MessageAbortedError'));
assert.equal(arduino.exitCode, 0);
assert.equal(arduino.originalPreserved, true);
const npm = process.env.npm_execpath;
assert.ok(npm, 'Use npm run compatibility:record.');
const runId = randomUUID();
const record = await json('verification/task-00-completion.json');
const status = spawnSync('git', ['diff', '--name-only', '8616768'], { encoding: 'utf8' });
const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' });
assert.equal(status.status, 0);
assert.equal(untracked.status, 0);
record.changedFiles = [...new Set((status.stdout+'\n'+untracked.stdout).trim().split(/\r?\n/).filter(Boolean))].sort();
const sources = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' });
const digest = createHash('sha256');
for (const path of [...new Set(sources.stdout.trim().split(/\r?\n/))].filter(path => path && !path.startsWith('verification/')).sort()) digest.update(path+'\0').update(await readFile(path));
record.sourceDigest = digest.digest('hex');
record.sourceDigestScope = 'Sorted nonignored working files except verification outputs, path NUL then bytes; lifecycle script digests additionally bind the executed probes.';
record.runId = runId;
record.appVersion = '0.1.0';
record.environment = (await json('verification/evidence/environment.json')).os;
record.dependencyVersions = { node: process.version, npm: '11.16.0', vscode: '1.144.0', codex: '0.160.1', opencode: '1.18.32', opencodeSdk: '1.18.32', serialportBindingsCpp: '13.0.1' };
record.checks = [];
const stages = [
  ['install.clean', process.execPath, [npm, 'ci', '--ignore-scripts'], 'npm ci --ignore-scripts'],
  ['documentation.contracts', '.venv-validation/Scripts/python', ['scripts/validate_pack.py', '--contracts'], '.venv-validation/Scripts/python scripts/validate_pack.py --contracts'],
  ['software.boundaries', process.execPath, [npm, 'run', 'check'], 'npm run check'],
  ['software.lifecycle', process.execPath, [npm, 'test'], 'npm test'],
  ['package.production', process.execPath, [npm, 'run', 'package'], 'npm run package'],
  ['host.installed-vsix', process.execPath, [npm, 'run', 'test:packaged'], 'npm run test:packaged'],
  ['native.installed-vsix', process.execPath, ['scripts/compatibility/native-package.mjs'], 'node scripts/compatibility/native-package.mjs'],
  ['dependencies.audit', process.execPath, [npm, 'audit', '--json'], 'npm audit --json']
];
for (const [testId, executable, args, commandOrProcedure] of stages) {
  const startedAt = new Date().toISOString();
  console.log(`Checking ${commandOrProcedure}`);
  const completed = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 4*1024*1024 });
  const output = (completed.stdout ?? '')+(completed.stderr ?? '')+(completed.error ? String(completed.error) : '');
  const path = `${destination}/${testId}.log`;
  await writeFile(path, output);
  record.checks.push({ testId, commandOrProcedure, startedAt, endedAt: new Date().toISOString(), result: completed.status === 0 ? 'passed' : 'failed', exitCode: completed.status, evidenceClass: testId.includes('installed-vsix') ? 'packaged-windows' : testId.startsWith('documentation') ? 'document' : 'software', evidence: { path, sha256: sha256(output) } });
  if (completed.status !== 0) {
    record.status = 'review';
    await writeFile('verification/task-00-completion.json', JSON.stringify(record, null, 2)+'\n');
    throw new Error(`${commandOrProcedure} failed; see ${path}`);
  }
}
const files = [
  ['artifacts/compatibility/lifecycle/codex.json', 'codex.json'],
  ['artifacts/compatibility/lifecycle/codex-first-failure.json', 'codex-startup-race.json'],
  ['artifacts/compatibility/lifecycle/opencode.json', 'opencode.json'],
  ['artifacts/compatibility/lifecycle/opencode-first-failure.json', 'opencode-first-failure.json'],
  ['artifacts/compatibility/lifecycle/opencode-expired-login-diagnosis.json', 'opencode-expired-login.json'],
  ['artifacts/compatibility/arduino-existing/latest.json', 'arduino-existing.json'],
  ['artifacts/compatibility/native-package/result.json', 'native-package.json'],
  ['artifacts/package-inspection.json', 'production-package-inspection.json']
];
record.artifacts = [];
for (const [from, name] of files) {
  const path = `${destination}/${name}`;
  await copyFile(from, path);
  record.artifacts.push({ path, sha256: sha256(await readFile(path)) });
}
const codexScript = 'scripts/compatibility/codex-lifecycle.py';
const opencodeScript = 'scripts/compatibility/opencode-lifecycle.mjs';
for (const [testId, evidenceClass, report, commandOrProcedure, script, name] of [
  ['provider.codex-lifecycle', 'live-provider', codex, `.venv-validation/Scripts/python ${codexScript} --executable '${codex.executablePath}' --live`, codexScript, 'codex.json'],
  ['provider.opencode-lifecycle', 'live-provider', opencode, `node ${opencodeScript} --executable '${opencode.executablePath}' --model openai/gpt-6.1-sol --live`, opencodeScript, 'opencode.json']
]) record.checks.push({ testId, commandOrProcedure, startedAt: report.startedAt, endedAt: report.endedAt, result: 'passed', evidenceClass, testedProgram: { path: script, sha256: sha256(await readFile(script)) }, evidence: record.artifacts.find(item => item.path.endsWith('/'+name)) });
record.checks.push({ testId: 'arduino.existing-example', evidenceClass: 'software', commandOrProcedure: `.venv-validation/Scripts/python scripts/compatibility/compile-probe.py --cli 'C:/Program Files/Arduino IDE/resources/app/lib/backend/resources/arduino-cli.exe' --existing-sketch '${arduino.originalPath}' --fqbn arduino:avr:uno`, startedAt: arduino.startedAt, endedAt: arduino.endedAt, result: 'passed', testedProgram: { path: 'scripts/compatibility/compile-probe.py', sha256: sha256(await readFile('scripts/compatibility/compile-probe.py')) }, evidence: record.artifacts.find(item => item.path.endsWith('/arduino-existing.json')) });
for (const [name, hash] of Object.entries(arduino.originalAndCopyFiles)) assert.equal(sha256(await readFile(resolve(arduino.originalPath, name))), hash, 'External original changed after compile');
record.status = 'done';
record.recordedAt = new Date().toISOString();
for (const check of record.checks) Object.assign(check, { runId, sourceDigest: record.sourceDigest, appVersion: record.appVersion, environment: record.environment, dependencyVersions: record.dependencyVersions });
const changed = spawnSync('git', ['diff', '--name-only', '8616768'], { encoding: 'utf8' });
const added = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' });
record.changedFiles = [...new Set((changed.stdout+'\n'+added.stdout).trim().split(/\r?\n/).filter(Boolean))].sort();
await writeFile('verification/task-00-completion.json', JSON.stringify(record, null, 2)+'\n');
console.log(`TASK-00 compatibility completion passed: ${record.checks.length} checks; no physical hardware accessed.`);
