import { runTests } from '@vscode/test-electron';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { vscodePath } from './vscode-path.mjs';

const packaged = process.argv.includes('--packaged');
const name = packaged ? 'packaged' : 'development';
const executable = vscodePath();
for (const restricted of [false, true]) {
  const label = `${name}-${restricted ? 'restricted' : 'trusted'}`;
  const profile = resolve(`.vscode-test/${label}`);
  const extensions = resolve('.vscode-test/installed-extensions');
  const installed = packaged ? (await readdir(extensions)).filter(name => name.startsWith('local-workbench.robotics-workbench-0.1.0')) : [];
  if (packaged) assert.equal(installed.length, 1, 'Expected one installed workbench version.');
  const workspace = resolve(`packages/test-fixtures/compatibility/${restricted ? 'restricted' : 'trusted'} workspace`);
  const report = resolve(`artifacts/${label}.json`);
  await mkdir(workspace, { recursive: true });
  await mkdir(`${profile}/User`, { recursive: true });
  await writeFile(`${profile}/User/settings.json`, JSON.stringify({
    'security.workspace.trust.enabled': true, 'security.workspace.trust.startupPrompt': 'never',
    'security.workspace.trust.emptyWindow': false, 'update.mode': 'none',
    'extensions.autoUpdate': false, 'telemetry.telemetryLevel': 'off',
    'roboticsWorkbench.nodePath': process.execPath
  }));
  const launchArgs = [workspace, '--user-data-dir', profile, '--extensions-dir', extensions,
    '--skip-welcome', '--skip-release-notes', '--disable-updates', '--disable-extensions'];
  if (!restricted) launchArgs.push('--disable-workspace-trust');
  const options = {
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: packaged ? resolve(extensions, installed[0]) : resolve('apps/extension'),
    extensionTestsPath: resolve('artifacts/host-tests.cjs'),
    extensionTestsEnv: { WORKBENCH_TEST_RESTRICTED: restricted ? '1' : '0', WORKBENCH_TEST_REPORT: report, WORKBENCH_TEST_EXTENSION_PATH: packaged ? resolve(extensions, installed[0]) : resolve('apps/extension'), WORKBENCH_TEST_NODE_EXECUTABLE: process.execPath, WORKBENCH_TASK09_SEED: resolve('artifacts/task09-seed.cjs'), WORKBENCH_TASK10_SEED: resolve('artifacts/task10-seed.cjs'), WORKBENCH_TASK10_KICAD_PATH: process.env.WORKBENCH_TASK10_KICAD_PATH ?? '', WORKBENCH_TASK10_KICAD_SHA: process.env.WORKBENCH_TASK10_KICAD_SHA ?? '', WORKBENCH_TASK10_CAD_PYTHON: process.env.WORKBENCH_TASK10_CAD_PYTHON ?? '' },
    launchArgs
  };
  const log = createWriteStream(resolve(`artifacts/${label}.log`));
  if (restricted) {
    // test-electron 3.1.0 unconditionally disables trust; launch this case directly.
    await new Promise((accept, reject) => {
      const child = spawn(executable, [...launchArgs,
        `--extensionDevelopmentPath=${options.extensionDevelopmentPath}`,
        `--extensionTestsPath=${options.extensionTestsPath}`], {
        env: { ...process.env, ...options.extensionTestsEnv }, windowsHide: true
      });
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      child.once('error', reject);
      child.once('close', code => code === 0 ? accept() : reject(new Error(`${label} failed with ${code}; see artifacts/${label}.log`)));
    });
  } else await runTests({ ...options, stdout: log, stderr: log });
  log.end();
  const result = JSON.parse(await readFile(report, 'utf8'));
  assert.equal(result.passed, true);
  if (result.pid) {
    const deadline = Date.now() + 10000;
    let alive = true;
    while (Date.now() < deadline && alive) {
      try { process.kill(result.pid, 0); await new Promise(resolve => setTimeout(resolve, 100)); }
      catch { alive = false; }
    }
    assert.equal(alive, false, `Host deactivation leaked companion PID ${result.pid}`);
  }
  console.log(`${label}: passed; companion exit observed.`);
}
