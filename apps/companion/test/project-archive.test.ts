import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectFiles } from '@robotics-workbench/application';
import { WorkbenchStore } from '@robotics-workbench/persistence';
import { type OperationReceipt } from '@robotics-workbench/contracts';
import { exportProject, restoreProject } from '../src/project-archive';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-archive-'));
  const root = join(directory, 'original-project'); mkdirSync(join(root, 'RangeSensor'), { recursive: true }); mkdirSync(join(root, 'docs'));
  const manifest = JSON.parse(readFileSync('examples/workbench.valid.json', 'utf8'));
  manifest.projectId = randomUUID();
  manifest.documents = [{ documentId: randomUUID(), path: 'docs/reference.txt', title: 'Source reference' }];
  writeFileSync(join(root, 'workbench.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(root, 'RangeSensor', 'RangeSensor.ino'), 'void setup() {}\nvoid loop() {}\n');
  writeFileSync(join(root, 'RangeSensor', 'pins.h'), '#define SENSOR_PIN 7\n');
  writeFileSync(join(root, 'docs', 'reference.txt'), 'Synthetic source document; no hardware observation.');
  const files = new ProjectFiles(root); const current = files.inspectManifest();
  const store = new WorkbenchStore(join(directory, 'original-data'));
  store.registerProject({ projectId: manifest.projectId, root: files.root, projectRevision: 1, manifestSha256: current.sha256 });
  const artifact = store.storeArtifact(manifest.projectId, Buffer.from('retained immutable evidence'), 'text/plain');
  const experimentId = randomUUID();
  store.putRecord('experiments', experimentId, manifest.projectId, { artifactIds: [artifact.artifactId], outcome: 'inconclusive' });
  return { directory, root, files, store, manifest, artifact, experimentId };
}

test('root-folder sketches archive without traversal aliases or losing manifest authority', () => {
  const { directory, root, files, store, manifest } = fixture();
  manifest.sketches[0].path = '.';
  manifest.projectRevision = 2;
  writeFileSync(join(root, 'workbench.json'), JSON.stringify(manifest));
  const current = files.inspectManifest(); store.updateProject(manifest.projectId, 2, current.sha256);
  try {
    const archive = exportProject(files, store, join(directory, 'root-export'), () => ({ dirtyPaths: [] }));
    assert.ok(archive.files.some(item => item.path === 'workbench.json'));
    assert.ok(archive.files.some(item => item.path === 'RangeSensor/RangeSensor.ino'));
    assert.ok(archive.files.every(item => !item.path.startsWith('./')));
  } finally { store.close(); }
});

test('ordinary project and evidence restore with stable identities after originals move away', () => {
  const { directory, root, files, store, manifest, artifact, experimentId } = fixture();
  const archivePath = join(directory, 'export');
  const archive = exportProject(files, store, archivePath, () => ({ dirtyPaths: [] }));
  assert.deepEqual(archive.files.map(file => file.path), ['RangeSensor/RangeSensor.ino', 'RangeSensor/pins.h', 'docs/reference.txt', 'workbench.json']);
  for (const file of archive.files) assert.equal(hash(readFileSync(join(root, file.path))), file.sha256);
  const epoch = store.epoch; const oldDataRoot = store.dataRoot; store.close();
  renameSync(root, `${root}-unavailable`); renameSync(oldDataRoot, `${oldDataRoot}-unavailable`);
  const restored = restoreProject(archivePath, join(directory, 'restored-project'), join(directory, 'restored-data'));
  try {
    assert.equal(restored.files.inspectManifest().manifest.projectId, manifest.projectId);
    assert.equal(restored.store.getProject(manifest.projectId).root, restored.files.root);
    assert.notEqual(restored.store.epoch, epoch);
    assert.deepEqual(restored.store.getRecord('experiments', experimentId, manifest.projectId), { artifactIds: [artifact.artifactId], outcome: 'inconclusive' });
    assert.equal(restored.store.readArtifact(manifest.projectId, artifact.artifactId).toString(), 'retained immutable evidence');
    for (const file of archive.files) assert.equal(hash(readFileSync(restored.files.resolvePath(file.path))), file.sha256);
  } finally { restored.store.close(); }
});

test('export requires clean host state and refuses recognizable secrets or unrelated project history', () => {
  const { directory, root, files, store } = fixture();
  assert.throws(() => exportProject(files, store, join(directory, 'dirty-export'), () => ({ dirtyPaths: ['RangeSensor/RangeSensor.ino'] })), { code: 'REVISION_CONFLICT' });
  assert.equal(existsSync(join(directory, 'dirty-export')), false);
  writeFileSync(join(root, 'RangeSensor', 'pins.h'), 'const char *API_KEY = "planted-secret-123456789";');
  assert.throws(() => exportProject(files, store, join(directory, 'secret-export'), () => ({ dirtyPaths: [] })), { code: 'INVALID_REQUEST' });
  assert.equal(existsSync(join(directory, 'secret-export')), false);
  const otherRoot = join(directory, 'other-project'); mkdirSync(otherRoot);
  store.registerProject({ projectId: randomUUID(), root: otherRoot, projectRevision: 1, manifestSha256: hash('other') });
  assert.throws(() => exportProject(files, store, join(directory, 'multi-project-export'), () => ({ dirtyPaths: [] })), { code: 'UNAUTHORIZED_SCOPE' });
  assert.equal(existsSync(join(directory, 'multi-project-export')), false);
  store.close();
});

test('tampered bytes, traversal, secret archives and linked outputs leave named restore destinations untouched', () => {
  const { directory, files, store } = fixture();
  const archivePath = join(directory, 'export'); exportProject(files, store, archivePath, () => ({ dirtyPaths: [] }));
  const metadataPath = join(archivePath, 'archive.json'); const original = JSON.parse(readFileSync(metadataPath, 'utf8'));
  const sourcePath = join(archivePath, 'project', 'RangeSensor', 'pins.h'); const source = readFileSync(sourcePath);
  const projectDestination = join(directory, 'restored-project'); const dataDestination = join(directory, 'restored-data');
  mkdirSync(projectDestination); mkdirSync(dataDestination);
  const untouched = () => { assert.deepEqual(readdirSync(projectDestination), []); assert.deepEqual(readdirSync(dataDestination), []); };
  writeFileSync(sourcePath, 'tampered bytes');
  assert.throws(() => restoreProject(archivePath, projectDestination, dataDestination), { code: 'ARTIFACT_MISMATCH' }); untouched();
  writeFileSync(sourcePath, source);
  writeFileSync(metadataPath, JSON.stringify({ ...original, files: [{ ...original.files[0], path: '../outside' }, ...original.files.slice(1)] }));
  assert.throws(() => restoreProject(archivePath, projectDestination, dataDestination), { code: 'UNAUTHORIZED_SCOPE' }); untouched();
  writeFileSync(sourcePath, 'const char *password = "planted-password-123456789";');
  const changedFiles = new ProjectFiles(join(archivePath, 'project'));
  const snapshot = changedFiles.snapshotSource({ paths: ['workbench.json', 'RangeSensor', 'docs/reference.txt'], host: () => ({ dirtyPaths: [] }) });
  writeFileSync(metadataPath, JSON.stringify({ ...original, sourceSha256: snapshot.sha256, files: snapshot.files.map(({ bytes, ...file }) => file) }));
  assert.throws(() => restoreProject(archivePath, projectDestination, dataDestination), { code: 'INVALID_REQUEST' }); untouched();
  writeFileSync(sourcePath, source); writeFileSync(metadataPath, JSON.stringify(original));
  const linked = join(directory, 'linked-project'); symlinkSync(projectDestination, linked, 'junction');
  assert.throws(() => restoreProject(archivePath, linked, dataDestination), { code: 'UNAUTHORIZED_SCOPE' }); untouched();
  writeFileSync(join(archivePath, 'operational', 'backup.json'), ' '.repeat(1024 * 1024 + 1));
  assert.throws(() => restoreProject(archivePath, projectDestination, dataDestination), { code: 'INVALID_REQUEST' }); untouched();
  store.close();
});

test('full project export restores engineering sources while excluding private files and caches', () => {
  const { directory, root, files, store } = fixture();
  const ordinary = ['components/catalog.json', 'telemetry/parsers.json', 'experiments/procedures.json', 'mechanical/box.py', 'mechanical/environment.lock.json', 'schematic/bench.kicad_sch'];
  for (const path of ordinary) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), `synthetic ${path}`); }
  for (const path of ['.env', 'mechanical/auth.json', '.git/config', 'node_modules/module.js', '.codex/history.jsonl', 'mechanical/.opencode/private.json']) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), 'private excluded fixture'); }
  try {
    const archivePath = join(directory, 'full-export');
    const archive = exportProject(files, store, archivePath, () => ({ dirtyPaths: [] }));
    for (const path of ordinary) assert.ok(archive.files.some(file => file.path === path), `${path} must survive restore`);
    assert.ok(archive.files.every(file => !/(?:^|\/)(?:\.env|auth\.json|\.git|node_modules|\.codex|\.opencode)(?:\/|$)/.test(file.path)));
    const restored = restoreProject(archivePath, join(directory, 'full-project'), join(directory, 'full-data'));
    try { for (const path of ordinary) assert.equal(readFileSync(restored.files.resolvePath(path), 'utf8'), `synthetic ${path}`); }
    finally { restored.store.close(); }
  } finally { store.close(); }
});

