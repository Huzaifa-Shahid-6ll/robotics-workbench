import { createVSIX } from '@vscode/vsce';
import { runTests } from '@vscode/test-electron';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, dirname, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import assert from 'node:assert/strict';
import { vscodePath } from '../vscode-path.mjs';

const require = createRequire(import.meta.url);
const root = resolve('artifacts/compatibility/native-package');
const stage = join(root, 'stage');
const extensions = resolve('.vscode-test/installed-native-extensions');
const profile = resolve('.vscode-test/native-package');
await mkdir(stage, { recursive: true });
await mkdir(profile, { recursive: true });
const manifest = { name: 'native-compatibility-probe', displayName: 'Isolated native compatibility probe',
  publisher: 'local-workbench', version: '0.0.1', private: true, license: 'UNLICENSED',
  engines: { vscode: '^1.144.0' }, main: './native-extension.cjs', extensionKind: ['ui'],
  activationEvents: [],
  description: 'TASK-00 packaging fixture; no production hardware command.' };
await writeFile(join(stage, 'package.json'), JSON.stringify(manifest, null, 2));
await writeFile(join(stage, 'README.md'), '# Native compatibility spike\nIsolated test fixture. No board access. Not the production workbench.\n');
await writeFile(join(stage, 'LICENSE.txt'), 'Private test fixture. Third-party code retains its included licenses.\n');
await writeFile(join(stage, '.vscodeignore'), '**\n!package.json\n!README.md\n!LICENSE.txt\n!dependency-licenses.json\n!native-extension.cjs\n!native-worker.cjs\n!vendor/**\n');
for (const name of ['native-worker.cjs', 'native-extension.cjs']) await cp(`packages/test-fixtures/compatibility/${name}`, join(stage, name));
const copied = new Set();
const licenses = [];
async function dependency(name, from) {
  let location = dirname(createRequire(from).resolve(name));
  let pkg;
  while (!pkg) {
    try {
      const candidate = JSON.parse(await readFile(join(location, 'package.json'), 'utf8'));
      if (candidate.name === name) pkg = candidate;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!pkg) { const parent = dirname(location); assert.notEqual(parent, location); location = parent; }
  }
  const key = `${pkg.name}@${pkg.version}`;
  if (copied.has(key)) return;
  copied.add(key);
  const destination = join(stage, 'vendor/node_modules', pkg.name);
  await cp(location, destination, { recursive: true, filter: path => !path.includes(`${join('prebuilds', '')}`) || path === join(location, 'prebuilds') || path.includes(join('prebuilds', 'win32-x64')) });
  const names = await readdir(location);
  const licenseFile = names.find(file => /^licen[cs]e(?:\.(md|txt))?$/i.test(file));
  assert.ok(licenseFile, `Missing license for ${key}`);
  licenses.push({ name: pkg.name, version: pkg.version, license: pkg.license, licenseFile, bundledNative: pkg.name === '@serialport/bindings-cpp' });
  for (const child of Object.keys(pkg.dependencies ?? {})) await dependency(child, join(location, 'package.json'));
}
await dependency('@serialport/bindings-cpp', import.meta.url);
await writeFile(join(stage, 'dependency-licenses.json'), JSON.stringify(licenses, null, 2));
const vsix = join(root, 'native-compatibility-probe.vsix');
await createVSIX({ cwd: stage, packagePath: vsix, target: 'win32-x64', dependencies: false, allowMissingRepository: true });
const code = vscodePath();
const install = spawnSync('powershell.exe', ['-NoProfile', '-Command', '& $env:SPIKE_CLI --user-data-dir $env:SPIKE_PROFILE --extensions-dir $env:SPIKE_EXTENSIONS --install-extension $env:SPIKE_VSIX --force; exit $LASTEXITCODE'], {
  encoding: 'utf8', windowsHide: true,
  env: { ...process.env, SPIKE_CLI: join(dirname(code), 'bin/code.cmd'), SPIKE_PROFILE: profile, SPIKE_EXTENSIONS: extensions, SPIKE_VSIX: vsix }
});
assert.equal(install.status, 0, install.stderr);
const folder = (await readdir(extensions)).find(name => name.startsWith('local-workbench.native-compatibility-probe-0.0.1'));
assert.ok(folder);
const installed = join(extensions, folder);
const binaryPath = 'vendor/node_modules/@serialport/bindings-cpp/prebuilds/win32-x64/@serialport+bindings-cpp.node';
assert.deepEqual(await readFile(join(installed, binaryPath)), await readFile(join(stage, binaryPath)));
const log = createWriteStream(join(root, 'host.log'));
const startedAt = new Date().toISOString();
await runTests({ vscodeExecutablePath: code, extensionDevelopmentPath: installed,
  extensionTestsPath: resolve('packages/test-fixtures/compatibility/native-host-test.cjs'),
  extensionTestsEnv: { WORKBENCH_NATIVE_NODE: process.execPath, WORKBENCH_NATIVE_DATA: join(root, 'data'), WORKBENCH_NATIVE_REPORT: join(root, 'result.json') },
  launchArgs: ['--user-data-dir', profile, '--extensions-dir', extensions, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--disable-updates'],
  stdout: log, stderr: log
});
log.end();
const result = JSON.parse(await readFile(join(root, 'result.json'), 'utf8'));
Object.assign(result, { gateId: 'VG-07', startedAt, endedAt: new Date().toISOString(),
  vsixSha256: createHash('sha256').update(await readFile(vsix)).digest('hex'),
  nativeBinarySha256: createHash('sha256').update(await readFile(join(installed, binaryPath))).digest('hex'),
  dependencies: licenses, scope: 'Installed fixture VSIX, local Node runtime, durable SQLite and native serial ordinary-file failure path only. Real serial success/reset/USB tests remain VG-06.' });
await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2)+'\n');
console.log('Installed native SQLite/serial packaging probe passed; no physical device accessed.');
