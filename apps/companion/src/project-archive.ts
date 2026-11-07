import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ProjectFiles, type SourceFile } from '@robotics-workbench/application';
import { canonicalJson, checkArtifactCredentials, WorkbenchStore } from '@robotics-workbench/persistence';
import { isRequestId, WorkbenchError } from '@robotics-workbench/contracts';

type InventoryFile = Pick<SourceFile, 'path' | 'sha256' | 'sizeBytes'>;
type Archive = { schemaVersion: 1; projectId: string; projectRoot: string; projectRevision: number; manifestSha256: string; sourceSnapshotId: string; sourceSha256: string; snapshotSequence: number; operationalManifestSha256: string; files: InventoryFile[] };
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fail = (code: string, message: string): never => { throw new WorkbenchError(code, message); };
const inside = (root: string, child: string) => { const path = relative(root, child); return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)); };
function emptyDestination(path: string): void {
  if (!isAbsolute(path) || /^\\\\|^\/\//.test(path)) fail('UNAUTHORIZED_SCOPE', 'Archive destinations require absolute local directories.');
  let ancestor = resolve(path);
  while (!existsSync(ancestor)) { const parent = dirname(ancestor); if (parent === ancestor) fail('TOOL_UNAVAILABLE', 'The selected local archive drive is unavailable.'); ancestor = parent; }
  if (lstatSync(ancestor).isSymbolicLink() || realpathSync(ancestor).toLowerCase() !== resolve(ancestor).toLowerCase()) fail('UNAUTHORIZED_SCOPE', 'Archive destinations cannot traverse links or junctions.');
  if (existsSync(path) && (!statSync(path).isDirectory() || readdirSync(path).length)) fail('REVISION_CONFLICT', 'Archive destination must be empty; existing files were preserved.');
}
function referenced(files: ProjectFiles): string[] {
  const manifest = files.inspectManifest().manifest;
  const excluded = /^(?:\.git|node_modules|\.robotics-workbench|\.codex|\.opencode|\.claude|\.aws|\.ssh|\.azure|\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx)|auth\.json|credentials(?:\..*)?)$/i;
  for (const path of [...manifest.sketches.map(item => item.path), ...manifest.codeBindings.map(item => item.path), ...manifest.documents.map(item => item.path)]) {
    if (path.split('/').some(part => excluded.test(part))) fail('UNAUTHORIZED_SCOPE', 'A referenced project path is private and cannot enter an archive.');
    files.resolvePath(path);
  }
  const paths: string[] = [];
  const walk = (path: string) => {
    if (path !== '.' && excluded.test(path.split('/').at(-1)!)) return;
    const full = files.resolvePath(path);
    if (statSync(full).isDirectory()) for (const name of readdirSync(full)) walk(path === '.' ? name : `${path}/${name}`);
    else { paths.push(path); if (paths.length > 10000) fail('INVALID_REQUEST', 'Project archive exceeds its 10,000-file bound.'); }
  };
  walk('.');
  return paths;
}
function boundFiles(files: ProjectFiles, paths: string[]): void {
  const seen = new Set<string>(); let total = 0;
  const walk = (path: string) => {
    const full = files.resolvePath(path); const info = statSync(full);
    if (info.isDirectory()) { for (const name of readdirSync(full)) if (!['.git', 'node_modules', '.robotics-workbench'].includes(name)) walk(path === '.' ? name : `${path}/${name}`); }
    else if (!seen.has(path)) {
      seen.add(path); total += info.size;
      if (!info.isFile() || info.size > 64 * 1024 * 1024 || total > 256 * 1024 * 1024 || seen.size > 10000) fail('INVALID_REQUEST', 'Project archive exceeds its 10,000-file, 64 MiB/file or 256 MiB total bound.');
    }
  };
  for (const path of paths) walk(path);
}
function inventory(files: SourceFile[]): InventoryFile[] { return files.map(({ bytes, ...item }) => item); }
function writeFiles(root: string, files: SourceFile[]): void {
  mkdirSync(root, { recursive: true }); const scope = new ProjectFiles(root);
  for (const file of files) { const path = scope.resolvePath(file.path, true); mkdirSync(dirname(path), { recursive: true }); writeFileSync(scope.resolvePath(file.path, true), file.bytes, { flag: 'wx' }); }
}
function removeStage(path: string): void {
  if (!existsSync(path)) return;
  if (lstatSync(path).isSymbolicLink() || realpathSync(path).toLowerCase() !== resolve(path).toLowerCase()) fail('UNAUTHORIZED_SCOPE', 'Restore staging changed; its files were preserved.');
  rmSync(path, { recursive: true, force: true, maxRetries: 3 });
}