test('active operation and backup failure publish no partial archive', t => {
  const { directory, files, store, manifest } = fixture();
  const receipt = JSON.parse(readFileSync('examples/operation.valid.json', 'utf8')) as OperationReceipt;
  Object.assign(receipt, { projectId: manifest.projectId, expectedProjectRevision: 1, status: 'queued' });
  delete receipt.startedAt; delete receipt.finishedAt; delete receipt.error;
  store.createOperation(receipt, { synthetic: true });
  const destination = join(directory, 'active-export');
  try {
    assert.throws(() => exportProject(files, store, destination, () => ({ dirtyPaths: [] })), { code: 'DEVICE_BUSY' });
    assert.equal(existsSync(destination), false);
    store.transitionOperation(manifest.projectId, receipt.operationId, 'cancelled');
    mkdirSync(destination);
    t.mock.method(store, 'backup', () => { throw new Error('synthetic disk full during backup'); });
    assert.throws(() => exportProject(files, store, destination, () => ({ dirtyPaths: [] })), /synthetic disk full/);
    assert.deepEqual(readdirSync(destination), []);
    assert.ok(readdirSync(directory).every(name => !name.startsWith('.workbench-export-')));
  } finally { store.close(); }
});

test('second-directory publication failure retains both complete restore stages and existing files', t => {
  const { directory, files, store, artifact, manifest } = fixture();
  const archivePath = join(directory, 'export');
  exportProject(files, store, archivePath, () => ({ dirtyPaths: [] }));
  const projectDestination = join(directory, 'published-project'), dataDestination = join(directory, 'published-data');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (to === dataDestination) throw new Error('synthetic second-volume publication failure');
    return rename(from, to);
  });
  try {
    assert.throws(() => restoreProject(archivePath, projectDestination, dataDestination), { code: 'RESTORE_INCOMPLETE' });
    assert.equal(existsSync(projectDestination), false);
    assert.equal(existsSync(dataDestination), false);
    const projectStage = readdirSync(directory).find(name => name.startsWith('.workbench-project-restore-'))!;
    const dataStage = readdirSync(directory).find(name => name.startsWith('.workbench-data-restore-'))!;
    assert.equal(readFileSync(join(directory, projectStage, 'workbench.json'), 'utf8'), readFileSync(files.resolvePath('workbench.json'), 'utf8'));
    const staged = new WorkbenchStore(join(directory, dataStage));
    try { assert.equal(staged.readArtifact(manifest.projectId, artifact.artifactId).toString(), 'retained immutable evidence'); }
    finally { staged.close(); }
    assert.ok(existsSync(join(archivePath, 'archive.json')));
  } finally { store.close(); }
});

