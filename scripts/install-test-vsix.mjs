import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { vscodePath } from './vscode-path.mjs';
import { verifyNativeRuntime } from './native-runtime.mjs';

// Use the existing official CLI wrapper to select its matching versioned cli.js.
const command = `& $env:WORKBENCH_CODE_CLI --user-data-dir $env:WORKBENCH_TEST_PROFILE --extensions-dir $env:WORKBENCH_TEST_EXTENSIONS --install-extension $env:WORKBENCH_TEST_VSIX --force; exit $LASTEXITCODE`;
const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
  stdio: 'inherit', windowsHide: true,
  env: { ...process.env,
    WORKBENCH_CODE_CLI: resolve(dirname(vscodePath()), 'bin/code.cmd'),
    WORKBENCH_TEST_PROFILE: resolve('.vscode-test/package-install'),
    WORKBENCH_TEST_EXTENSIONS: resolve('.vscode-test/installed-extensions'),
    WORKBENCH_TEST_VSIX: resolve('artifacts/robotics-workbench-0.1.0.vsix') }
});
assert.equal(result.status, 0, 'Isolated VSIX install failed.');
const versions = (await readdir('.vscode-test/installed-extensions')).filter(name => name.startsWith('local-workbench.robotics-workbench-0.1.0'));
assert.equal(versions.length, 1);
const installed = resolve('.vscode-test/installed-extensions', versions[0], 'dist');
for (const asset of ['extension.js', 'companion.js', 'native-runtime.json', 'engineering.js', 'engineering.css', 'cad-runner.py']) {
  assert.deepEqual(await readFile(resolve(installed, asset)), await readFile(resolve('apps/extension/dist', asset)), 'Installed assets must match this build.');
}
await verifyNativeRuntime(installed);
