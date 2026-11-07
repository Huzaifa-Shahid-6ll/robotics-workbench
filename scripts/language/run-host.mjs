import { build } from 'esbuild';
import { runTests } from '@vscode/test-electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { vscodePath } from '../vscode-path.mjs';

const root = resolve('verification/evidence/task-08/language');
const profile = resolve('artifacts/tmp/language-host-profile');
await mkdir(root, { recursive: true }); await mkdir(`${profile}/User`, { recursive: true });
await writeFile(`${profile}/User/settings.json`, JSON.stringify({ 'security.workspace.trust.enabled': false, 'update.mode': 'none', 'extensions.autoUpdate': false, 'telemetry.telemetryLevel': 'off' }));
await build({ entryPoints: ['apps/extension/test/language-host.ts'], outfile: 'artifacts/language-host.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['vscode'] });
await runTests({ vscodeExecutablePath: vscodePath(), extensionDevelopmentPath: resolve('apps/extension'), extensionTestsPath: resolve('artifacts/language-host.cjs'), extensionTestsEnv: { WORKBENCH_LANGUAGE_ROOT: root, TEMP: resolve('artifacts/tmp'), TMP: resolve('artifacts/tmp') }, launchArgs: [resolve('packages/test-fixtures/compatibility/trusted workspace'), '--user-data-dir', profile, '--extensions-dir', resolve('artifacts/tmp/language-host-extensions'), '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates'] });
