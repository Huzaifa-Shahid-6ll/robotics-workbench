import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, copyFileSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  isProjectEvent, isRequestId, validateOperation, WorkbenchError,
  type OperationReceipt, type OperationStatus, type ProjectEvent,
} from '@robotics-workbench/contracts';
import { assertTransition } from '@robotics-workbench/domain';

export interface ProjectRecord {
  projectId: string;
  root: string;
  projectRevision: number;
  manifestSha256: string;
}
export interface ArtifactRecord {
  artifactId: string;
  projectId: string;
  sha256: string;
  sizeBytes: number;
  relativePath: string;
  mediaType: string;
  createdAt: string;
  operationId?: string;
}
export interface Migration { version: number; sql: string }
export type ArtifactCommitStep = 'temporary-created' | 'bytes-written' | 'finalized' | 'registered';
export type RecordTable = 'sessions' | 'source_snapshots' | 'builds' | 'uploads' | 'recordings' | 'experiments' | 'observations' | 'documents';
const originalRecordTables: RecordTable[] = ['sessions', 'source_snapshots', 'builds', 'uploads', 'recordings', 'experiments', 'observations'];
const recordTables: RecordTable[] = [...originalRecordTables, 'documents'];
const terminal = new Set<OperationStatus>(['succeeded', 'failed', 'cancelled', 'outcome-unknown']);
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const now = () => new Date().toISOString();
const digestPattern = /^[a-f0-9]{64}$/;
const schema = `
CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
CREATE TABLE projects(project_id TEXT PRIMARY KEY,root TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL CHECK(revision>0),manifest_sha256 TEXT NOT NULL) STRICT;
CREATE TABLE operations(operation_id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(project_id),request_id TEXT NOT NULL UNIQUE,payload_digest TEXT NOT NULL,receipt TEXT NOT NULL) STRICT;
CREATE TABLE operation_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,project_id TEXT NOT NULL REFERENCES projects(project_id),operation_id TEXT REFERENCES operations(operation_id),body TEXT NOT NULL) STRICT;
CREATE TABLE artifacts(artifact_id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(project_id),operation_id TEXT REFERENCES operations(operation_id),body TEXT NOT NULL) STRICT;
${originalRecordTables.map(table => `CREATE TABLE ${table}(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(project_id),body TEXT NOT NULL) STRICT;`).join('\n')}
CREATE TABLE file_index(project_id TEXT NOT NULL REFERENCES projects(project_id),path TEXT NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(project_id,path)) STRICT;
`;
export const migrations: readonly Migration[] = [
  { version: 1, sql: schema },
  { version: 2, sql: 'CREATE TABLE documents(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(project_id),body TEXT NOT NULL) STRICT;' },
];

/** Stable payload hashing rejects values that JSON would silently alter. */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  function normalize(item: unknown, depth: number): unknown {
    if (depth > 16) throw new WorkbenchError('INVALID_REQUEST', 'Record nesting exceeds the supported limit.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item !== 'object' || seen.has(item)) throw new WorkbenchError('INVALID_REQUEST', 'Record must contain finite, acyclic JSON data.');
    seen.add(item);
    let result: unknown;
    if (Array.isArray(item)) result = item.map(child => normalize(child, depth + 1));
    else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new WorkbenchError('INVALID_REQUEST', 'Record must contain ordinary JSON objects.');
      result = Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize((item as Record<string, unknown>)[key], depth + 1)]));
    }
    seen.delete(item);
    return result;
  }
  const json = JSON.stringify(normalize(value, 0));
  if (Buffer.byteLength(json) > 1024 * 1024) throw new WorkbenchError('INVALID_REQUEST', 'Operational record exceeds 1 MiB.');
  return json;
}

