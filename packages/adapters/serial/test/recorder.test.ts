import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { RawRecorder } from '../src/recorder';

function fixture(t: TestContext) {
  const base = resolve('artifacts/task09-recorder'); mkdirSync(base, { recursive: true }); const root = mkdtempSync(join(base, 'observer-'));
  t.after(() => { assert.ok(!relative(base, root).startsWith('..')); rmSync(root, { recursive: true, force: true }); });
  return { root, options: { projectId: randomUUID(), projectRevision: 1, deviceId: randomUUID() } };
}
test('raw observers run after every complete preserved write and cannot change recorded bytes/outcome', t => {
  const { root, options } = fixture(t); let recorder!: RawRecorder; const seen: string[] = []; let writes = 0;
  recorder = new RawRecorder(root, { ...options, io: { write(fd, bytes, offset, length) { writes++; return writeSync(fd, bytes, offset, Math.min(length, 17)); } },
    onRecord(record) {
      const path = join(recorder.directory, readdirSync(recorder.directory).find(path => path.endsWith('.partial.jsonl'))!);
      const rows = readFileSync(path, 'utf8').trimEnd().split('\n');
      assert.deepEqual(JSON.parse(rows.at(-1)!), record, 'The exact complete raw record is readable before display observes it.');
      seen.push(Buffer.from(record.bytesBase64, 'base64').toString());
      assert.equal(recorder.snapshot().rawBytes, seen.join('').length);
      record.bytesBase64 = Buffer.from('tampered').toString('base64'); throw new Error('Synthetic failed plot consumer');
    }, onGap(gap) { gap.cause = 'overflow'; throw new Error('Synthetic failed gap consumer'); } });
  assert.equal(recorder.receive(Buffer.from('one\n')), true); recorder.boundary('upload'); assert.equal(recorder.receive(Buffer.from('two\n')), true);
  const result = recorder.finish();
  assert.ok(writes > 2); assert.deepEqual(seen, ['one\n', 'two\n']); assert.equal(result.status, 'completed');
  assert.equal(result.rawSha256, createHash('sha256').update('one\ntwo\n').digest('hex'));
  assert.equal(result.gaps[0].cause, 'upload'); assert.equal(recorder.preview().omittedDisplayEvents, 3);
});
test('a failed raw write never delivers unpreserved bytes to a display observer', t => {
  const { root, options } = fixture(t); let writes = 0, records = 0;
  const recorder = new RawRecorder(root, { ...options, io: { write(fd, bytes, offset, length) { if (++writes > 1) throw new Error('Synthetic disk full'); return writeSync(fd, bytes, offset, length); } }, onRecord() { records++; } });
  recorder.receive(Buffer.from('kept\n')); assert.equal(recorder.receive(Buffer.from('lost\n')), false);
  assert.equal(records, 1); assert.equal(recorder.finish().status, 'failed'); assert.equal(recorder.snapshot().rawBytes, 5);
});
test('rejected asynchronous observers do not become unhandled failures or acquisition loss', async t => {
  const { root, options } = fixture(t);
  const recorder = new RawRecorder(root, { ...options, onRecord: async () => { throw new Error('Synthetic deferred display error'); } });
  recorder.receive(Buffer.from('still preserved\n')); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(recorder.preview().omittedDisplayEvents, 1); assert.equal(recorder.finish().status, 'completed');
});
