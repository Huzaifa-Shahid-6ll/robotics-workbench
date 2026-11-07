import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { vscodePath } from './vscode-path.mjs';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VSCODE_DEV;
const child = spawn(vscodePath(), ['--new-window', `--extensionDevelopmentPath=${resolve('apps/extension')}`, resolve('.')], {
  detached: true, stdio: 'ignore', windowsHide: false, env
});
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.unref();