function assertId(id: string): void {
  if (!isRequestId(id)) throw new WorkbenchError('INVALID_REQUEST', 'Expected a UUID.');
}
function assertDigest(value: string): void {
  if (!digestPattern.test(value)) throw new WorkbenchError('ARTIFACT_MISMATCH', 'Expected a SHA-256 digest.');
}
/** Credentials have no persistence field in operational records. This is not a general secret detector. */
function assertNoCredentials(value: unknown, depth = 0): void {
  if (depth > 16) throw new WorkbenchError('INVALID_REQUEST', 'Credential inspection nesting exceeds the supported limit.');
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:password|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|private[-_]?key|credentials)$/i.test(key) && child !== null && child !== '') {
        throw new WorkbenchError('INVALID_REQUEST', 'Credential-bearing data is excluded from operational storage and exports.');
      }
      assertNoCredentials(child, depth + 1);
    }
  } else if (typeof value === 'string' && /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}|(?:api[_-]?key|access[_-]?token|password)\s*[=:]\s*["']?[^\s"']{8,})/i.test(value)) {
    throw new WorkbenchError('INVALID_REQUEST', 'Recognizable credential material is excluded from operational storage and exports.');
  }
}
function encoded(value: unknown): string { const json = canonicalJson(value); assertNoCredentials(JSON.parse(json)); return json; }
export function checkArtifactCredentials(bytes: Uint8Array): void {
  const text = Buffer.from(bytes).toString('utf8');
  assertNoCredentials(text);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return; }
  assertNoCredentials(parsed);
}
function localPath(root: string, locator: string): string {
  if (!locator || locator.includes('\\') || locator.includes(':') || locator.startsWith('/') || locator.split('/').some(part => !part || part === '.' || part === '..')) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Invalid storage locator.');
  const path = resolve(root, locator);
  const resolved = existsSync(path) ? realpathSync(path) : realpathSync(dirname(path));
  const inside = relative(root, resolved);
  if (isAbsolute(inside) || inside === '..' || inside.startsWith('..\\') || inside.startsWith('../')) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Storage locator leaves its data root.');
  return path;
}
function assertOwnedFile(path: string): void {
  let info;
  try { info = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Operational files cannot be symbolic links, junctions or shared hardlinks.');
}
function ensureOwnedDirectory(root: string, name: string): void {
  const path = join(root, name);
  let info;
  try { info = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (info && (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path).toLowerCase() !== resolve(path).toLowerCase())) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Operational subdirectories cannot traverse symbolic links or junctions.');
  if (!info) mkdirSync(path);
}
function assertDestination(directory: string): void {
  let existing = resolve(directory);
  while (!existsSync(existing)) existing = dirname(existing);
  if (realpathSync(existing).toLowerCase() !== resolve(existing).toLowerCase()) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Restore destinations cannot traverse symbolic links or junctions.');
}
function validateArtifact(value: unknown): ArtifactRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkbenchError('INVALID_REQUEST', 'Invalid artifact metadata.');
  const item = value as ArtifactRecord;
  if (Object.keys(item).some(key => !['artifactId', 'projectId', 'sha256', 'sizeBytes', 'relativePath', 'mediaType', 'createdAt', 'operationId'].includes(key))) throw new WorkbenchError('INVALID_REQUEST', 'Unknown artifact metadata.');
  assertId(item.artifactId); assertId(item.projectId); assertDigest(item.sha256);
  if (item.operationId !== undefined) assertId(item.operationId);
  if (!Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0 || typeof item.mediaType !== 'string' || item.mediaType.length > 128 || !/^[\w.+-]+\/[\w.+-]+$/.test(item.mediaType) || typeof item.createdAt !== 'string' || !item.createdAt.endsWith('Z') || !Number.isFinite(Date.parse(item.createdAt)) || item.relativePath !== `artifacts/${item.sha256}`) throw new WorkbenchError('INVALID_REQUEST', 'Invalid artifact metadata.');
  return item;
}
function projectRow(row: Record<string, unknown>): ProjectRecord {
  return { projectId: String(row.project_id), root: String(row.root), projectRevision: Number(row.revision), manifestSha256: String(row.manifest_sha256) };
}
function receiptRow(row: Record<string, unknown>): OperationReceipt { return validateOperation(JSON.parse(String(row.receipt))); }
interface BackupManifest {
  schemaVersion: 1;
  epoch: string;
  snapshotSequence: number;
  databaseSha256: string;
  artifacts: ArtifactRecord[];
}

export class WorkbenchStore {
  readonly dataRoot: string;
  readonly databasePath: string;
  readonly epoch: string;
  readonly recovery: { quarantined: string[]; missing: string[]; corrupt: string[] };
  private readonly db: DatabaseSync;
  private readonly fault?: (step: ArtifactCommitStep) => void;