test('legacy unfinished operations restore as unknown without replay and retain immutable relocation provenance', () => {
  const { directory, root, files, store, manifest } = fixture();
  const archivePath = join(directory, 'legacy-export'); exportProject(files, store, archivePath, () => ({ dirtyPaths: [] }));
  const receipt = JSON.parse(readFileSync('examples/operation.valid.json', 'utf8')) as OperationReceipt;
  Object.assign(receipt, { projectId: manifest.projectId, expectedProjectRevision: 1, status: 'queued' });
  delete receipt.startedAt; delete receipt.finishedAt; delete receipt.error;
  store.createOperation(receipt, { synthetic: true }); store.transitionOperation(manifest.projectId, receipt.operationId, 'running');
  const backupPath = join(directory, 'legacy-operational'); const backup = store.backup(backupPath);
  for (const file of ['workbench.sqlite', 'backup.json']) copyFileSync(join(backupPath, file), join(archivePath, 'operational', file));
  const metadataPath = join(archivePath, 'archive.json'), metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  writeFileSync(metadataPath, JSON.stringify({ ...metadata, snapshotSequence: backup.snapshotSequence, operationalManifestSha256: hash(readFileSync(join(backupPath, 'backup.json'))) }));
  try {
    const restored = restoreProject(archivePath, join(directory, 'legacy-project'), join(directory, 'legacy-data'));
    try {
      assert.equal(restored.store.listOperations(manifest.projectId).length, 1);
      assert.equal(restored.store.listOperations(manifest.projectId)[0].status, 'outcome-unknown');
      assert.deepEqual(restored.store.reconcileOperations(), []);
      const [origin] = restored.store.listRecords<{ kind: string; previousRoot: string; root: string; archiveManifestSha256: string }>('observations', manifest.projectId);
      assert.equal(origin.kind, 'project-restore'); assert.equal(origin.previousRoot, root); assert.equal(origin.root, restored.files.root);
      assert.equal(origin.archiveManifestSha256, files.inspectManifest().sha256);
    } finally { restored.store.close(); }
  } finally { store.close(); }
});

