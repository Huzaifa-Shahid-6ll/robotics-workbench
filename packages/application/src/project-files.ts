import { createHash, randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { WorkbenchError, validateManifest, type WorkbenchManifest } from '@robotics-workbench/contracts';
import { assertManifestSemantics, assertRevision } from '@robotics-workbench/domain';

export type ManifestSnapshot = { manifest: WorkbenchManifest; sha256: string; text: string };
export type HostDocumentState = { documentVersion: number; dirty: boolean };
export type SourceFile = { path: string; sha256: string; sizeBytes: number; bytes: Buffer };
export type SourceSnapshot = {
  sourceSnapshotId: string;
  sha256: string;
  files: SourceFile[];
  libraries: { id: string; sha256: string; files: SourceFile[] }[];
};
export type SnapshotSourceOptions = {
  paths: string[];
  host: () => { dirtyPaths: string[] };
  libraryRoots?: { id: string; root: string; paths: string[] }[];
  afterRead?: (path: string) => void;
};
export type UpdateManifestOptions = {
  expectedProjectRevision: number;
  expectedSha256: string;
  next: WorkbenchManifest;
  host: () => HostDocumentState;
  expectedDocumentVersion: number;
  beforeCommit?: () => void;
};

const hash = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const privateName = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx)|auth\.json|credentials(?:\..*)?)$/i;
const reservedName = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;
const documentLimit = 1024 * 1024;
// shortcut: snapshots retain bytes in memory up to 64 MiB/file and 256 MiB total; stream artifact ingestion before supporting larger projects.
const sourceFileLimit = 64 * 1024 * 1024;
const sourceTotalLimit = 256 * 1024 * 1024;

function fail(code: string, message: string, details?: Record<string, unknown>): never {
  throw new WorkbenchError(code, message, details);
}

