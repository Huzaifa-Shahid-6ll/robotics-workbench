const { execFile } = require('node:child_process');
const { join } = require('node:path');
const { promisify } = require('node:util');

exports.activate = context => ({
  run: async () => {
    const result = await promisify(execFile)(process.env.WORKBENCH_NATIVE_NODE,
      [context.asAbsolutePath('native-worker.cjs'), process.env.WORKBENCH_NATIVE_DATA], {
        cwd: context.extensionPath, windowsHide: true, timeout: 15000,
        env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
        maxBuffer: 16384
      });
    return JSON.parse(result.stdout);
  }
});
