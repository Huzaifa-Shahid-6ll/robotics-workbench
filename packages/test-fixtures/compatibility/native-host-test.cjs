const assert = require('node:assert/strict');
const vscode = require('vscode');
const { writeFile } = require('node:fs/promises');

exports.run = async () => {
  const extension = vscode.extensions.getExtension('local-workbench.native-compatibility-probe');
  assert.ok(extension);
  assert.ok(extension.extensionPath.toLowerCase().includes('installed-native-extensions'));
  const result = await (await extension.activate()).run();
  assert.equal(result.passed, true);
  assert.equal(result.physicalDeviceAccessed, false);
  await writeFile(process.env.WORKBENCH_NATIVE_REPORT, JSON.stringify({ ...result, extensionPath: extension.extensionPath, vscodeVersion: vscode.version }, null, 2)+'\n');
};
