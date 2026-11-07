import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourcePolicy, codexArguments, manifestForSketch, type HostDocument } from '../src/source-policy';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'workbench-source-policy-'));
  const path = join(root, 'Ordinary.ino'); writeFileSync(path, 'old saved source');
  let text = 'old saved source', version = 1, dirty = false, saves = 0;
  const document: HostDocument = { uri: { scheme: 'file', fsPath: path }, get version() { return version; }, get isDirty() { return dirty; },
    getText: () => text, save: async () => { saves++; writeFileSync(path, text); dirty = false; return true; } };
  const policy = new SourcePolicy(); policy.remember(document);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, path, document, policy, edit(value: string) { text = value; version++; dirty = true; }, saves: () => saves };
}

test('save policy requires explicit save and preserves both dirty/provider versions on conflict', async t => {
  const f = fixture(t); f.edit('user unsaved edit');
  writeFileSync(f.path, 'provider external edit');
  await assert.rejects(f.policy.save(f.root, [f.document], async () => true), { code: 'REVISION_CONFLICT' });
  assert.equal(f.saves(), 0); assert.equal(f.document.getText(), 'user unsaved edit'); assert.equal(readFileSync(f.path, 'utf8'), 'provider external edit');
});

test('declined save submits nothing; successful save freezes versions and saved-byte hashes', async t => {
  const f = fixture(t); f.edit('user intended source');
  await assert.rejects(f.policy.save(f.root, [f.document], async () => false));
  assert.equal(f.saves(), 0); assert.equal(readFileSync(f.path, 'utf8'), 'old saved source');
  const frozen = await f.policy.save(f.root, [f.document], async () => true);
  assert.equal(f.saves(), 1); assert.equal(frozen[0].path, 'Ordinary.ino'); f.policy.assertUnchanged(f.root, frozen);
  writeFileSync(f.path, 'later provider write');
  assert.throws(() => f.policy.assertUnchanged(f.root, frozen), { code: 'REVISION_CONFLICT' });
});

test('unknown dirty baseline never overwrites disk; root sketches retain their ordinary folder', async t => {
  const f = fixture(t); f.edit('unsaved before bind'); const unknown = new SourcePolicy(); unknown.remember(f.document);
  await assert.rejects(unknown.save(f.root, [f.document], async () => true), { code: 'REVISION_CONFLICT' });
  const manifest = manifestForSketch(f.root, f.root, 'arduino:avr:uno'); assert.equal(manifest.sketches[0].path, '.');
  const nested = join(f.root, 'Nested'); mkdirSync(nested);
  assert.equal(manifestForSketch(f.root, nested, 'arduino:avr:uno').sketches[0].path, 'Nested');
  assert.equal(readFileSync(f.path, 'utf8'), 'old saved source');
});

test('Codex terminal gets literal argument arrays and bounded application context', () => {
  const root = 'G:\\a project\\sensor & pins';
  const args = codexArguments(root, 'planned wiring; physical voltage unknown');
  assert.deepEqual(args.slice(0, 2), ['-C', root]); assert.match(args[2], /physical voltage unknown/);
  assert.throws(() => codexArguments(root, 'x'.repeat(24577)), { code: 'INVALID_REQUEST' });
});
