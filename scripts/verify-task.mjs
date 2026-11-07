import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { release, platform, arch } from 'node:os';

const taskId = process.argv[2];
if (!/^TASK-(?:0[2-9]|10|11|12)$/.test(taskId ?? '')) throw new Error('Expected TASK-02 through TASK-12.');
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run through npm run verify:task -- TASK-02.');
const task = JSON.parse(readFileSync('tasks/task-index.json', 'utf8')).tasks.find(item => item.task_id === taskId);
const runId = randomUUID();
const directory = `verification/evidence/${taskId.toLowerCase()}/${runId}`;
mkdirSync(directory, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', windowsHide: true });
if (git.status !== 0) throw new Error(git.stderr);
const paths = [...new Set(git.stdout.trim().split(/\r?\n/))].filter(path => path && !path.startsWith('verification/')).sort();
const digest = createHash('sha256');
for (const path of paths) digest.update(path + '\0').update(readFileSync(path));
const record = { schemaVersion: 1, taskId, status: 'review', runId, sourceDigest: digest.digest('hex'),
  sourceDigestScope: 'Sorted tracked/nonignored files excluding verification; path NUL followed by bytes.',
  appVersion: '0.1.0', environment: { platform: platform(), release: release(), arch: arch(), node: process.version },
  requirements: ['REQ-ARCH-01', 'REQ-ARCH-02', 'REQ-ARCH-03', 'REQ-ARCH-04', 'REQ-ARCH-05', 'REQ-ARCH-06', 'REQ-PROD-01', 'REQ-HW-01', 'REQ-HW-02', 'REQ-HW-03'],
  acceptance: task.acceptance, changedFiles: [], checks: [], remainingGates: task.validation_gates, limitations: [] };
if (taskId === 'TASK-05') record.requirements = ['REQ-PROD-02', ...Array.from({ length: 10 }, (_, index) => `REQ-AGENT-${index + 21}`)];
if (taskId === 'TASK-06') record.requirements = ['REQ-ARCH-02', 'REQ-ARCH-06', 'REQ-AGENT-26', 'REQ-AGENT-27', 'REQ-AGENT-28', ...Array.from({ length: 7 }, (_, index) => `REQ-UX-${index + 41}`)];
if (taskId === 'TASK-07') record.requirements = ['REQ-ARCH-01', 'REQ-HW-34-01', 'REQ-HW-35-01', ...Array.from({ length: 7 }, (_, index) => `REQ-UX-${index + 41}`)];
if (taskId === 'TASK-08') record.requirements = ['REQ-HW-31-01', 'REQ-HW-38-01', 'REQ-ARCH-50', ...Array.from({ length: 5 }, (_, index) => `REQ-UX-${index + 43}`)];
if (taskId === 'TASK-09') record.requirements = ['REQ-HW-33-01', 'REQ-HW-39-01', 'REQ-HW-40-01', 'REQ-UX-44', 'REQ-UX-45', 'REQ-UX-46', 'REQ-UX-47'];
if (taskId === 'TASK-10') record.requirements = ['REQ-HW-36-01', 'REQ-HW-37-01', 'REQ-UX-44', 'REQ-UX-45', 'REQ-UX-46'];
if (taskId === 'TASK-11') record.requirements = [...new Set([...readFileSync('docs/requirements-and-acceptance.md', 'utf8').matchAll(/\| (REQ-[A-Z]+-\d+) \|/g)].map(match => match[1])), 'REQ-ARCH-48', 'REQ-ARCH-50', 'REQ-UX-44', 'REQ-UX-46', 'REQ-UX-47', 'REQ-HW-40-01'];
if (taskId === 'TASK-12') record.requirements = ['REQ-ARCH-49', 'REQ-ARCH-48', 'REQ-PROD-01', 'REQ-PROD-06', 'REQ-ARCH-05', 'REQ-UX-06', 'REQ-ARCH-01', 'REQ-ARCH-02', 'REQ-ARCH-03', 'REQ-AGENT-29'];
const changed = spawnSync('git', ['diff', '--name-only', 'HEAD'], { encoding: 'utf8', windowsHide: true });
const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { encoding: 'utf8', windowsHide: true });
record.changedFiles = [...new Set((changed.stdout + '\n' + untracked.stdout).trim().split(/\r?\n/).filter(Boolean))].sort();
const stages = [
  ['documentation.contracts', '.venv-validation/Scripts/python.exe', ['scripts/validate_pack.py', '--contracts'], 'document'],
  ['software.boundaries', process.execPath, [npm, 'run', 'check'], 'software'],
  ['software.tests', process.execPath, [npm, 'test'], 'software'],
  ['package', process.execPath, [npm, 'run', 'package'], 'packaged-windows'],
  ['host.installed', process.execPath, [npm, 'run', 'test:packaged'], 'packaged-windows']
];
for (const [testId, executable, args, evidenceClass] of stages) {
  const startedAt = new Date().toISOString();
  console.log(`${taskId}: ${testId}`);
  const child = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true, timeout: ['TASK-11', 'TASK-12'].includes(taskId) && testId === 'software.tests' ? 900000 : ['TASK-10', 'TASK-11', 'TASK-12'].includes(taskId) ? 600000 : 240000, maxBuffer: 8 * 1024 * 1024 });
  const output = (child.stdout ?? '') + (child.stderr ?? '') + (child.error ? '\n' + String(child.error) : '');
  const path = `${directory}/${testId}.log`;
  writeFileSync(path, output);
  record.checks.push({ testId, commandOrProcedure: [executable, ...args].join(' '), startedAt, endedAt: new Date().toISOString(),
    result: child.status === 0 ? 'passed' : 'failed', exitCode: child.status, evidenceClass, evidence: { path, sha256: hash(output) } });
  writeFileSync(`verification/${taskId.toLowerCase()}.json`, JSON.stringify(record, null, 2) + '\n');
  mkdirSync('verification/history', { recursive: true });
  writeFileSync(`verification/history/${taskId.toLowerCase()}-${runId}.json`, JSON.stringify(record, null, 2) + '\n');
  if (child.status !== 0) { process.stderr.write(output.slice(-12000)); process.exitCode = 1; break; }
}