  constructor(dataRoot: string, options: { migrations?: readonly Migration[]; fault?: (step: ArtifactCommitStep) => void } = {}) {
    if (!isAbsolute(dataRoot) || /^\\\\|^\/\//.test(dataRoot)) throw new WorkbenchError('UNSUPPORTED_ENVIRONMENT', 'Select an absolute local operational data directory.');
    mkdirSync(dataRoot, { recursive: true });
    this.dataRoot = realpathSync(dataRoot);
    if (/^\\\\|^\/\//.test(this.dataRoot)) throw new WorkbenchError('UNSUPPORTED_ENVIRONMENT', 'Operational data cannot reside on a network share.');
    this.databasePath = join(this.dataRoot, 'workbench.sqlite');
    for (const suffix of ['', '-journal', '-wal', '-shm']) assertOwnedFile(this.databasePath + suffix);
    for (const directory of ['artifacts', 'temporary', 'quarantine', 'backups']) ensureOwnedDirectory(this.dataRoot, directory);
    const selected = options.migrations ?? migrations;
    if (selected.some((item, index) => item.version !== index + 1)) throw new WorkbenchError('UNSUPPORTED_SCHEMA', 'Migration versions must be consecutive.');
    if (existsSync(this.databasePath)) {
      const probe = new DatabaseSync(this.databasePath, { readOnly: true });
      try {
        if (Number(probe.prepare('PRAGMA user_version').get()!.user_version) > selected.length) throw new WorkbenchError('UNSUPPORTED_SCHEMA', 'This database requires a newer workbench; it was left unchanged.');
      } finally { probe.close(); }
    }
    this.db = new DatabaseSync(this.databasePath, { enableForeignKeyConstraints: true, allowExtension: false, timeout: 1000 });
    this.fault = options.fault;
    try {
      if (Number(this.db.prepare('PRAGMA foreign_keys').get()!.foreign_keys) !== 1) throw new WorkbenchError('INTERNAL_ERROR', 'SQLite foreign keys are required.');
      this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
      this.migrate(selected);
      this.epoch = String(this.db.prepare("SELECT value FROM metadata WHERE key='epoch'").get()!.value);
      this.recovery = this.recoverArtifacts();
    } catch (error) { this.db.close(); throw error; }
  }

  private migrate(selected: readonly Migration[]): void {
    const current = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
    if (current) {
      for (const migration of selected.slice(0, current)) {
        const row = this.db.prepare('SELECT checksum FROM schema_migrations WHERE version=?').get(migration.version);
        if (row?.checksum !== sha(migration.sql)) throw new WorkbenchError('UNSUPPORTED_SCHEMA', 'Applied migration checksum differs; preserve the database and select the matching application.');
      }
    }
    if (current === selected.length) return;
    const lock = join(this.dataRoot, 'migration.lock');
    let handle: number;
    try { handle = openSync(lock, 'wx'); }
    catch { throw new WorkbenchError('DEVICE_BUSY', 'Another migration owns this data directory; inspect a stale migration lock before recovery.'); }
    try {
      writeFileSync(handle, String(process.pid));
      if (current) {
        ensureOwnedDirectory(this.dataRoot, 'backups');
        this.db.prepare('VACUUM INTO ?').run(join(this.dataRoot, 'backups', `before-${current + 1}-${randomUUID()}.sqlite`));
      }
      this.db.exec('BEGIN EXCLUSIVE;');
      try {
        this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL) STRICT;');
        for (const migration of selected.slice(current)) {
          this.db.exec(migration.sql);
          this.db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(migration.version, sha(migration.sql), now());
          this.db.exec(`PRAGMA user_version=${migration.version};`);
        }
        if (!current) this.db.prepare("INSERT INTO metadata VALUES('epoch',?)").run(randomUUID());
        this.db.exec('COMMIT;');
      } catch (error) { this.db.exec('ROLLBACK;'); throw error; }
    } finally { closeSync(handle); unlinkSync(lock); }
  }

  close(): void { this.db.close(); }
  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE;');
    try { const value = run(); this.db.exec('COMMIT;'); return value; }
    catch (error) { this.db.exec('ROLLBACK;'); throw error; }
  }
  registerProject(record: ProjectRecord): ProjectRecord {
    assertId(record.projectId); assertDigest(record.manifestSha256);
    if (!Number.isSafeInteger(record.projectRevision) || record.projectRevision < 1 || !isAbsolute(record.root)) throw new WorkbenchError('INVALID_REQUEST', 'Project requires a local root and positive revision.');
    const root = realpathSync(record.root);
    const existing = this.db.prepare('SELECT * FROM projects WHERE project_id=?').get(record.projectId);
    if (existing && String(existing.root).toLowerCase() !== root.toLowerCase()) throw new WorkbenchError('REVISION_CONFLICT', 'Project identity is already registered at another location; choose explicit relocation or fork.');
    if (!existing) this.db.prepare('INSERT INTO projects VALUES(?,?,?,?)').run(record.projectId, root, record.projectRevision, record.manifestSha256);
    return this.getProject(record.projectId);
  }
  getProject(projectId: string): ProjectRecord {
    assertId(projectId);
    const row = this.db.prepare('SELECT * FROM projects WHERE project_id=?').get(projectId);
    if (!row) throw new WorkbenchError('NOT_FOUND', 'Project is not registered.');
    return projectRow(row);
  }
  listProjects(): ProjectRecord[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY project_id').all().map(projectRow);
  }
  relocateProject(projectId: string, newRoot: string, expectedOldRoot: string): ProjectRecord {
    const current = this.getProject(projectId);
    if (!isAbsolute(newRoot) || resolve(current.root).toLowerCase() !== resolve(expectedOldRoot).toLowerCase()) throw new WorkbenchError('REVISION_CONFLICT', 'Project location changed; inspect the registered location before relocating.');
    const root = realpathSync(newRoot);
    this.db.prepare('UPDATE projects SET root=? WHERE project_id=?').run(root, projectId);
    return this.getProject(projectId);
  }
  updateProject(projectId: string, projectRevision: number, manifestSha256: string): ProjectRecord {
    const current = this.getProject(projectId); assertDigest(manifestSha256);
    if (!Number.isSafeInteger(projectRevision) || projectRevision < current.projectRevision || (projectRevision === current.projectRevision && current.manifestSha256 !== manifestSha256)) throw new WorkbenchError('REVISION_CONFLICT', 'Changed manifest intent needs a newer accepted revision.');
    this.transaction(() => {
      this.db.prepare('UPDATE projects SET revision=?,manifest_sha256=? WHERE project_id=?').run(projectRevision, manifestSha256, projectId);
      if (projectRevision !== current.projectRevision || manifestSha256 !== current.manifestSha256) this.event(projectId, projectRevision, 'project.changed', { manifestSha256 });
    });
    return this.getProject(projectId);
  }