export function exportProject(files: ProjectFiles, store: WorkbenchStore, destination: string, host: () => { dirtyPaths: string[] }): Archive {
  emptyDestination(destination);
  if (inside(files.root, resolve(destination)) || inside(store.dataRoot, resolve(destination))) fail('UNAUTHORIZED_SCOPE', 'Keep the archive outside project and operational storage.');
  const current = files.inspectManifest(); const project = store.getProject(current.manifest.projectId);
  // shortcut: v1 exports a single-project operational database; filter snapshots before supporting shared-history exports.
  if (store.listProjects().length !== 1) fail('UNAUTHORIZED_SCOPE', 'This archive version requires a dedicated single-project operational database.');
  if (store.listOperations(project.projectId).some(item => ['queued', 'running', 'awaiting-input'].includes(item.status))) fail('DEVICE_BUSY', 'Finalize active captures and finish or cancel pending operations before exporting.');
  if (project.root !== files.root || project.manifestSha256 !== current.sha256 || project.projectRevision !== current.manifest.projectRevision) fail('REVISION_CONFLICT', 'Refresh the accepted project snapshot before exporting.');
  const paths = referenced(files); boundFiles(files, paths);
  const snapshot = files.snapshotSource({ paths, host });
  for (const file of snapshot.files) checkArtifactCredentials(file.bytes);
  if (canonicalJson(referenced(files).sort()) !== canonicalJson(snapshot.files.map(file => file.path))) fail('REVISION_CONFLICT', 'The project file inventory changed during export; retry after reconciliation.');
  if (files.inspectManifest().sha256 !== current.sha256) fail('REVISION_CONFLICT', 'Manifest changed during export; retry after reconciliation.');
  mkdirSync(dirname(destination), { recursive: true });
  const stage = mkdtempSync(join(dirname(destination), '.workbench-export-'));
  try {
    const backup = store.backup(join(stage, 'operational'));
    writeFiles(join(stage, 'project'), snapshot.files);
    const archive: Archive = { schemaVersion: 1, projectId: project.projectId, projectRoot: files.root, projectRevision: project.projectRevision, manifestSha256: current.sha256,
      sourceSnapshotId: snapshot.sourceSnapshotId, sourceSha256: snapshot.sha256, snapshotSequence: backup.snapshotSequence,
      operationalManifestSha256: hash(readFileSync(join(stage, 'operational', 'backup.json'))), files: inventory(snapshot.files) };
    writeFileSync(join(stage, 'archive.json'), canonicalJson(archive), { flag: 'wx' });
    emptyDestination(destination);
    if (existsSync(destination)) rmdirSync(destination);
    renameSync(stage, destination);
    return archive;
  } finally { removeStage(stage); }
}

