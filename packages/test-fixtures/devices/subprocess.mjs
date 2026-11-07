import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Synthetic owned-process fixture; never opens a device or runs a toolchain.
const mode = process.argv[2];
if (mode === 'argv') process.stdout.write(JSON.stringify(process.argv.slice(3)));
else if (mode === 'flood') {
  const chunk = Buffer.alloc(64 * 1024, 120);
  for (let index = 0; index < 128; index++) {
    if (!process.stdout.write(chunk)) await once(process.stdout, 'drain');
    if (!process.stderr.write(chunk)) await once(process.stderr, 'drain');
  }
} else if (mode === 'leaf') {
  process.send?.({ pid: process.pid });
  setInterval(() => {}, 1000);
} else if (mode === 'tree') {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'leaf'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  const [message] = await once(child, 'message');
  process.stdout.write(JSON.stringify({ parentPid: process.pid, childPid: message.pid }) + '\n');
  setInterval(() => {}, 1000);
} else if (mode === 'wait') {
  process.stdout.write(JSON.stringify({ pid: process.pid }) + '\n');
  setInterval(() => {}, 1000);
} else throw new Error('Expected argv, flood, leaf, tree or wait fixture mode.');
