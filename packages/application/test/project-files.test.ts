import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectFiles, type HostDocumentState } from '../src/index';

const fixture = () => ({
  schemaVersion: 1 as const, projectId: '11111111-1111-4111-8111-111111111111', projectRevision: 1,
  name: 'Preserved sketch', sketches: [{ path: 'RangeSensor', targetId: '44444444-4444-4444-8444-444444444444' }],
  targets: [{ targetId: '44444444-4444-4444-8444-444444444444', fqbn: 'arduino:avr:uno', options: {} }],
  components: [], nets: [], codeBindings: [], documents: [], extensions: { user: { retained: true } }
});

function project(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'workbench-files-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'RangeSensor'));
  writeFileSync(join(root, 'workbench.json'), JSON.stringify(fixture()));
  writeFileSync(join(root, 'RangeSensor', 'RangeSensor.ino'), 'void setup() {}\nvoid loop() {}\n');
  return { root, files: new ProjectFiles(root) };
}

test('manifest edits advance accepted revision, retain extension metadata, and leave source unchanged', t => {
  const { root, files } = project(t);
  const before = files.inspectManifest();
  const source = readFileSync(join(root, 'RangeSensor', 'RangeSensor.ino'));
  const next = { ...before.manifest, name: 'Renamed', extensions: {} };
  const result = files.updateManifest({ expectedProjectRevision: 1, expectedSha256: before.sha256, next,
    host: () => ({ documentVersion: 3, dirty: false }), expectedDocumentVersion: 3 });
  assert.equal(result.manifest.projectRevision, 2);
  assert.deepEqual(result.manifest.extensions, before.manifest.extensions);
  assert.deepEqual(readFileSync(join(root, 'RangeSensor', 'RangeSensor.ino')), source);
  const recovery = join(root, '.robotics-workbench', 'recovery', readdirSync(join(root, '.robotics-workbench', 'recovery'))[0]);
  assert.equal(readFileSync(join(recovery, 'previous.json'), 'utf8'), before.text);
  assert.equal(readFileSync(join(recovery, 'proposed.json'), 'utf8'), result.text);
});

test('invalid manual JSON survives inspection and failed mutation', t => {
  const { root, files } = project(t);
  writeFileSync(join(root, 'workbench.json'), '{ "user is typing": ');
  assert.throws(() => files.inspectManifest(), { code: 'INVALID_REQUEST' });
  assert.equal(readFileSync(join(root, 'workbench.json'), 'utf8'), '{ "user is typing": ');
});

test('oversized manifest and source files are rejected before materializing their bytes', t => {
  const { root, files } = project(t);
  const manifest = join(root, 'workbench.json');
  truncateSync(manifest, 128 * 1024 * 1024);
  assert.throws(() => files.inspectManifest(), { code: 'INVALID_REQUEST' });
  assert.equal(statSync(manifest).size, 128 * 1024 * 1024);
  const source = join(root, 'RangeSensor', 'RangeSensor.ino');
  truncateSync(source, 64 * 1024 * 1024 + 1);
  assert.throws(() => files.snapshotSource({ paths: ['RangeSensor'], host: () => ({ dirtyPaths: [] }) }), { code: 'INVALID_REQUEST' });
  assert.equal(statSync(source).size, 64 * 1024 * 1024 + 1);
});

test('revision, content identity, dirty buffer and document version conflicts preserve current bytes', t => {
  const { root, files } = project(t);
  const initial = files.inspectManifest();
  const base = { expectedProjectRevision: 1, expectedSha256: initial.sha256, next: { ...initial.manifest, name: 'Agent proposal' },
    host: () => ({ documentVersion: 1, dirty: false }), expectedDocumentVersion: 1 };
  for (const changed of [{ expectedProjectRevision: 2 }, { expectedSha256: '0'.repeat(64) },
    { host: () => ({ documentVersion: 2, dirty: false }) }, { host: () => ({ documentVersion: 1, dirty: true }) }]) {
    assert.throws(() => files.updateManifest({ ...base, ...changed }), { code: 'REVISION_CONFLICT' });
    assert.equal(readFileSync(join(root, 'workbench.json'), 'utf8'), initial.text);
  }
});

test('external change during commit preserves the provider proposal and user file', t => {
  const { root, files } = project(t);
  const before = files.inspectManifest();
  const external = JSON.stringify({ ...before.manifest, name: 'External user edit' });
  assert.throws(() => files.updateManifest({ expectedProjectRevision: 1, expectedSha256: before.sha256,
    next: { ...before.manifest, name: 'Agent edit' }, host: () => ({ documentVersion: 1, dirty: false }), expectedDocumentVersion: 1,
    beforeCommit: () => writeFileSync(join(root, 'workbench.json'), external) }), { code: 'REVISION_CONFLICT' });
  assert.equal(readFileSync(join(root, 'workbench.json'), 'utf8'), external);
  const recovery = join(root, '.robotics-workbench', 'recovery', readdirSync(join(root, '.robotics-workbench', 'recovery'))[0]);
  assert.equal(JSON.parse(readFileSync(join(recovery, 'proposed.json'), 'utf8')).name, 'Agent edit');
});

