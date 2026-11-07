import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runTests } from '@vscode/test-electron';
import { createWriteStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, stat, statfs, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { parse, resolve } from 'node:path';
import { promisify } from 'node:util';
import { vscodePath } from '../vscode-path.mjs';

const p95 = samples => {
  assert.ok(samples.length && samples.every(value => Number.isFinite(value) && value >= 0));
  return [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1];
};
const optionalWorkers = (tree, companionPid) => tree.filter(item => item.processId !== companionPid && !(item.name.toLowerCase() === 'conhost.exe' && item.parentId === companionPid));
assert.equal(p95(Array.from({ length: 30 }, (_, index) => index + 1)), 29);
const processFixture = [{ processId: 1, parentId: 0, name: 'node.exe' }, { processId: 2, parentId: 1, name: 'conhost.exe' }];
assert.equal(optionalWorkers(processFixture, 1).length, 0);
assert.equal(optionalWorkers([...processFixture, { processId: 3, parentId: 1, name: 'node.exe' }], 1).length, 1);
assert.equal(optionalWorkers([...processFixture, { processId: 4, parentId: 3, name: 'conhost.exe' }], 1).length, 1);
if (process.argv.includes('--self-check')) { console.log('Performance percentile and owned-process identity self-checks passed.'); process.exit(0); }
assert.equal(platform(), 'win32', 'The D07 actual-PC benchmark is Windows-specific.');

const runId = randomUUID(), startedAt = new Date().toISOString();
const power = await promisify(execFile)('powercfg.exe', ['/getactivescheme'], { windowsHide: true, timeout: 15000 }).then(result => result.stdout.trim().slice(0, 1024)).catch(error => `unavailable:${error.code ?? 'unknown'}`);
const disks = await Promise.all([...new Set([parse(resolve()).root, `${process.env.SystemDrive ?? 'C:'}/`])].map(async root => {
  try { const disk = await statfs(root); return { root, availableBytes: disk.bavail * disk.bsize, totalBytes: disk.blocks * disk.bsize }; }
  catch (error) { return { root, error: error.code ?? 'unavailable' }; }
}));
const directory = resolve(`verification/evidence/task-11/performance/host-${runId}`);
const fixture = resolve(`artifacts/tmp/task11-performance-${runId}`), workspace = resolve(fixture, 'project'), profile = resolve(fixture, 'profile');
await mkdir(directory, { recursive: true }); await mkdir(resolve(workspace, 'Sketch'), { recursive: true }); await mkdir(resolve(profile, 'User'), { recursive: true });
const targetId = randomUUID(), manifest = { schemaVersion: 1, projectId: randomUUID(), projectRevision: 1, name: 'Synthetic100component performance fixture', sketches: [{ path: 'Sketch', targetId }], targets: [{ targetId, fqbn: 'arduino:avr:uno', options: {} }], components: Array.from({ length: 100 }, (_, index) => ({ componentId: randomUUID(), label: `Unresolved fixture${index}`, definition: null, identityStatus: 'unresolved', provisionalPins: [{ pinId: 'signal', label: 'Unverified signal' }] })), nets: [], codeBindings: [], documents: [], extensions: {} };
await writeFile(resolve(workspace, 'workbench.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(resolve(workspace, 'Sketch/Sketch.ino'), '#include "pins.h"\nvoid setup() {}\nvoid loop() {}\n');
await writeFile(resolve(workspace, 'Sketch/pins.h'), '// Synthetic multifile fixture; no hardware observation.\n#define TEST_PIN 7\n');
await writeFile(resolve(workspace, 'generated-10000.log'), Array.from({ length: 10000 }, (_, index) => `synthetic row${index}: no hardware observation`).join('\n') + '\n');
await writeFile(resolve(profile, 'User/settings.json'), JSON.stringify({ 'security.workspace.trust.enabled': false, 'update.mode': 'none', 'extensions.autoUpdate': false, 'telemetry.telemetryLevel': 'off', 'roboticsWorkbench.nodePath': process.execPath, 'roboticsWorkbench.dataRoot': resolve(fixture, 'data'), 'workbench.startupEditor': 'none' }));
await build({ entryPoints: ['apps/extension/test/performance-host.ts'], outfile: resolve(fixture, 'performance-host.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['vscode'] });
const reports = {}, checks = [];
for (const mode of ['baseline', 'workbench']) {
  const report = resolve(directory, `${mode}.json`), logPath = resolve(directory, `${mode}.log`), log = createWriteStream(logPath);
  const start = new Date().toISOString();
  let failure;
  try {
    await runTests({ vscodeExecutablePath: vscodePath(), extensionDevelopmentPath: resolve('apps/extension'), extensionTestsPath: resolve(fixture, 'performance-host.cjs'),
      extensionTestsEnv: { WORKBENCH_PERFORMANCE_MODE: mode, WORKBENCH_PERFORMANCE_REPORT: report },
      launchArgs: [workspace, '--user-data-dir', profile, '--extensions-dir', resolve(fixture, 'extensions'), '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates'], stdout: log, stderr: log });
  } catch (error) { failure = String(error); }
  await new Promise(resolve => log.end(resolve));
  try { reports[mode] = JSON.parse(await readFile(report, 'utf8')); } catch { reports[mode] = { passed: false, failure: failure ?? 'No host evidence record was produced.' }; }
  checks.push({ testId: `performance.host-${mode}`, commandOrProcedure: `node scripts/performance/host.mjs (${mode} isolated VS Code host)`, startedAt: start, endedAt: new Date().toISOString(), result: reports[mode].passed && !failure ? 'passed' : 'failed', ...(failure ? { failure } : {}), evidence: { path: logPath, sha256: createHash('sha256').update(await readFile(logPath)).digest('hex') } });
  if (failure || !reports[mode].passed) break;
}
let metrics = null;
if (reports.baseline?.passed && reports.workbench?.passed) {
  const hostRssDifference = reports.workbench.idle.final.rssBytes - reports.baseline.idle.final.rssBytes;
  const companionWorkingSetBytes = reports.workbench.idleProcesses.reduce((sum, item) => sum + item.workingSetBytes, 0);
  const incrementalBytes = Math.max(0, hostRssDifference) + companionWorkingSetBytes;
  metrics = { idleMemory: { hostRssDifference, companionWorkingSetBytes, incrementalBytes, budgetBytes: 250 * 1024 * 1024, result: incrementalBytes <= 250 * 1024 * 1024 ? 'passed' : 'failed', limitation: 'Coarse same-profile host-process RSS difference plus companion working sets; exact per-extension allocation and shared pages are not identifiable.' },
    activation: { ...reports.workbench.activation, result: reports.workbench.activation.alreadyActive ? 'not-run' : reports.workbench.activation.durationMs <= 1000 ? 'passed' : 'failed' },
    commandCompletionP95Ms: p95(reports.workbench.commandCompletionMs), selectionPostedStateP95Ms: p95(reports.workbench.selectionPostedStateMs), contextCommandCompletionP95Ms: p95(reports.workbench.contextCommandCompletionMs),
    renderedFeedbackBudget: { result: 'not-run', reason: 'Command completion and posted controller state are not visible command acknowledgement or rendered-context measurements.' },
    shutdown: { durationMs: reports.workbench.shutdownMs, exitObserved: reports.workbench.shutdownExitObserved, budgetMs: 10000, result: reports.workbench.shutdownExitObserved && reports.workbench.shutdownMs <= 10000 ? 'passed' : 'failed' },
    optionalWorkers: { beforeUse: optionalWorkers(reports.workbench.beforeIdleProcesses, reports.workbench.companionPid).length, afterIdle: optionalWorkers(reports.workbench.idleProcesses, reports.workbench.companionPid).length, allowedInfrastructure: 'Exact owned node.exe companion and its direct Windows conhost.exe child only; every working set remains counted.' },
    panelCycles: reports.workbench.panelCycles, panelLeakConclusion: 'Real panel tabs close and companion descendants are recorded; sampled RSS does not prove absence of every retained listener.' };
}
async function size(path) { let bytes = 0; for (const entry of await readdir(path, { withFileTypes: true })) bytes += entry.isDirectory() ? await size(resolve(path, entry.name)) : (await stat(resolve(path, entry.name))).size; return bytes; }
const record = { schemaVersion: 1, taskId: 'TASK-11', runId, startedAt, endedAt: new Date().toISOString(), requirements: ['REQ-UX-05', 'REQ-ARCH-03', 'REQ-HW-03'], acceptance: ['AC-D07-01', 'AC-D07-03', 'AC-D07-04'], evidenceClass: 'actual-windows-vscode-host-performance',
  environment: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, ramBytes: totalmem(), node: process.version, vscodeExecutable: vscodePath(), concurrentWorkload: 'Other desktop applications and task agents may be running; no system-wide workload was stopped.', powerMode: power, disks },
  fixture: { workspace, projectId: manifest.projectId, components: 100, generatedLogRows: 10000, multiFileSketch: true }, extensionDistBytes: await size(resolve('apps/extension/dist')), checks, metrics,
  result: checks.length === 2 && checks.every(check => check.result === 'passed') && metrics && ![metrics.idleMemory.result, metrics.activation.result, metrics.shutdown.result].includes('failed') ? 'passed' : 'failed',
  limitations: ['No hardware, provider inference, compiler peak or CAD peak participated.', 'This host benchmark does not close all of VG-11; rendered feedback, screen-reader behavior, exact listener retention, and30minute capture evidence remain separate.', 'No source or environment secret dump is collected. Benchmark fixtures and failed reports remain retained.'] };
await writeFile(resolve(directory, 'result.json'), JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify({ result: record.result, evidence: resolve(directory, 'result.json'), metrics }, null, 2));
if (record.result !== 'passed') process.exitCode = 1;
