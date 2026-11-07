import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { arch, cpus, platform, release, totalmem } from 'node:os';

const runId = randomUUID();
const directory = resolve(`verification/evidence/task-11/ui/browser/${runId}`);
mkdirSync(directory, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const checks = [];
const startedAt = new Date().toISOString();
const environment = { platform: platform(), release: release(), arch: arch(), node: process.version, cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), concurrentWorkload: 'Shared development session; root integration/software/native tests may run concurrently. Browser timings include observed local machine contention.' };
for (const name of ['agent', 'wiring', 'documents', 'telemetry', 'engineering']) {
  const evidence = join(directory, name);
  mkdirSync(evidence);
  const command = `node scripts/ui/${name}-qa.mjs`;
  console.log(command);
  const child = spawnSync(process.execPath, [`scripts/ui/${name}-qa.mjs`], {
    encoding: 'utf8', windowsHide: true, timeout: 240000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, WORKBENCH_UI_ARTIFACT_ROOT: resolve(`artifacts/task11-ui/${runId}/${name}`), WORKBENCH_UI_EVIDENCE_ROOT: evidence,
      PLAYWRIGHT_CHROMIUM_EXECUTABLE: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' }
  });
  const log = (child.stdout || '') + (child.stderr || '') + (child.error ? String(child.error) : '');
  const logPath = join(evidence, 'command.log');
  writeFileSync(logPath, log);
  const resultPath = join(evidence, 'result.json');
  let record;
  try { record = JSON.parse(readFileSync(resultPath, 'utf8')); } catch { /* Failed startup remains a failed check with its exact command log. */ }
  const artifacts = [{ path: relative(process.cwd(), logPath).replaceAll('\\', '/'), sha256: hash(log) }];
  if (existsSync(resultPath)) artifacts.push({ path: relative(process.cwd(), resultPath).replaceAll('\\', '/'), sha256: hash(readFileSync(resultPath)) });
  let complete = child.status === 0 && record?.status === 'passed';
  for (const screenshot of record?.screenshots || []) {
    const path = join(evidence, screenshot);
    if (!existsSync(path)) { complete = false; continue; }
    artifacts.push({ path: relative(process.cwd(), path).replaceAll('\\', '/'), sha256: hash(readFileSync(path)) });
  }
  checks.push({ testId: `task11.ui.${name}`, commandOrProcedure: command, result: complete ? 'passed' : 'failed', exitCode: child.status, evidenceClass: 'synthetic-browser-ui', checks: record?.checks || [], artifacts });
  console.log(`${name}: ${complete ? 'passed' : 'failed'}; ${record?.screenshots?.length || 0} retained screenshots`);
  writeFileSync(join(directory, 'result.json'), JSON.stringify({ taskId: 'TASK-11', runId, startedAt, endedAt: new Date().toISOString(), environment, checks, limitations: ['Synthetic browser state. Each script requires JavaScript/CSS identical to the production dist. Native Windows views, assistive speech and physical operations remain separately verified.'] }, null, 2) + '\n');
}
assert.equal(checks.length, 5);
process.exitCode = checks.every(item => item.result === 'passed') ? 0 : 1;
console.log(`Evidence: ${relative(process.cwd(), directory)}`);
