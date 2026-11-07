import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectService } from '../src/project-service';
import { ReviewService } from '../src/review-service';
import type { ReviewSnapshotV1 } from '@robotics-workbench/contracts';

test('review journal retains immutable bytes and rejects malformed or wrong-project replacements', async t => {
  const temp = mkdtempSync(join(tmpdir(), 'workbench-review-store-')), root = join(temp, 'Probe'); mkdirSync(root);
  writeFileSync(join(root, 'workbench.json'), readFileSync('examples/workbench.valid.json'));
  const project = new ProjectService(root, join(temp, 'data')); t.after(async () => { await project.shutdown(); rmSync(temp, { recursive: true, force: true }); });
  const service = new ReviewService(project), taskId = randomUUID(), text = 'int n = 1;\n';
  const snapshot: ReviewSnapshotV1 = { schemaVersion: 1, taskId, root: project.files.root, files: [{ id: randomUUID(), path: 'Probe.ino', baselineText: text, baselineSha256: createHash('sha256').update(text).digest('hex'), baselineHost: null, effect: 'written', conflict: null }], omitted: [] };
  const save = (value: unknown) => service.handle({ schemaVersion: 1, requestId: randomUUID(), projectId: project.projectId, method: 'review.save', params: { taskId, snapshot: value } });
  const load = () => service.handle({ schemaVersion: 1, requestId: randomUUID(), projectId: project.projectId, method: 'review.load', params: { taskId } }).result;
  save(snapshot); assert.deepEqual(load(), snapshot);
  const badHash = structuredClone(snapshot); badHash.files[0].baselineSha256 = 'a'.repeat(64); assert.throws(() => save(badHash), { code: 'ARTIFACT_MISMATCH' });
  assert.throws(() => save({ ...snapshot, files: 'not-files' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => save({ ...snapshot, credential: 'unknown-property' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => save({ ...snapshot, root: temp }), { code: 'INVALID_REQUEST' });
  const escaped = structuredClone(snapshot); escaped.files[0].path = '../outside.ino'; assert.throws(() => save(escaped), { code: 'UNAUTHORIZED_SCOPE' });
  const secret = structuredClone(snapshot); secret.files[0].path = '.env'; assert.throws(() => save(secret), { code: 'UNAUTHORIZED_SCOPE' });
  assert.throws(() => service.handle({ schemaVersion: 1, requestId: randomUUID(), projectId: randomUUID(), method: 'review.load', params: { taskId } }), { code: 'UNAUTHORIZED_SCOPE' });
  assert.deepEqual(load(), snapshot); assert.equal(project.store.listRecords('sessions', project.projectId).length, 1);
});

test('review relocation proof binds retained artifact bytes to the recorded original and restored roots', async t => {
  const temp = mkdtempSync(join(tmpdir(), 'workbench-review-relocation-')), root = join(temp, 'Restored'); mkdirSync(root);
  writeFileSync(join(root, 'workbench.json'), readFileSync('examples/workbench.valid.json'));
  const project = new ProjectService(root, join(temp, 'data')); t.after(async () => { await project.shutdown(); rmSync(temp, { recursive: true, force: true }); });
  const taskId = randomUUID(), service = new ReviewService(project), oldRoot = join(temp, 'Original');
  const snapshot: ReviewSnapshotV1 = { schemaVersion: 1, taskId, root: oldRoot, files: [], omitted: [] };
  const artifact = project.store.storeArtifact(project.projectId, Buffer.from(JSON.stringify(snapshot)), 'application/json');
  project.store.putRecord('sessions', randomUUID(), project.projectId, { kind: 'task-review', taskId, artifactId: artifact.artifactId });
  const request = () => service.handle({ schemaVersion: 1, requestId: randomUUID(), projectId: project.projectId, method: 'review.relocation', params: { taskId } }).result;
  assert.equal(request(), null);
  project.store.putRecord('observations', randomUUID(), project.projectId, { kind: 'project-restore', previousRoot: join(temp, 'Unrelated'), root: project.files.root, archiveManifestSha256: 'a'.repeat(64), sourceSha256: 'b'.repeat(64), restoredAt: '2026-11-04T00:00:00.000Z' });
  assert.equal(request(), null);
  const proof = { previousRoot: oldRoot, root: project.files.root, archiveManifestSha256: 'a'.repeat(64), sourceSha256: 'b'.repeat(64), restoredAt: '2026-11-04T00:00:00.000Z' };
  project.store.putRecord('observations', randomUUID(), project.projectId, { kind: 'project-restore', ...proof });
  assert.deepEqual(request(), { ...proof, reviewArtifactId: artifact.artifactId, reviewSha256: artifact.sha256 });
  assert.deepEqual(JSON.parse(project.store.readArtifact(project.projectId, artifact.artifactId).toString('utf8')), snapshot);
});

test('review relocation follows two immutable restore hops and refuses cyclic or broken ancestry', async t => {
  const temp = mkdtempSync(join(tmpdir(), 'workbench-review-chain-')), root = join(temp, 'C'); mkdirSync(root);
  writeFileSync(join(root, 'workbench.json'), readFileSync('examples/workbench.valid.json'));
  const project = new ProjectService(root, join(temp, 'data')); t.after(async () => { await project.shutdown(); rmSync(temp, { recursive: true, force: true }); });
  const service = new ReviewService(project), first = join(temp, 'A'), middle = join(temp, 'B');
  const retain = (original: string) => { const taskId = randomUUID(); const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, taskId, root: original, files: [], omitted: [] })); const artifact = project.store.storeArtifact(project.projectId, bytes, 'application/json'); project.store.putRecord('sessions', randomUUID(), project.projectId, { kind: 'task-review', taskId, artifactId: artifact.artifactId }); return { taskId, artifact }; };
  const request = (taskId: string) => service.handle({ schemaVersion: 1, requestId: randomUUID(), projectId: project.projectId, method: 'review.relocation', params: { taskId } }).result as Record<string, unknown> | null;
  const hop = (previousRoot: string, next: string, second: number) => { const proof = { previousRoot, root: next, archiveManifestSha256: 'a'.repeat(64), sourceSha256: 'b'.repeat(64), restoredAt: `2026-11-04T00:00:0${second}.000Z` }; project.store.putRecord('observations', randomUUID(), project.projectId, { kind: 'project-restore', ...proof }); return proof; };
  const retained = retain(first), one = hop(first, middle, 1), two = hop(middle, project.files.root, 2);
  const proof = request(retained.taskId)!;
  assert.equal(proof.previousRoot, first); assert.equal(proof.root, project.files.root); assert.deepEqual(proof.restorationChain, [one, two]); assert.equal(proof.reviewSha256, retained.artifact.sha256);
  assert.equal(request(retain(join(temp, 'Unrelated')).taskId), null);
  hop(middle, first, 3); hop(first, project.files.root, 4);
  assert.throws(() => request(retained.taskId), { code: 'REVISION_CONFLICT' });
  assert.equal(project.store.readArtifact(project.projectId, retained.artifact.artifactId).toString('utf8').includes(first.replaceAll('\\', '\\\\')), true);
  for (let index = 0; index < 100; index++) hop(join(temp, `Depth${index}`), join(temp, `Depth${index + 1}`), 1);
  hop(join(temp, 'Depth100'), project.files.root, 1);
  assert.throws(() => request(retained.taskId), /exceeds 100 hops/);
});
