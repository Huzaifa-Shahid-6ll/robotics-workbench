import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { TaskReview, nativeReviewHost, type ReviewSnapshot } from '../src/task-review';
import { reviewPath } from '../src/review-files';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export async function run(): Promise<void> {
  const planPath = process.env.WORKBENCH_MANUAL_CONFLICT_PLAN;
  assert.ok(planPath, 'A prepared isolated conflict plan is required.');
  const plan = JSON.parse(readFileSync(planPath, 'utf8')) as { runId: string; projectRoot: string; evidenceDirectory: string; controlPath: string; installedExtension: string; baselineText: string };
  const root = realpathSync(plan.projectRoot), sourcePath = reviewPath(root, 'NativeConflict.ino');
  const extension = vscode.extensions.getExtension('local-workbench.robotics-workbench');
  assert.ok(extension); assert.equal(realpathSync(extension.extensionPath), realpathSync(plan.installedExtension)); await extension.activate();
  assert.equal(readFileSync(sourcePath, 'utf8'), plan.baselineText);
  mkdirSync(plan.evidenceDirectory, { recursive: true });
  const snapshots = new Map<string, ReviewSnapshot>();
  let sequence = 0, finished = false;
  const store = {
    load: async (taskId: string) => structuredClone(snapshots.get(taskId) ?? null),
    save: async (taskId: string, snapshot: ReviewSnapshot) => { snapshots.set(taskId, structuredClone(snapshot)); writeFileSync(join(plan.evidenceDirectory, `review-${++sequence}-${taskId}.json`), JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx' }); }
  };
  const review = new TaskReview(store, nativeReviewHost());
  const checkpoints: unknown[] = [];
  async function checkpoint(phase: string, details: Record<string, unknown> = {}) {
    const source = readFileSync(sourcePath, 'utf8'), document = vscode.workspace.textDocuments.find(item => item.uri.scheme === 'file' && item.uri.fsPath === vscode.Uri.file(sourcePath).fsPath);
    const id = ++sequence, diskPath = join(plan.evidenceDirectory, `${id}-${phase}-saved.ino`), dirtyPath = document?.isDirty ? join(plan.evidenceDirectory, `${id}-${phase}-unsaved.ino`) : null;
    writeFileSync(diskPath, source, { flag: 'wx' }); if (dirtyPath) writeFileSync(dirtyPath, document!.getText(), { flag: 'wx' });
    const record = { taskId: 'TASK-11', screen: 'S18', runId: plan.runId, phase, occurredAt: new Date().toISOString(), evidenceClass: 'actual-native-host-synthetic-source-and-fixture-review-store',
      vscodeVersion: vscode.version, extensionVersion: extension!.packageJSON.version, root, sourcePath, savedSha256: hash(source), savedCopy: diskPath,
      editor: document ? { uri: document.uri.toString(), version: document.version, dirty: document.isDirty, textSha256: hash(document.getText()), retainedUnsavedCopy: dirtyPath } : null,
      nativeActiveEditor: vscode.window.activeTextEditor?.document.uri.toString() ?? null, details,
      manualKeyboardResult: 'not-run', narratorResult: 'not-run', limitations: ['Actual TaskReview/nativeReviewHost and VS Code editor/diff APIs. Review metadata uses an explicit fixture store retaining immutable JSON snapshots, not the production SQLite backend.', 'Synthetic source/provider writes; zero provider, compiler, serial or upload effects.', 'Root must separately record actual screenshots, keyboard observations and user Narrator reports.'] };
    checkpoints.push(record); appendFileSync(join(plan.evidenceDirectory, 'checkpoints.ndjson'), JSON.stringify(record) + '\n');
    writeFileSync(join(plan.evidenceDirectory, 'checkpoint.json'), JSON.stringify(record, null, 2) + '\n');
    writeFileSync(join(plan.evidenceDirectory, 'result.json'), JSON.stringify({ status: 'waiting-for-manual-observation', checkpoints }, null, 2) + '\n');
    console.log(`TASK11_NATIVE_CONFLICT ${phase} ${plan.evidenceDirectory}`);
  }
  async function advance(phase: string): Promise<boolean> {
    const deadline = Date.now() + 30 * 60 * 1000;
    while (Date.now() < deadline) {
      if (existsSync(plan.controlPath)) {
        assert.ok(statSync(plan.controlPath).size <= 4096, 'Fixture control exceeds its bound.');
        let command: { runId?: string; phase?: string; action?: string };
        try { command = JSON.parse(readFileSync(plan.controlPath, 'utf8')); } catch { command = {}; }
        if (command.runId === plan.runId && command.phase === phase) {
          assert.ok(command.action === 'advance' || command.action === 'finish', 'Unsupported fixture control action.');
          finished = command.action === 'finish'; return !finished;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw Error('Native conflict fixture timed out; retained source copies and snapshots remain available.');
  }
  async function closeCleanEditors() {
    assert.equal(vscode.workspace.textDocuments.some(item => item.isDirty), false, 'An unexpected dirty editor was preserved; the fixture will not close or overwrite it.');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const deadline = Date.now() + 5000;
    while (vscode.window.visibleTextEditors.some(item => item.document.uri.scheme === 'file' && item.document.uri.fsPath === vscode.Uri.file(sourcePath).fsPath)) { assert.ok(Date.now() < deadline, 'Source editor did not close before the next isolated fixture phase.'); await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  try {
    let document = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath)); await vscode.window.showTextDocument(document, { preview: false });
    const proposedTask = randomUUID(); await review.capture(proposedTask, root, vscode.workspace.textDocuments);
    await checkpoint('baseline', { taskId: proposedTask, assertions: ['Original synthetic source is unchanged.'] }); if (!await advance('baseline')) return;
    const proposed = plan.baselineText.replace('value = 1', 'value = 2');
    const proposal = await review.propose(proposedTask, root, 'NativeConflict.ino', proposed, vscode.workspace.textDocuments);
    await review.act(proposedTask, root, proposal, 'diff', vscode.workspace.textDocuments);
    assert.equal(readFileSync(sourcePath, 'utf8'), plan.baselineText);
    await checkpoint('proposed', { taskId: proposedTask, reviewId: proposal, effect: 'proposed', assertions: ['Actual native baseline/proposed diff is open.', 'No source application or upload occurred.'] }); if (!await advance('proposed')) return;
    await closeCleanEditors(); assert.equal(readFileSync(sourcePath, 'utf8'), plan.baselineText);
    const writtenPath = reviewPath(root, 'ProviderWritten.cpp', true);
    writeFileSync(writtenPath, plan.baselineText, { flag: 'wx' });
    const writtenTask = randomUUID(); await review.capture(writtenTask, root, vscode.workspace.textDocuments);
    writeFileSync(writtenPath, proposed);
    const written = (await review.list(writtenTask, root, vscode.workspace.textDocuments)).find(item => item.path === 'ProviderWritten.cpp')!;
    assert.equal(written.effect, 'written'); await review.act(writtenTask, root, written.id, 'diff', vscode.workspace.textDocuments);
    const writtenCopy = join(plan.evidenceDirectory, 'written-provider-source.cpp'); writeFileSync(writtenCopy, readFileSync(writtenPath), { flag: 'wx' });
    await checkpoint('written', { taskId: writtenTask, reviewId: written.id, effect: written.effect, writtenSource: { path: writtenPath, sha256: hash(proposed), retainedSavedCopy: writtenCopy }, assertions: ['Actual native baseline/saved-provider diff is open for the previously unopened ProviderWritten.cpp.', 'NativeConflict.ino remains unchanged; source change was injected only in this synthetic fixture.'] }); if (!await advance('written')) return;
    await closeCleanEditors(); assert.equal(readFileSync(sourcePath, 'utf8'), plan.baselineText);
    const conflictTask = randomUUID(); document = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath)); const editor = await vscode.window.showTextDocument(document, { preview: false });
    await review.capture(conflictTask, root, vscode.workspace.textDocuments);
    assert.equal(await editor.edit(builder => builder.insert(new vscode.Position(0, 0), '// Synthetic unsaved user edit retained independently.\n')), true);
    const unsaved = document.getText(); assert.equal(document.isDirty, true);
    const provider = plan.baselineText.replace('value = 1', 'value = 3') + '// Synthetic independent saved provider edit.\n';
    assert.equal(readFileSync(sourcePath, 'utf8'), plan.baselineText); writeFileSync(reviewPath(root, 'NativeConflict.ino'), provider);
    const conflict = (await review.list(conflictTask, root, vscode.workspace.textDocuments)).find(item => item.path === 'NativeConflict.ino')!;
    assert.equal(conflict.effect, 'conflicted');
    await assert.rejects(review.act(conflictTask, root, conflict.id, 'revert', vscode.workspace.textDocuments), { code: 'REVISION_CONFLICT' });
    assert.equal(document.getText(), unsaved); assert.equal(document.isDirty, true); assert.equal(readFileSync(sourcePath, 'utf8'), provider);
    await review.act(conflictTask, root, conflict.id, 'diff', vscode.workspace.textDocuments);
    void vscode.window.showWarningMessage('Synthetic S18 conflict: an actual TaskReview revert was refused. Unsaved user text and saved provider bytes both remain retained.');
    await checkpoint('conflicted', { taskId: conflictTask, reviewId: conflict.id, effect: conflict.effect, baselineSha256: conflict.baselineSha256, providerSha256: hash(provider), userBufferSha256: hash(unsaved), assertions: ['Actual native current-editor/retained-observed diff is open.', 'Actual app review rejected revert with REVISION_CONFLICT.', 'The unsaved user editor and saved provider bytes remain distinct and unchanged.'] });
    await advance('conflicted');
  } catch (error) {
    await checkpoint('failed', { error: String(error) }); void vscode.window.showErrorMessage(`Synthetic S18 fixture stopped: ${String(error)}. Current editor and saved versions were preserved.`);
    await advance('failed');
  } finally {
    await checkpoint(finished ? 'finished-preserved' : 'session-ending-preserved', { closeRequested: finished });
    review.dispose();
  }
}
