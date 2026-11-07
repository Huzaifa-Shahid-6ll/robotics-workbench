import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { dirname, resolve } from 'node:path';

const matrix = JSON.parse(readFileSync('scripts/recovery/fault-matrix.json', 'utf8'));
assert.equal(matrix.schemaVersion, 1);
assert.equal(matrix.faults.length, 12, 'D48 has twelve required fault scenarios.');
assert.equal(new Set(matrix.faults.map(fault => fault.testId)).size, 12);
for (const fault of matrix.faults) {
  assert.ok(fault.requirements.length && fault.oracle);
  assert.ok(readFileSync(fault.source, 'utf8').includes(fault.testName), `Missing named test: ${fault.testId}`);
}
const runId = randomUUID(), directory = `verification/evidence/task-11/journeys/${runId}`;
mkdirSync(directory, { recursive: true });
const testSources = [...new Set([...matrix.faults.map(fault => fault.source), ...(matrix.additionalSuites ?? [])])];
const sourceFiles = [...testSources, 'packages/test-fixtures/recovery/provider.ts', 'scripts/recovery/fault-matrix.json', 'scripts/recovery/journeys.mjs'].sort();
const sourceHash = createHash('sha256');
for (const path of sourceFiles) sourceHash.update(path + '\0').update(readFileSync(path));
const sourceDigest = sourceHash.digest('hex'), startedAt = new Date().toISOString(), built = [];
const options = { bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['vscode'], logLevel: 'silent' };
let output = '', exitCode = 1;
try {
  for (const source of testSources) {
    const outfile = resolve('artifacts/task11-faults', source.replace(/\.ts$/, '.cjs'));
    await build({ ...options, entryPoints: [source], outfile }); built.push(outfile);
  }
  const companionTests = resolve('artifacts/task11-faults/apps/companion/test');
  await build({ ...options, entryPoints: ['apps/companion/src/telemetry-worker.ts'], outfile: resolve(companionTests, 'telemetry-worker.cjs') });
  const child = spawnSync(process.execPath, ['--test', ...built], { encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  output = (child.stdout ?? '') + (child.stderr ?? '') + (child.error ? '\n' + child.error.message : ''); exitCode = child.status ?? 1;
} catch (error) { output += String(error); }
const evidence = { path: `${directory}/faults.log`, sha256: createHash('sha256').update(output).digest('hex') };
writeFileSync(evidence.path, output);
const result = { schemaVersion: 1, taskId: 'TASK-11', testId: 'task11.deterministic-fault-matrix', runId, sourceDigest,
  sourceDigestScope: 'Named test source files, fixture provider and recovery runner/catalog; production source is separately bound by the integration verification record.',
  appVersion: JSON.parse(readFileSync('package.json', 'utf8')).version, environment: { platform: platform(), release: release(), arch: arch(), node: process.version },
  dependencyVersions: { node: process.version, esbuild: JSON.parse(readFileSync('node_modules/esbuild/package.json', 'utf8')).version },
  commandOrProcedure: 'node scripts/recovery/journeys.mjs', startedAt, endedAt: new Date().toISOString(), result: exitCode === 0 ? 'passed' : 'failed', exitCode, evidenceClass: 'software', evidence,
  faults: matrix.faults.map(fault => ({ ...fault, result: exitCode === 0 ? 'passed' : 'failed', evidenceClass: 'software', evidence })), limitations: matrix.limitations };
writeFileSync(`${directory}/result.json`, JSON.stringify(result, null, 2) + '\n');
mkdirSync(dirname('verification/evidence/task-11/journeys/latest.json'), { recursive: true });
writeFileSync('verification/evidence/task-11/journeys/latest.json', JSON.stringify({ path: `${directory}/result.json`, result: result.result, runId }, null, 2) + '\n');
process.stdout.write(output);
console.log(`TASK-11 deterministic fault evidence: ${directory}/result.json`);
process.exitCode = exitCode;
