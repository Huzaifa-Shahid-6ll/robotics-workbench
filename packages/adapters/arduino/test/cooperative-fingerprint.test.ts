import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fingerprintTree, fingerprintTreeAsync } from '../src/index';

test('cooperative input hashing preserves exact identities while the event loop continues serving other work', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-input-hash-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'nested')); mkdirSync(join(directory, '.git')); writeFileSync(join(directory, '.git', 'ignored'), 'not a tool input');
  for (let index = 0; index < 64; index++) writeFileSync(join(directory, 'nested', `${index}.h`), Buffer.alloc(128 * 1024, index));
  let heartbeats = 0; const timer = setInterval(() => { heartbeats++; }, 0);
  try { assert.deepEqual(await fingerprintTreeAsync(directory), fingerprintTree(directory)); assert.ok(heartbeats > 0, 'Inventory work must yield so operation queries and cancellation remain observable.'); }
  finally { clearInterval(timer); }
});

test('cooperative input hashing observes cancellation during input work without returning a partial fingerprint', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-input-cancel-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'large.h'), Buffer.alloc(16 * 1024 * 1024));
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5);
  try { await assert.rejects(fingerprintTreeAsync(directory, controller.signal), { code: 'CANCELLED' }); }
  finally { clearTimeout(timer); }
});

test('an input changed between asynchronous read chunks is rejected instead of publishing a mixed build identity', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-input-race-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, 'library.h'); writeFileSync(source, Buffer.alloc(256 * 1024)); let changed = false;
  const originalOpen = fs.open;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args), read = handle.read.bind(handle);
    handle.read = (async (...values: unknown[]) => {
      const result = await (read as (...input: unknown[]) => Promise<{ bytesRead: number }>)(...values);
      if (!changed && result.bytesRead > 0) { changed = true; appendFileSync(source, 'independent local-library edit'); }
      return result;
    }) as typeof handle.read;
    return handle;
  });
  await assert.rejects(fingerprintTreeAsync(directory), { code: 'REVISION_CONFLICT' }); assert.equal(changed, true);
});