test('host becoming dirty before commit preserves disk and unsaved version without publishing proposal', t => {
  const { root, files } = project(t);
  const before = files.inspectManifest();
  let host: HostDocumentState = { documentVersion: 1, dirty: false };
  assert.throws(() => files.updateManifest({ expectedProjectRevision: 1, expectedSha256: before.sha256,
    next: { ...before.manifest, name: 'Agent edit' }, host: () => host, expectedDocumentVersion: 1,
    beforeCommit: () => { host = { documentVersion: 2, dirty: true }; } }), { code: 'REVISION_CONFLICT' });
  assert.equal(readFileSync(join(root, 'workbench.json'), 'utf8'), before.text);
  assert.deepEqual(host, { documentVersion: 2, dirty: true });
});

test('Windows alternate paths, traversal, aliases and junction escapes fail scope checks', t => {
  const { root, files } = project(t);
  for (const path of ['../escape', '/absolute', 'C:/outside', 'C:relative', '\\\\server\\share', '//server/share', '\\\\?\\C:\\outside',
    'RangeSensor/../workbench.json', 'RangeSensor\\RangeSensor.ino', 'workbench.json:stream', './workbench.json', 'workbench.json.', 'NUL', 'COM1.txt', 'workbench.json ']) {
    assert.throws(() => files.resolvePath(path, true), { code: 'UNAUTHORIZED_SCOPE' }, path);
  }
  const outside = mkdtempSync(join(tmpdir(), 'workbench-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'private.ino'), 'outside');
  symlinkSync(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => files.resolvePath('escape/private.ino'), { code: 'UNAUTHORIZED_SCOPE' });
  assert.throws(() => files.resolvePath('escape/new.ino', true), { code: 'UNAUTHORIZED_SCOPE' });
});

test('source inventory is deterministic, includes local-library bytes and changes when a library changes', t => {
  const { root, files } = project(t);
  const library = mkdtempSync(join(tmpdir(), 'workbench-library-'));
  t.after(() => rmSync(library, { recursive: true, force: true }));
  mkdirSync(join(library, 'src'));
  writeFileSync(join(library, 'src', 'driver.h'), '#define LIMIT 1\n');
  writeFileSync(join(root, 'RangeSensor', 'z.h'), '#define Z 1\n');
  const options = { paths: ['RangeSensor'], host: () => ({ dirtyPaths: [] }), libraryRoots: [{ id: 'driver', root: library, paths: ['src'] }] };
  const a = files.snapshotSource(options);
  const b = files.snapshotSource(options);
  assert.equal(a.sha256, b.sha256);
  assert.notEqual(a.sourceSnapshotId, b.sourceSnapshotId);
  assert.deepEqual(a.files.map(file => file.path), ['RangeSensor/RangeSensor.ino', 'RangeSensor/z.h']);
  assert.equal(a.libraries[0].files[0].bytes.toString(), '#define LIMIT 1\n');
  writeFileSync(join(library, 'src', 'driver.h'), '#define LIMIT 2\n');
  assert.notEqual(files.snapshotSource(options).sha256, a.sha256);
});

test('dirty and unstable source cannot become an immutable snapshot; secret filenames are excluded', t => {
  const { root, files } = project(t);
  assert.throws(() => files.snapshotSource({ paths: ['RangeSensor'], host: () => ({ dirtyPaths: ['RangeSensor/RangeSensor.ino'] }) }), { code: 'REVISION_CONFLICT' });
  assert.throws(() => files.snapshotSource({ paths: ['RangeSensor'], host: () => ({ dirtyPaths: [] }),
    afterRead: path => writeFileSync(join(root, path), 'changed while hashing') }), { code: 'REVISION_CONFLICT' });
  writeFileSync(join(root, 'RangeSensor', '.env'), 'PLANTED_SECRET=do-not-copy');
  const result = files.snapshotSource({ paths: ['RangeSensor'], host: () => ({ dirtyPaths: [] }) });
  assert.equal(result.files.some(file => file.path.endsWith('.env')), false);
  assert.throws(() => files.snapshotSource({ paths: ['RangeSensor/.env'], host: () => ({ dirtyPaths: [] }) }), { code: 'UNAUTHORIZED_SCOPE' });
});

test('source files added after enumeration invalidate the complete input inventory', t => {
  const { root, files } = project(t);
  assert.throws(() => files.snapshotSource({ paths: ['RangeSensor'], host: () => ({ dirtyPaths: [] }),
    afterRead: () => writeFileSync(join(root, 'RangeSensor', 'new-library.h'), '#define CHANGED_INPUTS 1') }), { code: 'REVISION_CONFLICT' });
});

test('layout lives in its own sidecar without changing manifest bytes or design revision', t => {
  const { root, files } = project(t);
  const before = files.inspectManifest();
  const first = files.writeLayout({ expectedSha256: null, positions: {} });
  const second = files.writeLayout({ expectedSha256: first.sha256, positions: {} });
  assert.equal(second.revision, 2);
  assert.equal(readFileSync(join(root, 'workbench.json'), 'utf8'), before.text);
  assert.equal(files.inspectManifest().manifest.projectRevision, 1);
  assert.throws(() => files.writeLayout({ expectedSha256: first.sha256, positions: {} }), { code: 'REVISION_CONFLICT' });
});