test('operational project mismatch cleans only owned stages and leaves selected empty destinations intact', () => {
  const { directory, files, store } = fixture();
  const archivePath = join(directory, 'mismatch-export'); exportProject(files, store, archivePath, () => ({ dirtyPaths: [] }));
  const metadataPath = join(archivePath, 'archive.json'), metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  writeFileSync(metadataPath, JSON.stringify({ ...metadata, projectRoot: join(directory, 'wrong-original-root') }));
  const projectDestination = join(directory, 'mismatch-project'), dataDestination = join(directory, 'mismatch-data'); mkdirSync(projectDestination); mkdirSync(dataDestination);
  try {
    assert.throws(() => restoreProject(archivePath, projectDestination, dataDestination), { code: 'ARTIFACT_MISMATCH' });
    assert.deepEqual(readdirSync(projectDestination), []); assert.deepEqual(readdirSync(dataDestination), []);
    assert.ok(readdirSync(directory).every(name => !name.startsWith('.workbench-project-restore-') && !name.startsWith('.workbench-data-restore-')));
  } finally { store.close(); }
});

test('a new ordinary file during snapshot invalidates a full export instead of silently omitting it', () => {
  const { directory, root, files, store } = fixture();
  const destination = join(directory, 'racing-export'); let calls = 0;
  try {
    assert.throws(() => exportProject(files, store, destination, () => {
      if (calls++ === 0) writeFileSync(join(root, 'RangeSensor', 'new-provider-input.h'), '// concurrent provider input preserved');
      return { dirtyPaths: [] };
    }), { code: 'REVISION_CONFLICT' });
    assert.equal(existsSync(destination), false);
    assert.equal(readFileSync(join(root, 'RangeSensor', 'new-provider-input.h'), 'utf8'), '// concurrent provider input preserved');
  } finally { store.close(); }
});
