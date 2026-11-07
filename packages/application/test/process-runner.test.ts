import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ProcessRunner } from '../src/jobs/index';

const subprocess = resolve('packages/test-fixtures/devices/subprocess.mjs');
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-runner-')); const runner = new ProcessRunner();
  t.after(async () => { await runner.shutdown(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, runner };
}

test('real executable receives spaces, Unicode and shell metacharacters as literal arguments', async t => {
  const { directory, runner } = fixture(t); const script = join(directory, 'argv ü & $.mjs'); copyFileSync(subprocess, script);
  const args = ['space value', 'Unicode Δ', '$()&|<>', 'quote"slash\\', '-n'];
  const result = await runner.run({ executable: process.execPath, args: [script, 'argv', ...args], cwd: directory });
  assert.equal(result.exitCode, 0); assert.equal(result.terminationObserved, true); assert.deepEqual(JSON.parse(result.stdout), args);
  assert.equal(existsSync(join(directory, 'unexpected')), false);
});

test('flooded stdout/stderr retain bounded memory while exact durable logs remain available', async t => {
  const { directory, runner } = fixture(t);
  const result = await runner.run({ executable: process.execPath, args: [subprocess, 'flood'], cwd: directory, maxOutputBytes: 4096, logDirectory: directory });
  assert.equal(result.exitCode, 0); assert.equal(result.stdoutBytes, 8 * 1024 * 1024); assert.equal(result.stderrBytes, 8 * 1024 * 1024);
  assert.ok(Buffer.byteLength(result.stdout) <= 4096); assert.ok(Buffer.byteLength(result.stderr) <= 4096);
  assert.equal(result.stdoutTruncated, true); assert.equal(result.stderrTruncated, true); assert.equal(result.logsTruncated, false);
  assert.equal(statSync(result.stdoutPath!).size, result.stdoutBytes); assert.equal(statSync(result.stderrPath!).size, result.stderrBytes);
});

test('diagnostic disk cap stops the owned process with explicit truncation', async t => {
  const { directory, runner } = fixture(t);
  const result = await runner.run({ executable: process.execPath, args: [subprocess, 'flood'], cwd: directory, maxOutputBytes: 1024, logDirectory: directory, maxLogBytes: 65536 });
  assert.equal(result.logsTruncated, true); assert.equal(result.terminationObserved, true); assert.ok(statSync(result.stdoutPath!).size <= 65536); assert.ok(statSync(result.stderrPath!).size <= 65536);
});

test('missing executable, relative executable and batch wrappers cannot execute', async t => {
  const { directory, runner } = fixture(t);
  await assert.rejects(runner.run({ executable: join(directory, 'missing.exe'), args: [], cwd: directory }), { code: 'TOOL_UNAVAILABLE' });
  await assert.rejects(runner.run({ executable: 'node', args: [], cwd: directory }), { code: 'INVALID_REQUEST' });
  await assert.rejects(runner.run({ executable: join(directory, 'wrapper.cmd'), args: [], cwd: directory }), { code: 'INVALID_REQUEST' });
  await assert.rejects(runner.run({ executable: process.execPath, args: [], cwd: directory, env: { GITHUB_TOKEN: 'planted-secret' } }), { code: 'INVALID_REQUEST' });
});

test('diagnostic storage failure is reported before tool launch and preserves existing bytes', async t => {
  const { directory, runner } = fixture(t); const blocked = join(directory, 'ordinary-file'); writeFileSync(blocked, 'preserved');
  await assert.rejects(runner.run({ executable: process.execPath, args: [subprocess, 'wait'], cwd: directory, logDirectory: blocked }), { code: 'INTERNAL_ERROR' });
  assert.equal(readFileSync(blocked, 'utf8'), 'preserved');
});

test('watchdog observes process termination and distinguishes timeout from a user cancellation', async t => {
  const { directory, runner } = fixture(t);
  const result = await runner.run({ executable: process.execPath, args: [subprocess, 'wait'], cwd: directory, timeoutMs: 500 });
  assert.equal(result.timedOut, true); assert.equal(result.cancelled, false); assert.equal(result.terminationObserved, true);
  if (result.stdout.trim()) assert.throws(() => process.kill(JSON.parse(result.stdout).pid, 0));
});

test('Windows cancellation observes the owned process and descendant tree ending', async t => {
  const { directory, runner } = fixture(t); const controller = new AbortController();
  const task = runner.run({ executable: process.execPath, args: [subprocess, 'tree'], cwd: directory, signal: controller.signal, logDirectory: directory });
  const { readdirSync } = await import('node:fs');
  let identities: { parentPid: number; childPid: number } | undefined;
  for (let attempt = 0; attempt < 200 && !identities; attempt++) {
    for (const name of readdirSync(directory).filter(name => name.endsWith('.stdout.log'))) {
      try { identities = JSON.parse(readFileSync(join(directory, name), 'utf8').trim()); } catch {}
    }
    if (!identities) await delay(25);
  }
  assert.ok(identities, 'Fixture must identify a live parent and child before cancellation.');
  controller.abort(); const result = await task;
  assert.equal(result.cancelled, true); assert.equal(result.terminationObserved, true);
  assert.throws(() => process.kill(identities.parentPid, 0)); assert.throws(() => process.kill(identities.childPid, 0));
});
