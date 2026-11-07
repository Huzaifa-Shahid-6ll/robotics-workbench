import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { vscodePath } from '../vscode-path.mjs';

const themes = { dark: 'Dark Modern', light: 'Light Modern', contrast: 'Default High Contrast' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, child) => { const path = relative(root, child); return !path || !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`); };
function resourcesFromWrapper(wrapper, cliDirectory) {
  const relativeCli = wrapper.match(/"%~dp0([^"\r\n]*resources[\\/]app[\\/]out[\\/]cli\.js)"/i)?.[1];
  assert.ok(relativeCli, 'The installed official code.cmd must identify its matching cli.js.');
  return dirname(dirname(resolve(cliDirectory, relativeCli)));
}
function launchArguments(projectRoot, profile, extensions, restricted) {
  return [projectRoot, '--new-window', '--user-data-dir', profile, '--extensions-dir', extensions, '--skip-welcome', '--skip-release-notes', '--disable-updates', ...restricted ? [] : ['--disable-workspace-trust']];
}
const { values } = parseArgs({ options: {
  'project-root': { type: 'string' }, 'data-root': { type: 'string' }, 'extensions-dir': { type: 'string', default: '.vscode-test/installed-extensions' },
  theme: { type: 'string', default: 'dark' }, zoom: { type: 'string', default: '100' }, restricted: { type: 'boolean', default: false },
  launch: { type: 'boolean', default: false }, 'owner-released': { type: 'boolean', default: false }, 'self-test': { type: 'boolean', default: false }
} });
if (values['self-test']) {
  assert.ok(Math.abs(1.2 ** (Math.log(2) / Math.log(1.2)) - 2) < .000001);
  assert.ok(inside(resolve('artifacts'), resolve('artifacts/test'))); assert.equal(inside(resolve('artifacts'), resolve('artifacts-other')), false);
  const args = launchArguments('G:/project', 'G:/profile', 'G:/extensions', true);
  assert.equal(args.includes('--disable-workspace-trust'), false); assert.ok(launchArguments('G:/project', 'G:/profile', 'G:/extensions', false).includes('--disable-workspace-trust'));
  assert.ok(args.every(item => typeof item === 'string')); assert.equal(args.some(item => item.includes('extensionDevelopmentPath') || item.includes('extensionTestsPath') || item.includes('upload')), false);
  assert.throws(() => resourcesFromWrapper('unrecognized wrapper', resolve('artifacts')));
  console.log('Native-session planner self-check passed; no GUI, companion or device was launched.');
} else {
  assert.equal(process.platform, 'win32', 'This native plan targets the recorded Windows desktop.');
  assert.ok(values['project-root'] && values['data-root'], 'Supply --project-root and --data-root from the same retained bench run.');
  assert.ok(Object.hasOwn(themes, values.theme) && ['100', '200'].includes(values.zoom), 'Use theme dark|light|contrast and zoom 100|200.');
  if (values.launch) assert.ok(values['owner-released'], 'Verify all workbench companions/bench/live-provider/installed-host jobs are closed, then supply --owner-released.');
  const projectRoot = realpathSync(resolve(values['project-root'])), dataRoot = realpathSync(resolve(values['data-root']));
  assert.ok(!/^\\\\|^\/\//.test(projectRoot) && !/^\\\\|^\/\//.test(dataRoot), 'Use the supported local Windows roots, not UNC storage.');
  assert.ok(!inside(projectRoot, dataRoot) && !inside(dataRoot, projectRoot), 'Use separate project and operational roots.');
  const manifestPath = join(projectRoot, 'workbench.json'), manifestBytes = readFileSync(manifestPath), manifest = JSON.parse(manifestBytes);
  assert.ok(manifest.schemaVersion === 1 && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(manifest.projectId) && Number.isSafeInteger(manifest.projectRevision), 'Supply an existing identified bench project.');
  assert.ok(existsSync(join(dataRoot, 'workbench.sqlite')), 'The retained bench operational database must already exist; the planner never creates or opens it.');
  const executable = realpathSync(vscodePath()), cliDirectory = join(dirname(executable), 'bin');
  assert.equal(existsSync(join(dirname(executable), 'data')), false, 'Portable-mode data overrides isolation flags; use the tested ordinary installation.');
  const resourceRoot = resourcesFromWrapper(readFileSync(join(cliDirectory, 'code.cmd'), 'utf8'), cliDirectory);
  const vscodeVersion = JSON.parse(readFileSync(join(resourceRoot, 'package.json'), 'utf8')).version;
  const availableThemes = JSON.parse(readFileSync(join(resourceRoot, 'extensions/theme-defaults/package.json'), 'utf8')).contributes.themes;
  assert.ok(availableThemes.some(item => item.id === themes[values.theme]), 'The requested built-in theme must exist in this exact installation.');
  const extensions = realpathSync(resolve(values['extensions-dir']));
  const candidates = readdirSync(extensions, { withFileTypes: true }).filter(item => item.isDirectory() && item.name.startsWith('local-workbench.robotics-workbench-')).map(item => join(extensions, item.name));
  assert.equal(candidates.length, 1, 'Expected one previously installed private workbench version; run the inspected install wrapper first.');
  const installed = candidates[0], extension = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  assert.equal(extension.publisher, 'local-workbench'); assert.equal(extension.name, 'robotics-workbench');
  const assets = ['extension.js', 'companion.js', 'mcp-stdio.js', 'native-runtime.json', 'agent.js', 'agent.css', 'wiring.js', 'wiring.css', 'documents.js', 'documents.css', 'telemetry.js', 'telemetry.css', 'engineering.js', 'engineering.css', 'cad-runner.py'].map(name => {
    const path = join(installed, 'dist', name), sha256 = hash(readFileSync(path)), current = resolve('apps/extension/dist', name);
    return { name, path, sha256, matchesCurrentBuild: existsSync(current) && hash(readFileSync(current)) === sha256 };
  });
  if (values.launch) assert.ok(assets.every(item => item.matchesCurrentBuild), 'Installed bytes differ from the current build. Finish the final inspected package/install wrapper before native QA.');
  const runId = randomUUID(), directory = resolve('artifacts/task11-native', runId), profile = join(directory, 'profile');
  const evidence = resolve('verification/evidence/task-11/ui/native', runId);
  mkdirSync(join(profile, 'User'), { recursive: true }); mkdirSync(evidence, { recursive: true });
  const settings = { 'window.title': `TASK-11 native QA ${runId.slice(0, 8)} · \${rootName} · \${activeEditorShort}`, 'window.restoreWindows': 'none', 'window.zoomPerWindow': true,
    'window.zoomLevel': values.zoom === '200' ? Math.log(2) / Math.log(1.2) : 0, 'workbench.colorTheme': themes[values.theme],
    'workbench.startupEditor': 'none', 'update.mode': 'none', 'extensions.autoUpdate': false, 'telemetry.telemetryLevel': 'off',
    'roboticsWorkbench.nodePath': process.execPath, 'roboticsWorkbench.dataRoot': dataRoot };
  const settingsPath = join(profile, 'User/settings.json'); writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', { flag: 'wx' });
  const fixtureRoot = join(directory, 'synthetic-manual-fixtures'), sketch = join(fixtureRoot, 'ImportProbe'); mkdirSync(sketch, { recursive: true });
  writeFileSync(join(sketch, 'ImportProbe.ino'), '// SYNTHETIC UI FIXTURE. No upload or device action is authorized.\nvoid setup() {}\nvoid loop() {}\n', { flag: 'wx' });
  writeFileSync(join(fixtureRoot, 'ConflictProbe.ino'), '// SYNTHETIC baseline for an isolated dirty-buffer conflict.\nint value = 1;\n', { flag: 'wx' });
  const args = launchArguments(projectRoot, profile, extensions, values.restricted);
  const plan = { schemaVersion: 1, taskId: 'TASK-11', runId, createdAt: new Date().toISOString(), status: 'prepared-not-launched', checks: [],
    executable, executableSha256: hash(readFileSync(executable)), vscodeVersion, args, profile, settingsPath, settingsSha256: hash(readFileSync(settingsPath)),
    installedExtension: { path: installed, publisher: extension.publisher, name: extension.name, version: extension.version, assets },
    project: { root: projectRoot, projectId: manifest.projectId, projectRevision: manifest.projectRevision, manifestSha256: hash(manifestBytes), dataRoot },
    display: { expectedNativeWindow: { width: 1366, height: 768 }, nativeWindowMeasured: null, configuredZoomPercent: Number(values.zoom), theme: themes[values.theme] },
    fixtureRoot, evidenceDirectory: evidence, narrator: { status: 'not-run', version: null, operatorObservation: null },
    prerequisites: ['Physical bench, live-provider jobs and final installed test wrapper have finished and released their sole companion.', 'Installed extension assets match the final inspected build.', 'Observe native window dimensions; settings are not evidence of actual geometry.', 'User operates Narrator and reports actual announcements; no permission/security dialogs are automated.'],
    limitations: ['Preparation does not launch VS Code, a companion, provider, compiler or USB handle.', 'Opening Check Tools/Recovery later may start the single companion; close competing workbench windows first.', 'No upload, raw serial, reconciliation acknowledgment or firmware change belongs in this native UI session.', 'Trusted mode uses the existing host-test CLI trust flag for this isolated instance only; restricted mode omits that flag. Global profiles and settings remain untouched.', 'The generated conflict file alone is not an application TaskReview fixture: a retained synthetic task baseline is still required for S18 app conflict acceptance.'],
    sources: ['https://code.visualstudio.com/docs/configure/command-line', 'https://code.visualstudio.com/docs/configure/accessibility/accessibility'] };
  const path = join(evidence, 'plan.json'); writeFileSync(path, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
  if (values.launch) {
    const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: false });
    await new Promise((accept, reject) => { child.once('spawn', accept); child.once('error', reject); }); child.unref();
    plan.status = 'launcher-started-ui-unverified'; plan.launcherPid = child.pid; plan.launchedAt = new Date().toISOString();
    writeFileSync(path, JSON.stringify(plan, null, 2) + '\n');
  }
  console.log(JSON.stringify({ status: plan.status, plan: path, profile, installed, projectRoot, dataRoot, installedMatchesBuild: assets.every(item => item.matchesCurrentBuild), fixtureRoot }, null, 2));
}