export function restoreProject(archiveDirectory: string, newProjectRoot: string, newDataRoot: string): { files: ProjectFiles; store: WorkbenchStore } {
  emptyDestination(newProjectRoot); emptyDestination(newDataRoot);
  if (inside(resolve(newProjectRoot), resolve(newDataRoot)) || inside(resolve(newDataRoot), resolve(newProjectRoot))) fail('UNAUTHORIZED_SCOPE', 'Project and operational destinations must be separate.');
  const archiveScope = new ProjectFiles(archiveDirectory);
  if (inside(archiveScope.root, resolve(newProjectRoot)) || inside(archiveScope.root, resolve(newDataRoot))) fail('UNAUTHORIZED_SCOPE', 'Restore outside the retained archive.');
  const metadataPath = archiveScope.resolvePath('archive.json');
  if (statSync(metadataPath).size > 1024 * 1024) fail('INVALID_REQUEST', 'Archive inventory exceeds 1 MiB.');
  let archive: Archive;
  try { archive = JSON.parse(readFileSync(metadataPath, 'utf8')) as Archive; canonicalJson(archive); } catch { return fail('INVALID_REQUEST', 'Invalid or excessively nested archive inventory.'); }
  if (!archive || archive.schemaVersion !== 1 || !isRequestId(archive.projectId) || !isRequestId(archive.sourceSnapshotId) || !isAbsolute(archive.projectRoot) || !Number.isSafeInteger(archive.projectRevision) || archive.projectRevision < 1 || !Number.isSafeInteger(archive.snapshotSequence) || archive.snapshotSequence < 0 || !Array.isArray(archive.files) || archive.files.length > 10000) fail('INVALID_REQUEST', 'Invalid archive identities or inventory.');
  for (const digest of [archive.manifestSha256, archive.sourceSha256, archive.operationalManifestSha256]) if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) fail('INVALID_REQUEST', 'Invalid archive digest.');
  const files = new ProjectFiles(archiveScope.resolvePath('project')); const current = files.inspectManifest();
  if (current.manifest.projectId !== archive.projectId || current.manifest.projectRevision !== archive.projectRevision || current.sha256 !== archive.manifestSha256) fail('ARTIFACT_MISMATCH', 'Archived manifest differs from its inventory.');
  let totalBytes = 0; const seen = new Set<string>();
  for (const file of archive.files) {
    if (!file || typeof file.path !== 'string' || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || file.sizeBytes > 64 * 1024 * 1024 || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) || seen.has(file.path.toLowerCase())) fail('INVALID_REQUEST', 'Invalid archived file metadata.');
    totalBytes += file.sizeBytes; seen.add(file.path.toLowerCase());
    if (totalBytes > 256 * 1024 * 1024) fail('INVALID_REQUEST', 'Project archive exceeds 256 MiB.');
  }
  for (const file of archive.files) {
    const path = files.resolvePath(file.path);
    if (statSync(path).size !== file.sizeBytes || hash(readFileSync(path)) !== file.sha256) fail('ARTIFACT_MISMATCH', 'Archived ordinary file failed checksum verification.');
  }
  const paths = referenced(files); boundFiles(files, paths);
  const snapshot = files.snapshotSource({ paths, host: () => ({ dirtyPaths: [] }) });
  if (snapshot.sha256 !== archive.sourceSha256 || canonicalJson(inventory(snapshot.files)) !== canonicalJson(archive.files)) fail('ARTIFACT_MISMATCH', 'Archive file inventory is incomplete or changed.');
  for (const file of snapshot.files) checkArtifactCredentials(file.bytes);
  const operational = archiveScope.resolvePath('operational');
  const operationalManifest = archiveScope.resolvePath('operational/backup.json');
  if (statSync(operationalManifest).size > 1024 * 1024) fail('INVALID_REQUEST', 'Operational archive inventory exceeds 1 MiB.');
  if (hash(readFileSync(operationalManifest)) !== archive.operationalManifestSha256) fail('ARTIFACT_MISMATCH', 'Operational archive inventory changed.');
  for (const root of [newProjectRoot, newDataRoot]) mkdirSync(dirname(root), { recursive: true });
  const projectStage = mkdtempSync(join(dirname(newProjectRoot), '.workbench-project-restore-'));
  const dataStage = mkdtempSync(join(dirname(newDataRoot), '.workbench-data-restore-'));
  let stagedStore: WorkbenchStore | undefined;
  try {
    stagedStore = WorkbenchStore.restore(operational, dataStage);
    const projects = stagedStore.listProjects();
    if (projects.length !== 1 || projects[0].projectId !== archive.projectId || projects[0].root !== archive.projectRoot || projects[0].projectRevision !== archive.projectRevision || projects[0].manifestSha256 !== archive.manifestSha256 || stagedStore.snapshotWatermark() !== archive.snapshotSequence) fail('ARTIFACT_MISMATCH', 'Operational snapshot does not match the archived project.');
    writeFiles(projectStage, snapshot.files);
    stagedStore.reconcileOperations();
  } catch (error) {
    stagedStore?.close(); stagedStore = undefined;
    removeStage(projectStage); removeStage(dataStage);
    throw error;
  } finally { stagedStore?.close(); }
  let projectPublished = false, dataPublished = false;
  try {
    for (const root of [newProjectRoot, newDataRoot]) { emptyDestination(root); if (existsSync(root)) rmdirSync(root); }
    renameSync(projectStage, newProjectRoot); projectPublished = true;
    renameSync(dataStage, newDataRoot); dataPublished = true;
    const store = new WorkbenchStore(newDataRoot);
    try {
      store.relocateProject(archive.projectId, newProjectRoot, archive.projectRoot);
      store.putRecord('observations', randomUUID(), archive.projectId, { kind: 'project-restore', previousRoot: archive.projectRoot, root: store.getProject(archive.projectId).root,
        archiveManifestSha256: archive.manifestSha256, sourceSha256: archive.sourceSha256, restoredAt: new Date().toISOString() });
      return { files: new ProjectFiles(newProjectRoot), store };
    }
    catch (error) { store.close(); throw error; }
  } catch {
    // A project and its evidence may be on different volumes; retain both staged copies if publishing either directory fails.
    if (dataPublished) { try { renameSync(newDataRoot, dataStage); dataPublished = false; } catch {} }
    if (projectPublished) { try { renameSync(newProjectRoot, projectStage); projectPublished = false; } catch {} }
    const projectPath = projectPublished ? newProjectRoot : projectStage, dataPath = dataPublished ? newDataRoot : dataStage;
    throw new WorkbenchError('RESTORE_INCOMPLETE', `Restore could not publish both directories. Inspect retained project ${projectPath} and evidence ${dataPath} before retrying.`, {
      projectPath, dataPath,
    });
  }
}
