import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { ProjectFiles, ProcessRunner } from '@robotics-workbench/application';
import { ArduinoAdapter } from '@robotics-workbench/arduino';

// Explicit compile-only compatibility procedure; never discovers or opens a port.
async function main(): Promise<void> {
  const root = resolve('.'), path = 'packages/test-fixtures/arduino/WorkbenchProbe', source = join(root, path, 'WorkbenchProbe.ino');
  const hash = () => createHash('sha256').update(readFileSync(source)).digest('hex');
  const before = hash(), output = resolve('artifacts/task04-arduino-smoke'); mkdirSync(output, { recursive: true });
  const runner = new ProcessRunner();
  try {
    const adapter = new ArduinoAdapter(runner, process.argv[2] ?? 'C:/Program Files/Arduino IDE/resources/app/lib/backend/resources/arduino-cli.exe', output);
    const snapshot = new ProjectFiles(root).snapshotSource({ paths: [path], host: () => ({ dirtyPaths: [] }) });
    const result = await adapter.compile({ snapshot, sketchRelativePath: path, fqbn: 'arduino:avr:uno', boardOptions: {} });
    writeFileSync(join(output, 'result.json'), JSON.stringify({ hardwareTested: false, sourceSha256Before: before, sourceSha256After: hash(), result }, null, 2) + '\n');
    assert.equal(hash(), before); assert.equal(result.succeeded, true); assert.ok(result.uploadArtifact?.sizeBytes);
    console.log(`Compile-only Uno fixture passed: ${result.uploadArtifact.sha256}; original source unchanged.`);
  } finally { await runner.shutdown(); }
}
main().catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
