import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { vscodePath } from '../vscode-path.mjs';

const phases = ['baseline', 'proposed', 'written', 'conflicted', 'failed'];
const { values } = parseArgs({ options: { launch: { type: 'boolean' }, 'owner-released': { type: 'boolean' }, advance: { type: 'string' }, phase: { type: 'string' }, finish: { type: 'boolean' }, 'self-test': { type: 'boolean' } } });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function scopedSession(path) { const root = realpathSync(resolve('artifacts/task11-native-conflict')), target = realpathSync(path), child = relative(root, target); assert.ok(child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child), 'Fixture plan must stay under its owned native-conflict artifact directory.'); return target; }
if (values['self-test']) {
  assert.equal(phases.includes('conflicted'), true); assert.equal(phases.includes('upload'), false);
  assert.throws(() => scopedSession(resolve('package.json')));
  assert.equal(values.launch, undefined);
  console.log('S18 native fixture runner self-check passed; no GUI, companion or hardware launched.');
} else if (values.advance) {
  assert.ok(phases.includes(values.phase), 'Supply the exact current --phase from checkpoint.json.');
  const plan = JSON.parse(readFileSync(scopedSession(resolve(values.advance)), 'utf8'));
  const current = JSON.parse(readFileSync(join(plan.evidenceDirectory, 'checkpoint.json'), 'utf8'));
  assert.equal(current.runId, plan.runId); assert.equal(current.phase, values.phase, 'Observe the current fixture before advancing.');
  if (values.phase === 'conflicted' || values.phase === 'failed') assert.ok(values.finish, 'Use --finish after final observations; the fixture does not repeat effects.');
  const control = join(dirname(scopedSession(resolve(values.advance))), 'control.json');
  writeFileSync(control, JSON.stringify({ runId: plan.runId, phase: values.phase, action: values.finish ? 'finish' : 'advance' }) + '\n');
  console.log(`Requested ${values.finish ? 'finish with preserved evidence' : 'next fixture phase'}; observe checkpoint.json for completion.`);
} else {
  if (values.launch) assert.ok(values['owner-released'], 'Root must confirm other native/bench/companion sessions have finished.');
  const runId = randomUUID(), directory = resolve('artifacts/task11-native-conflict', runId), projectRoot = join(directory, 'project'), profile = join(directory, 'profile');
  const evidenceDirectory = resolve('verification/evidence/task-11/ui/native-conflict', runId);
  mkdirSync(projectRoot, { recursive: true }); mkdirSync(join(profile, 'User'), { recursive: true }); mkdirSync(evidenceDirectory, { recursive: true });
  const executable = realpathSync(vscodePath()), extensions = realpathSync(resolve('.vscode-test/installed-extensions'));
  const candidates = readdirSync(extensions).filter(name => name.startsWith('local-workbench.robotics-workbench-')); assert.equal(candidates.length, 1);
  const installedExtension = join(extensions, candidates[0]), manifest = JSON.parse(readFileSync(join(installedExtension, 'package.json'), 'utf8'));
  assert.equal(manifest.publisher, 'local-workbench'); assert.equal(manifest.name, 'robotics-workbench');
  const installedSha256 = hash(readFileSync(join(installedExtension, 'dist/extension.js'))), currentSha256 = hash(readFileSync('apps/extension/dist/extension.js'));
  if (values.launch) assert.equal(installedSha256, currentSha256, 'Complete the final inspected installed build before native fixture launch.');
  const baselineText = '// SYNTHETIC S18 native review fixture. No hardware actions.\nint value = 1;\nvoid setup() {}\nvoid loop() {}\n';
  writeFileSync(join(projectRoot, 'NativeConflict.ino'), baselineText, { flag: 'wx' });
  const targetId = randomUUID(); writeFileSync(join(projectRoot, 'workbench.json'), JSON.stringify({ schemaVersion: 1, projectId: randomUUID(), projectRevision: 1, name: 'Synthetic S18 native conflict fixture', sketches: [{ path: '.', targetId }], targets: [{ targetId, fqbn: 'arduino:avr:uno', options: {} }], components: [], nets: [], codeBindings: [], documents: [], extensions: {} }, null, 2), { flag: 'wx' });
  writeFileSync(join(profile, 'User/settings.json'), JSON.stringify({ 'window.title': `TASK-11 S18 ${runId.slice(0, 8)} · \${activeEditorShort}`, 'window.restoreWindows': 'none', 'window.zoomLevel': 0, 'workbench.colorTheme': 'Dark Modern', 'workbench.startupEditor': 'none', 'update.mode': 'none', 'extensions.autoUpdate': false, 'telemetry.telemetryLevel': 'off', 'roboticsWorkbench.nodePath': process.execPath, 'roboticsWorkbench.dataRoot': join(directory, 'unused-data') }, null, 2), { flag: 'wx' });
  const host = join(directory, 'manual-host.cjs');
  await build({ entryPoints: ['apps/extension/test/task11-manual-conflict-host.ts'], outfile: host, bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['vscode'] });
  const args = [projectRoot, '--new-window', '--user-data-dir', profile, '--extensions-dir', extensions, '--skip-welcome', '--skip-release-notes', '--disable-updates', '--disable-workspace-trust', `--extensionDevelopmentPath=${installedExtension}`, `--extensionTestsPath=${host}`];
  const plan = { taskId: 'TASK-11', screen: 'S18', runId, status: 'prepared-not-launched', createdAt: new Date().toISOString(), executable, executableSha256: hash(readFileSync(executable)), installedExtension, installedVersion: manifest.version, installedSha256, matchesCurrentBuild: installedSha256 === currentSha256, host, hostSha256: hash(readFileSync(host)), projectRoot, profile, evidenceDirectory, controlPath: join(directory, 'control.json'), baselineText, args,
    checkpoints: phases, manualObservations: 'not-run', narrator: 'not-run', limitations: ['Supported real VS Code extension test host and actual TaskReview/nativeReviewHost; only ordinary synthetic source and explicit fixture metadata store.', 'No backend SQLite acceptance, provider, compiler, serial or upload claim.', 'Source, dirty-buffer copies, immutable review snapshots and checkpoint history remain retained after finish.'], source: 'https://code.visualstudio.com/api/working-with-extensions/testing-extension' };
  const path = join(directory, 'plan.json'); writeFileSync(path, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
  if (values.launch) {
    const log = openSync(join(evidenceDirectory, 'host-process.log'), 'a');
    const child = spawn(executable, args, { detached: true, windowsHide: false, stdio: ['ignore', log, log], env: { ...process.env, WORKBENCH_MANUAL_CONFLICT_PLAN: path } });
    try { await new Promise((accept, reject) => { child.once('spawn', accept); child.once('error', reject); }); child.unref(); }
    finally { closeSync(log); }
    plan.status = 'launcher-started-ui-unverified'; plan.launcherPid = child.pid; writeFileSync(path, JSON.stringify(plan, null, 2) + '\n');
  }
  console.log(JSON.stringify({ status: plan.status, plan: path, checkpoint: join(evidenceDirectory, 'checkpoint.json'), profile, projectRoot, advanceExample: `node scripts/ui/task11-conflict-native.mjs --advance "${path}" --phase baseline`, finishExample: `node scripts/ui/task11-conflict-native.mjs --advance "${path}" --phase conflicted --finish` }, null, 2));
}