function portablePath(value: string): void {
  if (typeof value !== 'string' || !value || value.includes('\\') || /[:<>"|?*\x00-\x1f\x7f]/.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || reservedName.test(part))) {
    fail('UNAUTHORIZED_SCOPE', 'Use a normalized project-relative path without traversal or Windows device syntax.');
  }
}

function rootPath(root: string): string {
  if (!isAbsolute(root) || root.startsWith('\\\\') || root.startsWith('//')) fail('UNAUTHORIZED_SCOPE', 'An absolute local project root is required.');
  const canonical = realpathSync(root);
  if (!statSync(canonical).isDirectory()) fail('INVALID_REQUEST', 'The project root is not a directory.');
  return canonical;
}

function inside(root: string, path: string): boolean {
  const result = relative(root, path);
  return result === '' || (!isAbsolute(result) && result !== '..' && !result.startsWith(`..${sep}`));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => compare(a, b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

function writeNew(path: string, bytes: string | Buffer): void {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}

function readBounded(path: string, limit = documentLimit): Buffer {
  const fd = openSync(path, 'r');
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > limit) fail('INVALID_REQUEST', `File exceeds the ${limit}-byte read limit; choose smaller inputs. Its original bytes were preserved.`);
    const bytes = Buffer.allocUnsafe(info.size + 1);
    let length = 0;
    while (length < bytes.byteLength) {
      const count = readSync(fd, bytes, length, bytes.byteLength - length, null);
      if (!count) break;
      length += count;
    }
    if (length > limit) fail('INVALID_REQUEST', `File exceeds the ${limit}-byte read limit; its original bytes were preserved.`);
    if (length > info.size) fail('REVISION_CONFLICT', 'The file grew while being read; retry after saving.');
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}

export class ProjectFiles {
  readonly root: string;

  constructor(root: string) { this.root = rootPath(root); }

  resolvePath(path: string, allowMissing = false): string {
    if (path === '.') return this.root;
    portablePath(path);
    let current = this.root;
    for (const part of path.split('/')) {
      current = join(current, part);
      let info;
      try { info = lstatSync(current); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (allowMissing) continue;
        fail('NOT_FOUND', 'A referenced project path is missing.', { path });
      }
      if (info.isSymbolicLink()) fail('UNAUTHORIZED_SCOPE', 'Symbolic links and junctions are not permitted in scoped project paths.', { path });
      if (info.isFile() && info.nlink > 1) fail('UNAUTHORIZED_SCOPE', 'Multiply linked files require explicit reconciliation before scoped access.', { path });
      if (!inside(this.root, realpathSync(current))) fail('UNAUTHORIZED_SCOPE', 'The path escapes the authorized project root.', { path });
    }
    return current;
  }

  inspectManifest(): ManifestSnapshot {
    const text = readBounded(this.resolvePath('workbench.json')).toString('utf8');
    let value: unknown;
    try { value = JSON.parse(text); } catch { return fail('INVALID_REQUEST', 'workbench.json is invalid JSON; its original text has been preserved.'); }
    const manifest = validateManifest(value);
    assertManifestSemantics(manifest);
    return { manifest, text, sha256: hash(text) };
  }

  updateManifest(options: UpdateManifestOptions): ManifestSnapshot {
    const previous = this.inspectManifest();
    assertRevision(previous.manifest, options.expectedProjectRevision, options.expectedSha256, previous.sha256);
    this.checkHost(options.host, options.expectedDocumentVersion);
    if (options.next.projectId !== previous.manifest.projectId) fail('REVISION_CONFLICT', 'A manifest edit cannot replace the project identity.');
    const manifest = validateManifest({ ...options.next, projectRevision: previous.manifest.projectRevision,
      extensions: { ...previous.manifest.extensions, ...options.next.extensions } });
    assertManifestSemantics(manifest);
    if (canonicalJson(manifest) === canonicalJson(previous.manifest)) return previous;
    manifest.projectRevision += 1;
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    this.commit('workbench.json', previous.sha256, text, () => this.checkHost(options.host, options.expectedDocumentVersion), options.beforeCommit);
    return this.inspectManifest();
  }

  writeLayout(options: {
    expectedSha256: string | null;
    positions: Record<string, { x: number; y: number }>;
    beforeCommit?: () => void;
  }): { revision: number; sha256: string } {
    const manifest = this.inspectManifest().manifest;
    const ids = new Set(manifest.components.map(component => component.componentId));
    for (const [id, point] of Object.entries(options.positions)) {
      if (!ids.has(id) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) fail('INVALID_REQUEST', 'Layout positions require an existing component and finite coordinates.');
    }
    const path = this.resolvePath('.workbench-layout.json', true);
    const current = existsSync(path) ? readBounded(path).toString('utf8') : null;
    if ((current === null ? null : hash(current)) !== options.expectedSha256) fail('REVISION_CONFLICT', 'Layout changed; refresh before editing.');
    let revision = 1;
    if (current !== null) {
      let value: unknown;
      try { value = JSON.parse(current); } catch { return fail('INVALID_REQUEST', 'The layout sidecar contains invalid JSON and was preserved.'); }
      if (!value || typeof value !== 'object' || !('revision' in value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1) fail('INVALID_REQUEST', 'The layout sidecar revision is invalid.');
      revision = Number(value.revision) + 1;
    }
    const text = `${JSON.stringify({ schemaVersion: 1, revision, positions: options.positions }, null, 2)}\n`;
    this.commit('.workbench-layout.json', options.expectedSha256, text, () => {}, options.beforeCommit);
    return { revision, sha256: hash(text) };
  }

  snapshotSource(options: SnapshotSourceOptions): SourceSnapshot {
    const checkHost = () => {
      if (options.host().dirtyPaths.length) fail('REVISION_CONFLICT', 'Save all relevant dirty documents before creating a source snapshot.');
    };
    checkHost();
    if (!options.paths.length || (options.libraryRoots ?? []).some(library => !library.id || library.id.length > 256 || !library.paths.length)) fail('INVALID_REQUEST', 'A snapshot requires explicit source paths and bounded library identities.');
    const captures = [{ id: null, project: this, paths: options.paths }, ...(options.libraryRoots ?? []).map(library => ({ ...library, project: new ProjectFiles(library.root) }))];
    if (new Set(captures.map(capture => capture.id)).size !== captures.length) fail('INVALID_REQUEST', 'Library inventory IDs must be unique.');
    let total = 0;
    const results = captures.map(capture => ({ id: capture.id, project: capture.project,
      files: capture.project.collect(capture.paths).map(path => {
        const size = statSync(capture.project.resolvePath(path)).size;
        if (size > sourceTotalLimit - total) fail('INVALID_REQUEST', 'Source inputs exceed the 256 MiB snapshot limit; choose a smaller explicit input set.');
        const file = capture.project.readStable(path, options.afterRead);
        if (file.sizeBytes > sourceTotalLimit - total) fail('INVALID_REQUEST', 'Source inputs exceed the 256 MiB snapshot limit; choose a smaller explicit input set.');
        total += file.sizeBytes;
        return file;
      }) }));
    for (const [index, result] of results.entries()) {
      if (canonicalJson(result.project.collect(captures[index].paths)) !== canonicalJson(result.files.map(file => file.path))) fail('REVISION_CONFLICT', 'The source inventory changed during snapshot creation.');
      for (const file of result.files) {
        if (hash(readBounded(result.project.resolvePath(file.path), sourceFileLimit)) !== file.sha256) fail('REVISION_CONFLICT', 'Source changed during snapshot creation; retry after saving.', { path: file.path });
      }
    }
    checkHost();
    const inventoryHash = (files: SourceFile[]) => hash(canonicalJson(files.map(({ bytes, ...file }) => file)));
    const files = results[0].files;
    const libraries = results.slice(1).map(result => ({ id: result.id!, sha256: inventoryHash(result.files), files: result.files }));
    return { sourceSnapshotId: randomUUID(), files, libraries,
      sha256: hash(canonicalJson({ files: inventoryHash(files), libraries: libraries.map(({ files: ignored, ...library }) => library) })) };
  }

  private collect(paths: string[]): string[] {
    const result = new Set<string>();
    const walk = (path: string, explicit: boolean) => {
      const full = this.resolvePath(path);
      const name = path.split('/').at(-1)!;
      if (privateName.test(name)) {
        if (explicit) fail('UNAUTHORIZED_SCOPE', 'Credential-bearing files are excluded from snapshots.', { path });
        return;
      }
      const info = statSync(full);
      if (info.isDirectory()) {
        for (const entry of readdirSync(full).sort(compare)) {
          if (!['.git', '.robotics-workbench', 'node_modules', 'workbench.json', '.workbench-layout.json'].includes(entry)) walk(path === '.' ? entry : `${path}/${entry}`, false);
        }
      } else if (info.isFile()) result.add(path);
      else fail('UNAUTHORIZED_SCOPE', 'Only ordinary source files can be snapshotted.', { path });
    };
    for (const path of paths) walk(path, true);
    return [...result].sort(compare);
  }

  private readStable(path: string, afterRead?: (path: string) => void): SourceFile {
    const full = this.resolvePath(path);
    const before = statSync(full, { bigint: true });
    const bytes = readBounded(full, sourceFileLimit);
    afterRead?.(path);
    const after = statSync(this.resolvePath(path), { bigint: true });
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail('REVISION_CONFLICT', 'Source changed while it was being read.', { path });
    return { path, bytes, sha256: hash(bytes), sizeBytes: bytes.byteLength };
  }

  private checkHost(host: () => HostDocumentState, expected: number): void {
    const current = host();
    if (current.dirty || current.documentVersion !== expected) fail('REVISION_CONFLICT', 'The host document changed or has unsaved edits; preserve and reconcile both versions.');
  }

  private commit(path: string, expected: string | null, text: string, checkHost: () => void, beforeCommit?: () => void): void {
    if (Buffer.byteLength(text) > documentLimit) fail('INVALID_REQUEST', 'Document exceeds 1 MiB; reduce its contents before committing.');
    const destination = this.resolvePath(path, true);
    const recoveryRelative = `.robotics-workbench/recovery/${randomUUID()}`;
    const recovery = this.resolvePath(recoveryRelative, true);
    mkdirSync(recovery, { recursive: true });
    const proposal = join(recovery, 'proposed.json');
    const ready = join(recovery, 'ready.json');
    const displaced = join(recovery, 'previous.json');
    writeNew(proposal, text);
    copyFileSync(proposal, ready);
    const conflict = () => fail('REVISION_CONFLICT', 'The file changed during commit. Current and proposed versions were preserved for reconciliation.', { path, recoveryPath: recoveryRelative });
    beforeCommit?.();
    checkHost();
    const current = existsSync(destination) ? hash(readBounded(this.resolvePath(path))) : null;
    if (current !== expected) return conflict();
    if (expected !== null) {
      renameSync(destination, displaced);
      let previousHash: string;
      try { previousHash = hash(readBounded(displaced)); } catch (error) {
        if (!existsSync(destination)) { try { linkSync(displaced, destination); } catch {} }
        throw error;
      }
      if (previousHash !== expected) {
        if (!existsSync(destination)) { try { linkSync(displaced, destination); } catch {} }
        return conflict();
      }
    }
    // Node has no cross-process compare-and-swap: never overwrite a newly created destination; retain both sides of a late external-write race.
    try { linkSync(ready, destination); } catch (error) {
      if (expected !== null && !existsSync(destination)) { try { linkSync(displaced, destination); } catch {} }
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return conflict();
      throw error;
    }
    unlinkSync(ready);
    checkHost();
    if (hash(readBounded(this.resolvePath(path))) !== hash(text) || (expected !== null && hash(readBounded(displaced)) !== expected)) return conflict();
  }
}