  createOperation(receipt: OperationReceipt, payload: unknown): OperationReceipt {
    receipt = validateOperation(receipt); encoded(receipt);
    if (receipt.status !== 'queued') throw new WorkbenchError('INVALID_REQUEST', 'New operations must begin queued.');
    const payloadDigest = sha(encoded(payload));
    this.getProject(receipt.projectId);
    return this.transaction(() => {
      const cancellation = this.cancellationRequest(receipt.requestId);
      if (cancellation) throw new WorkbenchError(cancellation.projectId === receipt.projectId ? 'REQUEST_ID_CONFLICT' : 'UNAUTHORIZED_SCOPE', 'Request ID already identifies another admitted request.');
      const existing = this.db.prepare('SELECT * FROM operations WHERE request_id=?').get(receipt.requestId);
      if (existing) {
        if (existing.project_id !== receipt.projectId) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Request belongs to another project.');
        if (existing.payload_digest !== payloadDigest) throw new WorkbenchError('REQUEST_ID_CONFLICT', 'Request ID already identifies different intent.');
        return receiptRow(existing);
      }
      if (receipt.expectedProjectRevision !== this.getProject(receipt.projectId).projectRevision) throw new WorkbenchError('REVISION_CONFLICT', 'Operation refers to a stale project revision.');
      this.db.prepare('INSERT INTO operations VALUES(?,?,?,?,?)').run(receipt.operationId, receipt.projectId, receipt.requestId, payloadDigest, canonicalJson(receipt));
      this.event(receipt.projectId, receipt.expectedProjectRevision, 'operation.changed', { status: receipt.status }, receipt.operationId);
      return receipt;
    });
  }

  private cancellationRequest(requestId: string): ProjectEvent | undefined {
    const row = this.db.prepare("SELECT body FROM operation_events WHERE json_extract(body,'$.type') IN ('operation.cancel-admitted','request.admitted') AND json_extract(body,'$.payload.requestId')=? LIMIT 1").get(requestId);
    return row ? JSON.parse(String(row.body)) as ProjectEvent : undefined;
  }

  admitRequest(projectId: string, requestId: string, payload: unknown): boolean {
    assertId(requestId); const project = this.getProject(projectId);
    const payloadDigest = sha(encoded(payload));
    return this.transaction(() => {
      const previous = this.cancellationRequest(requestId);
      if (previous) {
        if (previous.projectId !== projectId) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Request belongs to another project.');
        if (previous.payload.payloadDigest !== payloadDigest) throw new WorkbenchError('REQUEST_ID_CONFLICT', 'Request ID identifies different intent.');
        return false;
      }
      const existing = this.db.prepare('SELECT project_id FROM operations WHERE request_id=?').get(requestId);
      if (existing) throw new WorkbenchError(existing.project_id === projectId ? 'REQUEST_ID_CONFLICT' : 'UNAUTHORIZED_SCOPE', 'Request ID already identifies an operation.');
      this.event(projectId, project.projectRevision, 'request.admitted', { requestId, payloadDigest });
      return true;
    });
  }

  /** Cancel admission is durable before aborting, and never becomes replayable work. */
  admitCancellation(projectId: string, requestId: string, operationId: string, payload: unknown): boolean {
    assertId(requestId);
    const operation = this.getOperation(projectId, operationId);
    const payloadDigest = sha(encoded(payload));
    return this.transaction(() => {
      const previous = this.cancellationRequest(requestId);
      if (previous) {
        if (previous.projectId !== projectId) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Request belongs to a different project.');
        if (previous.payload.payloadDigest !== payloadDigest) throw new WorkbenchError('REQUEST_ID_CONFLICT', 'Cancellation request ID already identifies different intent.');
        return false;
      }
      const existing = this.db.prepare('SELECT project_id FROM operations WHERE request_id=?').get(requestId);
      if (existing) throw new WorkbenchError(existing.project_id === projectId ? 'REQUEST_ID_CONFLICT' : 'UNAUTHORIZED_SCOPE', 'Request ID is already bound to another operation.');
      this.event(projectId, operation.expectedProjectRevision, 'operation.cancel-admitted', { requestId, payloadDigest, operationId }, operationId);
      return true;
    });
  }
  getOperation(projectId: string, operationId: string): OperationReceipt {
    assertId(projectId); assertId(operationId);
    const row = this.db.prepare('SELECT * FROM operations WHERE operation_id=? AND project_id=?').get(operationId, projectId);
    if (!row) throw new WorkbenchError('NOT_FOUND', 'Operation is not available in this project.');
    return receiptRow(row);
  }
  getOperationByRequest(projectId: string, requestId: string): OperationReceipt {
    assertId(projectId); assertId(requestId);
    const row = this.db.prepare('SELECT * FROM operations WHERE request_id=? AND project_id=?').get(requestId, projectId);
    if (!row) throw new WorkbenchError('NOT_FOUND', 'Request is not available in this project.');
    return receiptRow(row);
  }
  listOperations(projectId: string): OperationReceipt[] {
    this.getProject(projectId);
    return this.db.prepare('SELECT * FROM operations WHERE project_id=? ORDER BY rowid').all(projectId).map(receiptRow);
  }
  transitionOperation(projectId: string, operationId: string, status: OperationStatus, patch: Partial<Pick<OperationReceipt, 'artifacts' | 'error' | 'result' | 'startedAt' | 'finishedAt'>> = {}): OperationReceipt {
    return this.transaction(() => {
      const current = this.getOperation(projectId, operationId);
      assertTransition(current.status, status);
      const next = validateOperation({ ...current, ...patch, status, ...(status === 'running' && !current.startedAt ? { startedAt: now() } : {}), ...(terminal.has(status) ? { finishedAt: patch.finishedAt ?? now() } : {}) });
      encoded(next);
      for (const artifact of next.artifacts) {
        const stored = this.getArtifact(projectId, artifact.artifactId);
        if (stored.sha256 !== artifact.sha256 || stored.relativePath !== artifact.relativePath || stored.mediaType !== artifact.mediaType) throw new WorkbenchError('ARTIFACT_MISMATCH', 'Receipt artifact does not match immutable storage.');
        this.readArtifact(projectId, artifact.artifactId);
      }
      this.db.prepare('UPDATE operations SET receipt=? WHERE operation_id=?').run(canonicalJson(next), operationId);
      this.event(projectId, next.expectedProjectRevision, 'operation.changed', { status }, operationId);
      return next;
    });
  }
  reconcileOperations(): OperationReceipt[] {
    const reconciled: OperationReceipt[] = [];
    for (const row of this.db.prepare('SELECT * FROM operations').all()) {
      const current = receiptRow(row);
      if (terminal.has(current.status)) continue;
      const status = current.status === 'queued' ? 'cancelled' : current.kind === 'upload' ? 'outcome-unknown' : 'failed';
      reconciled.push(this.transitionOperation(current.projectId, current.operationId, status, { error: { code: status === 'outcome-unknown' ? 'OUTCOME_UNKNOWN' : 'SERVICE_RESTARTED', message: 'Owning service restarted; work was not replayed.', retryable: false } }));
    }
    return reconciled;
  }

