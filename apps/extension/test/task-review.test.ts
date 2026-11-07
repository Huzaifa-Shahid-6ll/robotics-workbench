import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskReview, type ReviewDocument, type ReviewSnapshot, type ReviewEdit, type ReviewHost, type RevertConfirmation, type ReviewRelocation } from '../src/task-review';
import { minimalReviewEdit, reviewHash } from '../src/review-files';

function fixture(t: TestContext) {
  const temporary = mkdtempSync(join(tmpdir(), 'workbench-review-')), root = join(temporary, 'project'); mkdirSync(root);
  const path = join(root, 'Probe.ino'), baseline = 'int value = 1;\nvoid setup() {}\nvoid loop() {}\n'; writeFileSync(path, baseline);
  const taskId = randomUUID(), snapshots = new Map<string, ReviewSnapshot>(), edits: ReviewEdit[] = [], diffs: { leftText: string; rightText: string }[] = [];
  const documents: ReviewDocument[] = [];
  let beforeEdit: (() => void) | undefined, confirmation: ((input: RevertConfirmation) => Promise<boolean>) | undefined;
  const host: ReviewHost = {
    async confirmRevert(input) { return confirmation ? confirmation(input) : true; },
    async applyEdit(edit) {
      beforeEdit?.();
      assert.equal(existsSync(edit.path) ? reviewHash(readFileSync(edit.path)) : null, edit.expectedSha256);
      const document = documents.find(item => item.uri.fsPath === edit.path);
      assert.equal(document?.isDirty ?? false, false);
      if (edit.expectedVersion !== null) assert.equal(document?.version, edit.expectedVersion);
      edits.push(edit);
      if (edit.nextText === null) unlinkSync(edit.path);
      else writeFileSync(edit.path, edit.nextText);
    },
    async showDiff(input) { diffs.push(input); }
  };
  const review = new TaskReview({ load: async id => structuredClone(snapshots.get(id) ?? null), save: async (id, snapshot) => { snapshots.set(id, structuredClone(snapshot)); } }, host);
  t.after(() => { review.dispose(); rmSync(temporary, { recursive: true, force: true }); });
  return { temporary, root, path, baseline, taskId, snapshots, edits, diffs, documents, review, host, beforeEdit: (callback: () => void) => { beforeEdit = callback; }, confirm: (callback: (input: RevertConfirmation) => Promise<boolean>) => { confirmation = callback; } };
}
async function restoredReview(t: TestContext) {
  const f = fixture(t); await f.review.capture(f.taskId, f.root, []);
  const provider = f.baseline.replace('= 1', '= 5'); writeFileSync(f.path, provider); await f.review.list(f.taskId, f.root, []);
  const retained = structuredClone(f.snapshots.get(f.taskId)!);
  const root = join(f.temporary, 'restored-project'); mkdirSync(root); const path = join(root, 'Probe.ino'); writeFileSync(path, provider);
  const saves: ReviewSnapshot[] = [], proof: ReviewRelocation = { previousRoot: f.root, root, archiveManifestSha256: 'a'.repeat(64), sourceSha256: 'b'.repeat(64), restoredAt: '2026-11-04T00:00:00.000Z', reviewArtifactId: randomUUID(), reviewSha256: reviewHash(JSON.stringify(retained)) };
  const store = { load: async () => structuredClone(f.snapshots.get(f.taskId)!), save: async (_taskId: string, snapshot: ReviewSnapshot) => { saves.push(structuredClone(snapshot)); f.snapshots.set(f.taskId, structuredClone(snapshot)); }, relocation: async () => proof as ReviewRelocation | null };
  f.host.confirmRebind = async () => true;
  const review = new TaskReview(store, f.host); t.after(() => review.dispose());
  return { ...f, restoredRoot: root, restoredPath: path, provider, retained, saves, proof, store, restoredReview: review };
}
test('restored review explicitly rebinds unchanged files while preserving original evidence and source', async t => {
  const f = await restoredReview(t);
  await assert.rejects(f.restoredReview.list(f.taskId, f.restoredRoot, []), { code: 'REVIEW_RELOCATION_REQUIRED' });
  await f.restoredReview.rebind(f.taskId, f.restoredRoot, []);
  assert.equal(f.saves.length, 1); assert.equal(f.saves[0].root, f.restoredRoot); assert.equal(f.retained.root, f.root);
  assert.equal(readFileSync(f.restoredPath, 'utf8'), f.provider); assert.deepEqual(f.edits, []);
  const row = (await f.restoredReview.list(f.taskId, f.restoredRoot, []))[0];
  await f.restoredReview.act(f.taskId, f.restoredRoot, row.id, 'diff', []);
  assert.equal(f.diffs[0].leftText, f.baseline); assert.equal(f.diffs[0].rightText, f.provider);
});
test('missing restore proof, changed file and dirty restored buffer block review rebind without overwrites', async t => {
  const f = await restoredReview(t); f.store.relocation = async () => null;
  await assert.rejects(f.restoredReview.rebind(f.taskId, f.restoredRoot, []), { code: 'REVISION_CONFLICT' });
  f.store.relocation = async () => f.proof; writeFileSync(f.restoredPath, f.provider + '// user edit\n');
  await assert.rejects(f.restoredReview.rebind(f.taskId, f.restoredRoot, []), { code: 'REVISION_CONFLICT' });
  writeFileSync(f.restoredPath, f.provider);
  const document = { uri: { scheme: 'file', fsPath: f.restoredPath }, version: 12, isDirty: true, getText: () => f.provider + '// unsaved user\n' };
  await assert.rejects(f.restoredReview.rebind(f.taskId, f.restoredRoot, [document]), { code: 'REVISION_CONFLICT' });
  assert.equal(f.saves.length, 0); assert.deepEqual(f.snapshots.get(f.taskId), f.retained); assert.deepEqual(f.edits, []);
});
test('rebind confirmation cancellation and concurrent edits preserve prior snapshot and both source versions', async t => {
  const f = await restoredReview(t); f.host.confirmRebind = async () => false;
  await assert.rejects(f.restoredReview.rebind(f.taskId, f.restoredRoot, []), { code: 'REVIEW_CANCELLED' });
  f.host.confirmRebind = async () => { writeFileSync(f.restoredPath, '// independent saved edit\n'); return true; };
  await assert.rejects(f.restoredReview.rebind(f.taskId, f.restoredRoot, []), { code: 'REVISION_CONFLICT' });
  assert.equal(readFileSync(f.restoredPath, 'utf8'), '// independent saved edit\n'); assert.equal(f.retained.files[0].observedText, f.provider);
  assert.equal(f.saves.length, 0); assert.deepEqual(f.snapshots.get(f.taskId), f.retained); assert.deepEqual(f.edits, []);
});
test('review rebind validates multi-hop origin continuity before accepting restored files', async t => {
  const f = await restoredReview(t), middle = join(f.temporary, 'intermediate-project');
  const metadata = { archiveManifestSha256: f.proof.archiveManifestSha256, sourceSha256: f.proof.sourceSha256, restoredAt: f.proof.restoredAt };
  f.proof.restorationChain = [{ previousRoot: f.root, root: middle, ...metadata }, { previousRoot: join(f.temporary, 'unrelated'), root: f.restoredRoot, ...metadata }];
  await assert.rejects(f.restoredReview.rebind(f.taskId, f.restoredRoot, []), { code: 'REVISION_CONFLICT' }); assert.equal(f.saves.length, 0);
  f.proof.restorationChain[1].previousRoot = middle;
  await f.restoredReview.rebind(f.taskId, f.restoredRoot, []);
  assert.equal(f.saves.length, 1); assert.equal(f.saves[0].root, f.restoredRoot); assert.equal(readFileSync(f.restoredPath, 'utf8'), f.provider); assert.deepEqual(f.edits, []);
});
test('written changes use retained native diff and exact reviewed bytes for minimal source revert', async t => {
  const f = fixture(t); await f.review.capture(f.taskId, f.root, []);
  const provider = f.baseline.replace('= 1', '= 2'); writeFileSync(f.path, provider);
  const [row] = await f.review.list(f.taskId, f.root, []); assert.equal(row.effect, 'written');
  await f.review.act(f.taskId, f.root, row.id, 'diff', []); assert.deepEqual(f.diffs[0], { title: 'Task change: Probe.ino', leftText: f.baseline, rightText: provider });
  assert.deepEqual(minimalReviewEdit(provider, f.baseline), { start: 12, end: 13, text: '1' });
  await f.review.act(f.taskId, f.root, row.id, 'revert', []); assert.equal(readFileSync(f.path, 'utf8'), f.baseline); assert.equal(f.edits.length, 1);
  assert.equal((await f.review.list(f.taskId, f.root, []))[0].effect, 'reverted');
});
test('dirty user buffer and provider disk edit preserve both and refuse source mutation', async t => {
  const f = fixture(t); let visible = f.baseline; const document = { uri: { scheme: 'file', fsPath: f.path }, version: 1, isDirty: false, getText: () => visible }; f.documents.push(document);
  await f.review.capture(f.taskId, f.root, f.documents);
  visible = '// unsaved user change\n' + f.baseline; document.version++; document.isDirty = true;
  const provider = f.baseline.replace('= 1', '= 7'); writeFileSync(f.path, provider);
  const [row] = await f.review.list(f.taskId, f.root, f.documents); assert.equal(row.effect, 'conflicted');
  await f.review.act(f.taskId, f.root, row.id, 'diff', f.documents);
  assert.deepEqual(f.diffs[0], { title: 'Source conflict: Probe.ino', leftText: visible, rightText: provider, leftLabel: 'current-editor', rightLabel: 'retained-observed' });
  await assert.rejects(f.review.act(f.taskId, f.root, row.id, 'revert', f.documents), { code: 'REVISION_CONFLICT' });
  assert.equal(visible.startsWith('// unsaved user'), true); assert.equal(readFileSync(f.path, 'utf8'), provider); assert.equal(f.edits.length, 0);
});
test('saved user changes after observation cannot be overwritten by an old baseline', async t => {
  const f = fixture(t); await f.review.capture(f.taskId, f.root, []);
  writeFileSync(f.path, f.baseline.replace('= 1', '= 2')); const [row] = await f.review.list(f.taskId, f.root, []);
  const user = readFileSync(f.path, 'utf8') + '// independent saved edit\n'; writeFileSync(f.path, user);
  await f.review.act(f.taskId, f.root, row.id, 'diff', []);
  assert.deepEqual(f.diffs[0], { title: 'Source conflict: Probe.ino', leftText: user, rightText: f.baseline.replace('= 1', '= 2'), leftLabel: 'current-saved', rightLabel: 'retained-observed' });
  await assert.rejects(f.review.act(f.taskId, f.root, row.id, 'revert', []), { code: 'REVISION_CONFLICT' });
  assert.equal(readFileSync(f.path, 'utf8'), user); assert.equal(f.edits.length, 0);
});
test('proposed source has Apply/Dismiss semantics and never changes source before acceptance', async t => {
  const f = fixture(t); await f.review.capture(f.taskId, f.root, []);
  const proposed = f.baseline.replace('= 1', '= 3'); const id = await f.review.propose(f.taskId, f.root, 'Probe.ino', proposed, []);
  assert.equal(readFileSync(f.path, 'utf8'), f.baseline); assert.equal((await f.review.list(f.taskId, f.root, []))[0].effect, 'proposed');
  await assert.rejects(f.review.act(f.taskId, f.root, id, 'keep', []), { code: 'INVALID_REQUEST' });
  await f.review.act(f.taskId, f.root, id, 'apply', []); assert.equal(readFileSync(f.path, 'utf8'), proposed);
  assert.equal((await f.review.list(f.taskId, f.root, []))[0].summary.includes('Unapplied'), false);
  const second = randomUUID(); await f.review.capture(second, f.root, []); const dismissed = await f.review.propose(second, f.root, 'Probe.ino', f.baseline, []);
  await f.review.act(second, f.root, dismissed, 'dismiss', []); assert.equal(readFileSync(f.path, 'utf8'), proposed);
  assert.equal((await f.review.list(second, f.root, []))[0].summary, 'Proposal dismissed; source was not changed.');
});
test('added and deleted task files are reversible only at their exact reviewed state', async t => {
  const f = fixture(t); await f.review.capture(f.taskId, f.root, []);
  const added = join(f.root, 'Added.h'); writeFileSync(added, 'int added = 1;\n'); unlinkSync(f.path);
  const rows = await f.review.list(f.taskId, f.root, []);
  const addition = rows.find(item => item.path === 'Added.h')!, deletion = rows.find(item => item.path === 'Probe.ino')!;
  await f.review.act(f.taskId, f.root, addition.id, 'revert', []); assert.equal(existsSync(added), false);
  await f.review.act(f.taskId, f.root, deletion.id, 'revert', []); assert.equal(readFileSync(f.path, 'utf8'), f.baseline);
});
test('review excludes credentials, binary/oversized text and linked paths without changing bytes', async t => {
  const f = fixture(t); writeFileSync(join(f.root, 'auth.json'), '{"password":"synthetic-private-value"}');
  writeFileSync(join(f.root, 'binary.cpp'), Buffer.from([1, 0, 2])); writeFileSync(join(f.root, 'large.h'), 'x'.repeat(128 * 1024 + 1));
  mkdirSync(join(f.root, '.codex')); writeFileSync(join(f.root, '.codex', 'config.json'), '{"private":"do not read"}');
  const outside = join(f.temporary, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'Outside.ino'), 'do not read'); symlinkSync(outside, join(f.root, 'linked'), 'junction');
  await f.review.capture(f.taskId, f.root, []); const rows = await f.review.list(f.taskId, f.root, []);
  assert.ok(rows.some(item => item.path === 'auth.json' && item.effect === 'conflicted'));
  assert.ok(rows.some(item => item.path === 'binary.cpp')); assert.ok(rows.some(item => item.path === 'large.h')); assert.ok(rows.some(item => item.path === 'linked'));
  assert.ok(rows.some(item => item.path === '.codex')); assert.equal(JSON.stringify(f.snapshots.get(f.taskId)).includes('do not read'), false);
  assert.equal(JSON.stringify(f.snapshots.get(f.taskId)).includes('synthetic-private-value'), false);
  await assert.rejects(f.review.propose(f.taskId, f.root, '../outside/Outside.ino', 'bad', []), { code: 'UNAUTHORIZED_SCOPE' });
  await assert.rejects(f.review.propose(f.taskId, f.root, '.env.local', 'not a source file', []), { code: 'UNAUTHORIZED_SCOPE' });
  await assert.rejects(f.review.propose(f.taskId, f.root, '.git/config', 'not a source file', []), { code: 'UNAUTHORIZED_SCOPE' });
  assert.equal(readFileSync(join(outside, 'Outside.ino'), 'utf8'), 'do not read');
});
test('tampered persisted review identity or content is refused before a file mutation', async t => {
  const f = fixture(t); await f.review.capture(f.taskId, f.root, []);
  const snapshot = f.snapshots.get(f.taskId)!; snapshot.files[0].baselineText = 'different';
  await assert.rejects(f.review.list(f.taskId, f.root, []), { code: 'ARTIFACT_MISMATCH' });
  assert.equal(readFileSync(f.path, 'utf8'), f.baseline);
});
test('manifest revert creates a new design revision and does not roll back physical state', async t => {
  const f = fixture(t), manifestPath = join(f.root, 'workbench.json');
  const manifest = JSON.parse(readFileSync('examples/workbench.valid.json', 'utf8')); writeFileSync(manifestPath, JSON.stringify(manifest));
  await f.review.capture(f.taskId, f.root, []); manifest.projectRevision++; manifest.name = 'Provider changed name'; writeFileSync(manifestPath, JSON.stringify(manifest));
  const row = (await f.review.list(f.taskId, f.root, [])).find(item => item.path === 'workbench.json')!;
  await f.review.act(f.taskId, f.root, row.id, 'revert', []);
  const reverted = JSON.parse(readFileSync(manifestPath, 'utf8')); assert.equal(reverted.projectRevision, 3); assert.notEqual(reverted.name, manifest.name);
  assert.equal(f.edits.length, 1);
});
test('unverified writer changes require exact diff confirmation and decline preserves all bytes', async t => {
  const f = fixture(t); await f.review.capture(f.taskId, f.root, []);
  const userBeforeObservation = f.baseline + '// saved user change before first review\n'; writeFileSync(f.path, userBeforeObservation);
  const [row] = await f.review.list(f.taskId, f.root, []); assert.ok(row.summary.includes('writer unverified'));
  f.confirm(async input => {
    assert.equal(f.diffs.at(-1)?.rightText, userBeforeObservation); assert.equal(f.diffs.at(-1)?.leftText, f.baseline);
    assert.equal(input.path, f.path); assert.equal(input.baselineSha256, reviewHash(f.baseline)); assert.equal(input.observedSha256, reviewHash(userBeforeObservation));
    return false;
  });
  await assert.rejects(f.review.act(f.taskId, f.root, row.id, 'revert', []), { code: 'REVIEW_CANCELLED' });
  assert.equal(readFileSync(f.path, 'utf8'), userBeforeObservation); assert.equal(f.edits.length, 0);
});
test('a host without revert confirmation cannot silently restore old source', async t => {
  const f = fixture(t); delete f.host.confirmRevert; await f.review.capture(f.taskId, f.root, []);
  const observed = f.baseline.replace('= 1', '= 9'); writeFileSync(f.path, observed); const [row] = await f.review.list(f.taskId, f.root, []);
  await assert.rejects(f.review.act(f.taskId, f.root, row.id, 'revert', []), { code: 'REVIEW_CANCELLED' });
  assert.equal(readFileSync(f.path, 'utf8'), observed); assert.equal(f.edits.length, 0);
});
test('saved changes while revert confirmation is open stop the edit', async t => {
  const f = fixture(t); await f.review.capture(f.taskId, f.root, []); writeFileSync(f.path, f.baseline.replace('= 1', '= 8'));
  const [row] = await f.review.list(f.taskId, f.root, []), saved = readFileSync(f.path, 'utf8') + '// changed during confirmation\n';
  f.confirm(async () => { writeFileSync(f.path, saved); return true; });
  await assert.rejects(f.review.act(f.taskId, f.root, row.id, 'revert', []), { code: 'REVISION_CONFLICT' });
  assert.equal(readFileSync(f.path, 'utf8'), saved); assert.equal(f.edits.length, 0);
});
test('an editor changed while revert confirmation is open is preserved without saving over disk', async t => {
  const f = fixture(t); await f.review.capture(f.taskId, f.root, []); const observed = f.baseline.replace('= 1', '= 6'); writeFileSync(f.path, observed);
  const [row] = await f.review.list(f.taskId, f.root, []); let visible = observed;
  const document = { uri: { scheme: 'file', fsPath: f.path }, version: 1, isDirty: false, getText: () => visible }; f.documents.push(document);
  f.confirm(async () => { visible += '// user typing during confirmation\n'; document.version++; document.isDirty = true; return true; });
  await assert.rejects(f.review.act(f.taskId, f.root, row.id, 'revert', f.documents), { code: 'REVISION_CONFLICT' });
  assert.equal(readFileSync(f.path, 'utf8'), observed); assert.ok(visible.includes('user typing')); assert.equal(f.edits.length, 0);
});
