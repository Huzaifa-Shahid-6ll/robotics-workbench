import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ProjectFiles, ProcessRunner } from '@robotics-workbench/application';
import { ArduinoAdapter } from '@robotics-workbench/arduino';

// Explicit compile-only probe: this runner refuses every discovery or upload command.
async function main() {
  const [executable, output] = process.argv.slice(2);
  assert.ok(executable && output, 'Pass the installed Arduino CLI path and a new evidence directory.');
  const directory = resolve(output), runner = new ProcessRunner();
  mkdirSync(directory, { recursive: false });
  const calls: string[][] = [];
  const adapter = new ArduinoAdapter({ run: spec => {
    assert.ok(['version', 'config', 'core', 'lib', 'compile'].includes(spec.args[0]) || (spec.args.length === 2 && spec.args[0] === 'upload' && spec.args[1] === '--help'), 'Physical I/O is forbidden in the compile-only probe.');
    calls.push([...spec.args]); return runner.run(spec);
  } }, executable, join(directory, 'staging é with spaces'));
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const root = resolve('packages/test-fixtures/arduino'), source = join(root, 'WorkbenchProbe', 'WorkbenchProbe.ino');
  const before = hash(readFileSync(source));
  try {
    const files = new ProjectFiles(root);
    const successful = await adapter.compile({ snapshot: files.snapshotSource({ paths: ['WorkbenchProbe'], host: () => ({ dirtyPaths: [] }) }), sketchRelativePath: 'WorkbenchProbe', fqbn: 'arduino:avr:uno', boardOptions: {} });
    assert.equal(successful.succeeded, true); assert.ok(successful.uploadArtifact);
    await adapter.assertCurrent(successful);
    const badRoot = join(directory, 'invalid-source'); mkdirSync(join(badRoot, 'InvalidProbe'), { recursive: true });
    writeFileSync(join(badRoot, 'InvalidProbe', 'InvalidProbe.ino'), 'void setup() {\n  intentional_syntax_error;\n}\nvoid loop() {}\n');
    const invalid = new ProjectFiles(badRoot);
    const failed = await adapter.compile({ snapshot: invalid.snapshotSource({ paths: ['InvalidProbe'], host: () => ({ dirtyPaths: [] }) }), sketchRelativePath: 'InvalidProbe', fqbn: 'arduino:avr:uno', boardOptions: {} });
    assert.equal(failed.succeeded, false); assert.equal(failed.uploadArtifact, undefined); assert.deepEqual(failed.outputs, []);
    assert.ok(failed.diagnostics.some(item => item.path === 'InvalidProbe/InvalidProbe.ino' && item.line === 2 && item.severity === 'error'));
    const after = hash(readFileSync(source)); assert.equal(before, after);
    writeFileSync(join(directory, 'result.json'), JSON.stringify({ hardwareTested: false, sourceSha256Before: before, sourceSha256After: after, successful, failed, calls }, null, 2));
    console.log(JSON.stringify({ evidence: join(directory, 'result.json'), hardwareTested: false, successful: successful.succeeded, failedDiagnostics: failed.diagnostics.length, sourceUnchanged: before === after, uploadArtifactSha256: successful.uploadArtifact.sha256 }));
  } finally { await runner.shutdown(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
