import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkbenchStore, migrations } from '../src/index';

test('schema1 upgrades with its original checksum, backup and operational evidence intact', () => {
  const directory = mkdtempSync(join(tmpdir(), 'document-migration-')), root = join(directory, 'project'), dataRoot = join(directory, 'data'); mkdirSync(root);
  const old = new WorkbenchStore(dataRoot, { migrations: migrations.slice(0, 1) });
  const projectId = randomUUID(), observationId = randomUUID();
  old.registerProject({ projectId, root, projectRevision: 1, manifestSha256: 'a'.repeat(64) });
  old.putRecord('observations', observationId, projectId, { note: 'pre-document evidence' });
  const original = old.storeArtifact(projectId, Buffer.from('preserved artifact'), 'text/plain'); old.close();
  const upgraded = new WorkbenchStore(dataRoot);
  assert.equal(upgraded.getRecord<{ note: string }>('observations', observationId, projectId).note, 'pre-document evidence');
  assert.equal(upgraded.readArtifact(projectId, original.artifactId).toString(), 'preserved artifact');
  assert.deepEqual(upgraded.listRecords('documents', projectId), []);
  const backups = readdirSync(join(dataRoot, 'backups')); assert.equal(backups.length, 1);
  const snapshot = new DatabaseSync(join(dataRoot, 'backups', backups[0]), { readOnly: true });
  assert.equal(snapshot.prepare('PRAGMA user_version').get()!.user_version, 1); snapshot.close();
  upgraded.close();
});

test('old schema backups restore through upgrade without missing-table failures', () => {
  const directory = mkdtempSync(join(tmpdir(), 'document-old-backup-')), root = join(directory, 'project'); mkdirSync(root);
  const old = new WorkbenchStore(join(directory, 'old'), { migrations: migrations.slice(0, 1) }), projectId = randomUUID();
  old.registerProject({ projectId, root, projectRevision: 1, manifestSha256: 'a'.repeat(64) });
  old.backup(join(directory, 'backup')); old.close();
  const restored = WorkbenchStore.restore(join(directory, 'backup'), join(directory, 'restored'));
  assert.equal(restored.getProject(projectId).projectRevision, 1); assert.deepEqual(restored.listRecords('documents', projectId), []);
  restored.close();
});

test('FTS5 index updates are atomic and cannot replace retained document metadata or cross project scope', () => {
  const directory = mkdtempSync(join(tmpdir(), 'document-index-')), root = join(directory, 'project'); mkdirSync(root);
  const store = new WorkbenchStore(join(directory, 'data')), projectId = randomUUID(), versionId = randomUUID(), documentId = randomUUID();
  store.registerProject({ projectId, root, projectRevision: 1, manifestSha256: 'a'.repeat(64) });
  store.putRecord('documents', versionId, projectId, { source: 'retained' });
  store.replaceDocumentIndex(projectId, versionId, documentId, [{ page: 1, text: 'retained searchable text' }]);
  assert.equal(store.searchDocumentIndex(projectId, 'searchable', [documentId], 10)[0].versionId, versionId);
  const newer = randomUUID(); store.putRecord('documents', newer, projectId, { source: 'newer' });
  store.replaceDocumentIndex(projectId, newer, documentId, [{ page: 1, text: 'searchable newest' }]);
  assert.equal(store.searchDocumentIndex(projectId, 'searchable', [documentId], 1, [newer])[0].versionId, newer);
  assert.throws(() => store.replaceDocumentIndex(projectId, versionId, documentId, [{ page: 2, text: 'wrong physical page' }]), { code: 'INVALID_REQUEST' });
  assert.equal(store.searchDocumentIndex(projectId, 'searchable', undefined, 10).length, 2);
  assert.throws(() => store.replaceDocumentIndex(randomUUID(), versionId, documentId, []), { code: 'NOT_FOUND' });
  store.clearDocumentIndex(projectId);
  assert.equal(store.searchDocumentIndex(projectId, 'searchable', undefined, 10).length, 0);
  assert.deepEqual(store.getRecord('documents', versionId, projectId), { source: 'retained' });
  store.close();
});
