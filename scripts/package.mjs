import { createVSIX } from '@vscode/vsce';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { verifyNativeRuntime } from './native-runtime.mjs';

await mkdir('artifacts', { recursive: true });
const inputs = JSON.parse(await readFile('artifacts/bundle-inputs.json', 'utf8'));
const roots = [...new Set(inputs.map(path => path.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//)?.[1]).filter(Boolean))];
const inventory = [];
let notices = 'Bundled third-party code, including the Windows x64 SerialPort native runtime.\n';
for (const root of roots.sort()) {
  const pkg = JSON.parse(await readFile(`${root}/package.json`, 'utf8'));
  let license;
  let licensePath;
  for (const name of ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'license', 'license.txt']) {
    try { license = await readFile(`${root}/${name}`, 'utf8'); licensePath = `${root}/${name}`; break; } catch {}
  }
  if (!license && pkg.name === '@opencode-ai/sdk' && pkg.version === '1.18.32') {
    // The npm tarball omits its MIT notice; retain the matching upstream tag's notice.
    licensePath = 'third-party/opencode-1.18.32-LICENSE.txt';
    license = await readFile(licensePath, 'utf8');
    pkg.repository = 'https://github.com/anomalyco/opencode/tree/v1.18.32';
  }
  assert.ok(license, `Missing redistribution notice for ${pkg.name}`);
  inventory.push({ name: pkg.name, version: pkg.version, license: pkg.license, source: pkg.repository, licensePath, bundled: true });
  notices += `\n\n${pkg.name}@${pkg.version}\n${license}\n`;
}
const native = await verifyNativeRuntime(resolve('apps/extension/dist'));
for (const pkg of native.packages) {
  const license = await readFile(resolve('apps/extension/dist', pkg.licensePath), 'utf8');
  const existing = inventory.find(item => item.name === pkg.name && item.version === pkg.version);
  if (existing) { existing.bundledNativeRuntime = true; continue; }
  inventory.push({ ...pkg, bundled: true, bundledNativeRuntime: true });
  notices += `\n\n${pkg.name}@${pkg.version}\n${license}\n`;
}
await writeFile('apps/extension/dist/THIRD-PARTY-NOTICES.txt', notices);
await writeFile('artifacts/license-inventory.json', JSON.stringify(inventory, null, 2)+'\n');
const packagePath = resolve('artifacts/robotics-workbench-0.1.0.vsix');
await createVSIX({ cwd: resolve('apps/extension'), packagePath, target: 'win32-x64', dependencies: false, allowMissingRepository: true });
const negativeInspection = spawnSync(resolve('.venv-validation/Scripts/python.exe'), ['scripts/inspect-vsix.py', '--self-test'], { encoding: 'utf8' });
process.stdout.write(negativeInspection.stdout ?? '');
process.stderr.write(negativeInspection.stderr ?? '');
assert.equal(negativeInspection.status, 0, 'VSIX inspection negative fixtures failed.');
const inspection = spawnSync(resolve('.venv-validation/Scripts/python.exe'), ['scripts/inspect-vsix.py', packagePath], { encoding: 'utf8' });
process.stdout.write(inspection.stdout ?? '');
process.stderr.write(inspection.stderr ?? '');
assert.equal(inspection.status, 0, 'VSIX inspection failed; initialize the validation venv as documented.');
const bytes = await readFile(packagePath);
const checksum = createHash('sha256').update(bytes).digest('hex');
await writeFile('artifacts/robotics-workbench-0.1.0.vsix.sha256', `${checksum}  robotics-workbench-0.1.0.vsix\n`);
console.log(`VSIX SHA256 ${checksum}`);