  storeArtifact(projectId: string, bytes: Uint8Array, mediaType: string, operationId?: string): ArtifactRecord {
    this.getProject(projectId);
    if (!mediaType || mediaType.length > 128 || !(bytes instanceof Uint8Array)) throw new WorkbenchError('INVALID_REQUEST', 'Artifact requires bytes and a bounded media type.');
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(mediaType)) throw new WorkbenchError('INVALID_REQUEST', 'Artifact requires a valid media type.');
    if (operationId) this.getOperation(projectId, operationId);
    checkArtifactCredentials(bytes);
    ensureOwnedDirectory(this.dataRoot, 'temporary'); ensureOwnedDirectory(this.dataRoot, 'artifacts');
    const artifactId = randomUUID();
    const temp = localPath(this.dataRoot, `temporary/${operationId ?? artifactId}-${randomUUID()}.tmp`);
    const handle = openSync(temp, 'wx');
    try {
      this.fault?.('temporary-created');
      writeFileSync(handle, bytes); fsyncSync(handle);
    } finally { closeSync(handle); }
    this.fault?.('bytes-written');
    const written = readFileSync(temp);
    const digest = sha(written);
    if (written.byteLength !== bytes.byteLength || digest !== sha(bytes)) throw new WorkbenchError('ARTIFACT_MISMATCH', 'Artifact bytes changed during commit.');
    const relativePath = `artifacts/${digest}`;
    const finalPath = localPath(this.dataRoot, relativePath);
    assertOwnedFile(finalPath);
    if (existsSync(finalPath)) {
      if (sha(readFileSync(finalPath)) !== digest) throw new WorkbenchError('ARTIFACT_MISMATCH', 'Existing immutable bytes are corrupt and were preserved.');
    } else linkSync(temp, finalPath);
    unlinkSync(temp);
    this.fault?.('finalized');
    const artifact = validateArtifact({ artifactId, projectId, sha256: digest, sizeBytes: bytes.byteLength, relativePath, mediaType, createdAt: now(), ...(operationId ? { operationId } : {}) });
    this.db.prepare('INSERT INTO artifacts VALUES(?,?,?,?)').run(artifactId, projectId, operationId ?? null, encoded(artifact));
    this.fault?.('registered');
    return artifact;
  }
  getArtifact(projectId: string, artifactId: string): ArtifactRecord {
    assertId(projectId); assertId(artifactId);
    const row = this.db.prepare('SELECT body FROM artifacts WHERE artifact_id=? AND project_id=?').get(artifactId, projectId);
    if (!row) throw new WorkbenchError('NOT_FOUND', 'Artifact is not available in this project.');
    return validateArtifact(JSON.parse(String(row.body)));
  }
  readArtifact(projectId: string, artifactId: string): Buffer {
    const artifact = this.getArtifact(projectId, artifactId);
    const path = localPath(this.dataRoot, artifact.relativePath);
    assertOwnedFile(path);
    if (!existsSync(path)) throw new WorkbenchError('NOT_FOUND', 'Retained artifact bytes are missing; history was preserved.');
    const bytes = readFileSync(path);
    if (bytes.byteLength !== artifact.sizeBytes || sha(bytes) !== artifact.sha256) throw new WorkbenchError('ARTIFACT_MISMATCH', 'Retained artifact bytes failed verification.');
    return bytes;
  }
  private recoverArtifacts(): { quarantined: string[]; missing: string[]; corrupt: string[] } {
    const report = { quarantined: [] as string[], missing: [] as string[], corrupt: [] as string[] };
    const artifacts = this.db.prepare('SELECT body FROM artifacts').all().map(row => validateArtifact(JSON.parse(String(row.body))));
    const referenced = new Set(artifacts.map(item => item.relativePath));
    for (const directory of ['temporary', 'artifacts']) {
      for (const entry of readdirSync(join(this.dataRoot, directory), { withFileTypes: true })) {
        const locator = `${directory}/${entry.name}`;
        if (directory === 'artifacts' && referenced.has(locator)) continue;
        const target = `quarantine/${randomUUID()}-${entry.name}`;
        renameSync(localPath(this.dataRoot, locator), localPath(this.dataRoot, target));
        report.quarantined.push(target);
      }
    }
    for (const artifact of artifacts) {
      try { this.readArtifact(artifact.projectId, artifact.artifactId); }
      catch (error) { (error instanceof WorkbenchError && error.code === 'NOT_FOUND' ? report.missing : report.corrupt).push(artifact.artifactId); }
    }
    return report;
  }

  putRecord(table: RecordTable, id: string, projectId: string, value: unknown): void {
    if (!recordTables.includes(table)) throw new WorkbenchError('INVALID_REQUEST', 'Unsupported record table.');
    assertId(id); this.getProject(projectId);
    const body = encoded(value);
    const current = this.db.prepare(`SELECT project_id,body FROM ${table} WHERE id=?`).get(id);
    if (current) {
      if (current.project_id !== projectId) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Record belongs to another project.');
      if (current.body !== body) throw new WorkbenchError('REVISION_CONFLICT', 'Historical records are immutable; create a new record.');
      return;
    }
    this.db.prepare(`INSERT INTO ${table} VALUES(?,?,?)`).run(id, projectId, body);
  }
  getRecord<T = unknown>(table: RecordTable, id: string, projectId: string): T {
    if (!recordTables.includes(table)) throw new WorkbenchError('INVALID_REQUEST', 'Unsupported record table.');
    assertId(id); assertId(projectId);
    const row = this.db.prepare(`SELECT body FROM ${table} WHERE id=? AND project_id=?`).get(id, projectId);
    if (!row) throw new WorkbenchError('NOT_FOUND', 'Record is not available in this project.');
    return JSON.parse(String(row.body)) as T;
  }
  listRecords<T = unknown>(table: RecordTable, projectId: string): T[] {
    if (!recordTables.includes(table)) throw new WorkbenchError('INVALID_REQUEST', 'Unsupported record table.');
    this.getProject(projectId);
    return this.db.prepare(`SELECT body FROM ${table} WHERE project_id=? ORDER BY rowid`).all(projectId).map(row => JSON.parse(String(row.body)) as T);
  }
  private documentIndex(): void {
    try { this.db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS document_search USING fts5(project_id UNINDEXED,version_id UNINDEXED,document_id UNINDEXED,page UNINDEXED,text,tokenize="unicode61");'); }
    catch { throw new WorkbenchError('TOOL_UNAVAILABLE', 'SQLite FTS5 is unavailable. Originals and exact citations remain retained; document search is disabled.', { reason: 'DOCUMENT_INDEX_UNAVAILABLE' }); }
  }
  replaceDocumentIndex(projectId: string, versionId: string, documentId: string, pages: { page: number; text: string }[]): void {
    this.getProject(projectId); assertId(versionId); assertId(documentId);
    this.getRecord('documents', versionId, projectId);
    if (!Array.isArray(pages) || pages.length > 2000 || pages.some((page, index) => page.page !== index + 1 || typeof page.text !== 'string' || Buffer.byteLength(page.text) > 1024 * 1024)) throw new WorkbenchError('INVALID_REQUEST', 'Invalid bounded document pages.');
    this.documentIndex();
    this.transaction(() => {
      this.db.prepare('DELETE FROM document_search WHERE project_id=? AND version_id=?').run(projectId, versionId);
      const insert = this.db.prepare('INSERT INTO document_search(project_id,version_id,document_id,page,text) VALUES(?,?,?,?,?)');
      for (const page of pages) insert.run(projectId, versionId, documentId, page.page, page.text);
    });
  }
  searchDocumentIndex(projectId: string, query: string, documentIds: string[] | undefined, limit: number, versionIds?: string[]): { versionId: string; page: number }[] {
    this.getProject(projectId);
    if (typeof query !== 'string' || !query.trim() || Buffer.byteLength(query) > 1024 || !Number.isInteger(limit) || limit < 1 || limit > 500 || (documentIds !== undefined && (!Array.isArray(documentIds) || documentIds.length > 500))) throw new WorkbenchError('INVALID_REQUEST', 'Document query requires bounded text, filters and limit.');
    documentIds?.forEach(assertId);
    if (versionIds !== undefined && (!Array.isArray(versionIds) || versionIds.length > 10000)) throw new WorkbenchError('INVALID_REQUEST', 'Document version filter exceeds the supported query bound.');
    versionIds?.forEach(assertId);
    if (documentIds?.length === 0 || versionIds?.length === 0) return [];
    this.documentIndex();
    const terms = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 32) ?? [];
    if (!terms.length) return [];
    // Only literal tokens reach MATCH; source text cannot introduce FTS operators.
    const literal = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' AND ');
    const filter = documentIds ? ` AND document_id IN (${documentIds.map(() => '?').join(',')})` : '';
    const versions = versionIds ? ` AND version_id IN (${versionIds.map(() => '?').join(',')})` : '';
    return this.db.prepare(`SELECT version_id,page FROM document_search WHERE document_search MATCH ? AND project_id=?${filter}${versions} ORDER BY bm25(document_search),version_id,CAST(page AS INTEGER) LIMIT ?`).all(literal, projectId, ...(documentIds ?? []), ...(versionIds ?? []), limit).map(row => ({ versionId: String(row.version_id), page: Number(row.page) }));
  }
  clearDocumentIndex(projectId: string): void {
    this.getProject(projectId); this.documentIndex();
    this.db.prepare('DELETE FROM document_search WHERE project_id=?').run(projectId);
  }
  rebuildFileIndex(projectId: string, entries: { path: string; sha256: string }[]): void {
    this.getProject(projectId);
    for (const entry of entries) { assertDigest(entry.sha256); if (!entry.path || entry.path.includes('..') || isAbsolute(entry.path) || /[:\\]/.test(entry.path)) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Index path must stay project-relative.'); }
    this.transaction(() => {
      this.db.prepare('DELETE FROM file_index WHERE project_id=?').run(projectId);
      for (const entry of entries) this.db.prepare('INSERT INTO file_index VALUES(?,?,?)').run(projectId, entry.path, entry.sha256);
    });
  }
  private event(projectId: string, projectRevision: number, type: string, payload: Record<string, unknown>, operationId?: string): ProjectEvent {
    const event = { schemaVersion: 1 as const, eventId: randomUUID(), sequence: this.snapshotWatermark() + 1, projectId, projectRevision, type, occurredAt: now(), payload, ...(operationId ? { operationId } : {}) };
    if (!isProjectEvent(event)) throw new WorkbenchError('INVALID_REQUEST', 'Invalid event.');
    this.db.prepare('INSERT INTO operation_events(event_id,project_id,operation_id,body) VALUES(?,?,?,?)').run(event.eventId, projectId, operationId ?? null, encoded(event));
    return event;
  }
  appendEvent(projectId: string, projectRevision: number, type: string, payload: Record<string, unknown>, operationId?: string): ProjectEvent {
    this.getProject(projectId);
    if (operationId) this.getOperation(projectId, operationId);
    return this.transaction(() => this.event(projectId, projectRevision, type, payload, operationId));
  }
  snapshotWatermark(): number { return Number(this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS watermark FROM operation_events').get()!.watermark); }
  eventsSince(projectId: string, afterSequence: number, epoch = this.epoch, limit = 100): { epoch: string; snapshotSequence: number; resyncRequired: boolean; events: ProjectEvent[] } {
    this.getProject(projectId);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new WorkbenchError('INVALID_REQUEST', 'Invalid event cursor or limit.');
    const snapshotSequence = this.snapshotWatermark();
    const resyncRequired = epoch !== this.epoch || afterSequence > snapshotSequence;
    return { epoch: this.epoch, snapshotSequence, resyncRequired, events: resyncRequired ? [] : this.db.prepare('SELECT body FROM operation_events WHERE project_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(projectId, afterSequence, limit).map(row => JSON.parse(String(row.body)) as ProjectEvent) };
  }

  /** The companion's exclusive ownership must cover this store and its artifact commits. */
  backup(directory: string): BackupManifest {
    if (!isAbsolute(directory) || (existsSync(directory) && readdirSync(directory).length)) throw new WorkbenchError('INVALID_REQUEST', 'Backup requires an empty absolute destination directory.');
    mkdirSync(directory, { recursive: true });
    const destination = realpathSync(directory);
    const databasePath = join(destination, 'workbench.sqlite');
    this.db.prepare('VACUUM INTO ?').run(databasePath);
    const snapshot = new DatabaseSync(databasePath, { readOnly: true });
    let artifacts: ArtifactRecord[];
    let snapshotSequence: number;
    try {
      snapshotSequence = Number(snapshot.prepare('SELECT COALESCE(MAX(sequence),0) AS watermark FROM operation_events').get()!.watermark);
      artifacts = snapshot.prepare('SELECT body FROM artifacts').all().map(row => validateArtifact(JSON.parse(String(row.body))));
      for (const table of ['operations', 'operation_events', 'artifacts', ...recordTables]) {
        if (!snapshot.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
        for (const row of snapshot.prepare(`SELECT * FROM ${table}`).all()) for (const item of Object.values(row)) if (typeof item === 'string') checkArtifactCredentials(Buffer.from(item));
      }
    } finally { snapshot.close(); }
    mkdirSync(join(destination, 'artifacts'), { recursive: true });
    for (const artifact of artifacts) {
      const bytes = this.readArtifact(artifact.projectId, artifact.artifactId);
      checkArtifactCredentials(bytes);
      const target = localPath(destination, artifact.relativePath);
      if (!existsSync(target)) writeFileSync(target, bytes, { flag: 'wx' });
    }
    const manifest: BackupManifest = { schemaVersion: 1, epoch: this.epoch, snapshotSequence, databaseSha256: sha(readFileSync(databasePath)), artifacts };
    writeFileSync(join(destination, 'backup.json'), encoded(manifest), { flag: 'wx' });
    return manifest;
  }

  static restore(directory: string, dataRoot: string): WorkbenchStore {
    if (!isAbsolute(directory) || !isAbsolute(dataRoot) || /^\\\\|^\/\//.test(dataRoot)) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Restore requires absolute local directories.');
    assertDestination(dataRoot);
    if (existsSync(dataRoot) && readdirSync(dataRoot).length) throw new WorkbenchError('REVISION_CONFLICT', 'Restore destination must be empty; existing history was preserved.');
    const source = realpathSync(directory);
    const manifestBytes = readFileSync(localPath(source, 'backup.json'));
    if (manifestBytes.byteLength > 1024 * 1024) throw new WorkbenchError('INVALID_REQUEST', 'Backup manifest exceeds 1 MiB.');
    let manifest: BackupManifest;
    try { manifest = JSON.parse(manifestBytes.toString('utf8')) as BackupManifest; canonicalJson(manifest); }
    catch { throw new WorkbenchError('INVALID_REQUEST', 'Backup manifest must contain bounded valid JSON.'); }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.schemaVersion !== 1 || !isRequestId(manifest.epoch) || !Number.isSafeInteger(manifest.snapshotSequence) || manifest.snapshotSequence < 0 || !Array.isArray(manifest.artifacts) || Object.keys(manifest).some(key => !['schemaVersion', 'epoch', 'snapshotSequence', 'databaseSha256', 'artifacts'].includes(key))) throw new WorkbenchError('UNSUPPORTED_SCHEMA', 'Unsupported backup manifest.');
    for (const artifact of manifest.artifacts) validateArtifact(artifact);
    if (new Set(manifest.artifacts.map(item => item.artifactId)).size !== manifest.artifacts.length) throw new WorkbenchError('INVALID_REQUEST', 'Duplicate backup artifact identity.');
    assertDigest(manifest.databaseSha256);
    if (sha(readFileSync(localPath(source, 'workbench.sqlite'))) !== manifest.databaseSha256) throw new WorkbenchError('ARTIFACT_MISMATCH', 'Backup database checksum failed.');
    const probe = new DatabaseSync(localPath(source, 'workbench.sqlite'), { readOnly: true });
    try {
      if (probe.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' || probe.prepare('PRAGMA foreign_key_check').all().length) throw new WorkbenchError('ARTIFACT_MISMATCH', 'Backup database integrity failed.');
      if (Number(probe.prepare('PRAGMA user_version').get()!.user_version) > migrations.length) throw new WorkbenchError('UNSUPPORTED_SCHEMA', 'Backup requires a newer workbench.');
      if (probe.prepare("SELECT value FROM metadata WHERE key='epoch'").get()?.value !== manifest.epoch || Number(probe.prepare('SELECT COALESCE(MAX(sequence),0) AS watermark FROM operation_events').get()!.watermark) !== manifest.snapshotSequence) throw new WorkbenchError('ARTIFACT_MISMATCH', 'Backup watermark or epoch differs from its database.');
      const stored = probe.prepare('SELECT body FROM artifacts ORDER BY artifact_id').all().map(row => validateArtifact(JSON.parse(String(row.body))));
      if (canonicalJson(stored) !== canonicalJson([...manifest.artifacts].sort((a,b) => a.artifactId.localeCompare(b.artifactId)))) throw new WorkbenchError('ARTIFACT_MISMATCH', 'Backup artifact inventory differs from its database.');
      for (const table of ['operations', 'operation_events', 'artifacts', ...recordTables]) {
        if (!probe.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
        for (const row of probe.prepare(`SELECT * FROM ${table}`).all()) for (const item of Object.values(row)) if (typeof item === 'string') checkArtifactCredentials(Buffer.from(item));
      }
      for (const row of probe.prepare('SELECT receipt FROM operations').all()) validateOperation(JSON.parse(String(row.receipt)));
    } finally { probe.close(); }
    for (const artifact of manifest.artifacts) {
      assertId(artifact.artifactId); assertId(artifact.projectId); assertDigest(artifact.sha256);
      if (artifact.relativePath !== `artifacts/${artifact.sha256}`) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Invalid artifact locator.');
      const bytes = readFileSync(localPath(source, artifact.relativePath));
      if (bytes.byteLength !== artifact.sizeBytes || sha(bytes) !== artifact.sha256) throw new WorkbenchError('ARTIFACT_MISMATCH', 'Backup artifact checksum failed.');
      checkArtifactCredentials(bytes);
    }
    mkdirSync(join(dataRoot, 'artifacts'), { recursive: true });
    copyFileSync(localPath(source, 'workbench.sqlite'), join(dataRoot, 'workbench.sqlite'));
    for (const artifact of manifest.artifacts) {
      const target = join(dataRoot, artifact.relativePath);
      if (!existsSync(target)) copyFileSync(localPath(source, artifact.relativePath), target);
    }
    const restored = new DatabaseSync(join(dataRoot, 'workbench.sqlite'));
    try { restored.prepare("UPDATE metadata SET value=? WHERE key='epoch'").run(randomUUID()); }
    finally { restored.close(); }
    return new WorkbenchStore(dataRoot);
  }
}
