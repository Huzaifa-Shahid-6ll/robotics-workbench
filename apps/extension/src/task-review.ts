import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { WorkbenchError, isRequestId, isReviewSnapshot, validateManifest, type ReviewViewItem } from '@robotics-workbench/contracts';
import { assertSafeAgentText } from '@robotics-workbench/application';
import { assertManifestSemantics } from '@robotics-workbench/domain';
import { minimalReviewEdit, reviewHash, reviewInventory, reviewPath, reviewText, REVIEW_FILE_BYTES } from './review-files';

export interface ReviewDocument { uri: { scheme: string; fsPath: string }; version: number; isDirty: boolean; getText(): string }
interface DocumentState { version: number; dirty: boolean; textSha256: string }
export interface ReviewFile {
  id: string; path: string; baselineText: string | null; baselineSha256: string | null;
  baselineHost: DocumentState | null; observedText?: string | null; observedSha256?: string | null;
  observedHost?: DocumentState | null; proposedText?: string;
  effect: ReviewViewItem['effect']; conflict: string | null;
}
export interface ReviewSnapshot {
  schemaVersion: 1; taskId: string; root: string; files: ReviewFile[];
  omitted: { id: string; path: string; reason: string }[];
}
export interface ReviewRelocation { previousRoot: string; root: string; archiveManifestSha256: string; sourceSha256: string; restoredAt: string; reviewArtifactId: string; reviewSha256: string; restorationChain?: { previousRoot: string; root: string; archiveManifestSha256: string; sourceSha256: string; restoredAt: string }[] }
export interface ReviewStore { load(taskId: string): Promise<ReviewSnapshot | null>; save(taskId: string, snapshot: ReviewSnapshot): Promise<void>; relocation?(taskId: string): Promise<ReviewRelocation | null> }
export interface ReviewEdit { root: string; path: string; expectedSha256: string | null; expectedVersion: number | null; currentText: string | null; nextText: string | null }
export interface RevertConfirmation { path: string; baselineSha256: string | null; observedSha256: string | null }
export interface ReviewHost {
  applyEdit(input: ReviewEdit): Promise<void>;
  showDiff(input: { title: string; leftText: string; rightText: string; leftLabel?: string; rightLabel?: string }): Promise<void>;
  confirmRevert?(input: RevertConfirmation): Promise<boolean>;
  confirmRebind?(input: ReviewRelocation & { taskId: string }): Promise<boolean>;
  dispose?(): void;
}
const SNAPSHOT_BYTES = 512 * 1024;
function conflict(message: string): never { throw new WorkbenchError('REVISION_CONFLICT', message); }
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function documentState(root: string, path: string, documents: readonly ReviewDocument[]): DocumentState | null {
  const full = reviewPath(root, path, true).toLowerCase();
  const document = documents.find(item => item.uri.scheme === 'file' && item.uri.fsPath.toLowerCase() === full);
  return document ? { version: document.version, dirty: document.isDirty, textSha256: reviewHash(document.getText()) } : null;
}
function checked(snapshot: ReviewSnapshot, taskId: string, root: string): ReviewSnapshot {
  if (!isReviewSnapshot(snapshot) || snapshot.taskId !== taskId || Buffer.byteLength(JSON.stringify(snapshot)) > SNAPSHOT_BYTES) throw new WorkbenchError('INVALID_REQUEST', 'Stored review snapshot is invalid, oversized or belongs to another task/project.');
  if (snapshot.root.toLowerCase() !== realpathSync(root).toLowerCase()) throw new WorkbenchError('REVIEW_RELOCATION_REQUIRED', 'Retained review belongs to the original project location. Use Robotics: Review Task Changes to review and explicitly rebind its restored files.');
  const ids = new Set<string>(), paths = new Set<string>();
  for (const file of snapshot.files) {
    reviewPath(root, file.path, true);
    if (!isRequestId(file.id) || ids.has(file.id) || paths.has(file.path.toLowerCase()) || !['proposed', 'written', 'conflicted', 'kept', 'reverted'].includes(file.effect)) throw new WorkbenchError('INVALID_REQUEST', 'Stored review identity or effect is invalid.');
    ids.add(file.id); paths.add(file.path.toLowerCase());
    for (const [text, hash] of [[file.baselineText, file.baselineSha256], [file.observedText, file.observedSha256]] as const) {
      if (text !== undefined && (text === null ? hash !== null : typeof text !== 'string' || Buffer.byteLength(text) > REVIEW_FILE_BYTES || hash !== reviewHash(text))) throw new WorkbenchError('ARTIFACT_MISMATCH', 'Retained review bytes do not match their identity.');
    }
    if (file.proposedText !== undefined && (typeof file.proposedText !== 'string' || Buffer.byteLength(file.proposedText) > REVIEW_FILE_BYTES)) throw new WorkbenchError('INVALID_REQUEST', 'Proposed source exceeds the review bound.');
  }
  assertSafeAgentText(JSON.stringify(snapshot)); return structuredClone(snapshot);
}

/** Only task-owned, unchanged text is reversible; conflicts retain both versions. */
export class TaskReview {
  private readonly host: ReviewHost;
  constructor(private readonly store: ReviewStore, host?: ReviewHost) { this.host = host ?? nativeReviewHost(); }
  private async load(taskId: string, root: string): Promise<ReviewSnapshot> {
    if (!isRequestId(taskId)) throw new WorkbenchError('INVALID_REQUEST', 'Expected a task UUID.');
    const snapshot = await this.store.load(taskId);
    if (!snapshot) throw new WorkbenchError('NOT_FOUND', 'This task has no retained review baseline.');
    return checked(snapshot, taskId, root);
  }
  private async save(snapshot: ReviewSnapshot): Promise<void> { checked(snapshot, snapshot.taskId, snapshot.root); await this.store.save(snapshot.taskId, snapshot); }
  async rebind(taskId: string, root: string, documents: readonly ReviewDocument[]): Promise<void> {
    const nextRoot = realpathSync(root);
    const inspect = async () => {
      const snapshot = await this.store.load(taskId), proof = await this.store.relocation?.(taskId);
      if (!isReviewSnapshot(snapshot) || snapshot.taskId !== taskId || !proof || proof.previousRoot !== snapshot.root || !isAbsolute(proof.previousRoot) || proof.root !== nextRoot || !isRequestId(proof.reviewArtifactId) || ![proof.reviewSha256, proof.archiveManifestSha256, proof.sourceSha256].every(value => /^[a-f0-9]{64}$/.test(value)) || !Number.isFinite(Date.parse(proof.restoredAt)) || reviewHash(JSON.stringify(snapshot)) !== proof.reviewSha256) conflict('No matching immutable backup-restoration proof is available for this retained review. Original versions remain preserved.');
      if (proof.restorationChain !== undefined) {
        if (!Array.isArray(proof.restorationChain) || !proof.restorationChain.length || proof.restorationChain.length > 100) conflict('Invalid bounded restore ancestry.');
        let previous = proof.previousRoot; const seen = new Set([previous.toLowerCase()]);
        for (const hop of proof.restorationChain) {
          if (!hop || hop.previousRoot !== previous || !isAbsolute(hop.root ?? '') || seen.has(hop.root.toLowerCase()) || ![hop.archiveManifestSha256, hop.sourceSha256].every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)) || !Number.isFinite(Date.parse(hop.restoredAt))) conflict('Restore ancestry is broken or repeats a root.');
          seen.add(hop.root.toLowerCase()); previous = hop.root;
        }
        const last = proof.restorationChain.at(-1)!;
        if (previous !== proof.root || last.archiveManifestSha256 !== proof.archiveManifestSha256 || last.sourceSha256 !== proof.sourceSha256 || last.restoredAt !== proof.restoredAt) conflict('Restore ancestry does not terminate at this project and archive identity.');
      }
      const next = checked({ ...snapshot, root: nextRoot }, taskId, nextRoot);
      for (const file of next.files) {
        const current = reviewText(nextRoot, file.path), host = documentState(nextRoot, file.path, documents);
        const expected = file.effect === 'reverted' ? file.baselineSha256 : file.effect === 'kept' && file.proposedText !== undefined ? reviewHash(file.proposedText) : file.observedSha256 === undefined ? file.baselineSha256 : file.observedSha256;
        if ((current?.sha256 ?? null) !== expected || host?.dirty || host && host.textSha256 !== current?.sha256) conflict('Restored source or an editor buffer changed from the retained review. Both versions remain intact; reconcile them before rebinding.');
        if (file.observedSha256 === undefined) file.baselineHost = host;
        else file.observedHost = host;
      }
      return { next, proof };
    };
    const initial = await inspect();
    if (!await this.host.confirmRebind?.({ ...initial.proof, taskId })) throw new WorkbenchError('REVIEW_CANCELLED', 'Review rebind was not confirmed; retained snapshots and source are unchanged.');
    const current = await inspect();
    if (!same(initial, current)) conflict('Restored source, editor or proof changed during confirmation. No review snapshot was rebound.');
    await this.save(current.next);
  }
  async capture(taskId: string, root: string, documents: readonly ReviewDocument[]): Promise<void> {
    if (!isRequestId(taskId)) throw new WorkbenchError('INVALID_REQUEST', 'Expected a task UUID.');
    const existing = await this.store.load(taskId); if (existing) { checked(existing, taskId, root); return; }
    const inventory = reviewInventory(root);
    const snapshot: ReviewSnapshot = { schemaVersion: 1, taskId, root: realpathSync(root), files: [], omitted: inventory.omitted.map(item => ({ id: randomUUID(), ...item })) };
    for (const path of inventory.paths) {
      try {
        const baseline = reviewText(root, path); if (!baseline) continue;
        const item: ReviewFile = { id: randomUUID(), path, baselineText: baseline.text, baselineSha256: baseline.sha256, baselineHost: documentState(root, path, documents), effect: 'written', conflict: null };
        if (Buffer.byteLength(JSON.stringify(snapshot)) + Buffer.byteLength(JSON.stringify(item)) > 180 * 1024) throw new WorkbenchError('INVALID_REQUEST', 'Baseline budget reached; this file remains outside automatic review.');
        snapshot.files.push(item);
      } catch (error) { if (snapshot.omitted.length < 100) snapshot.omitted.push({ id: randomUUID(), path, reason: error instanceof WorkbenchError ? error.message : 'Source could not be captured; inspect it separately.' }); }
    }
    await this.save(snapshot);
  }
  async list(taskId: string, root: string, documents: readonly ReviewDocument[]): Promise<ReviewViewItem[]> {
    const snapshot = await this.load(taskId, root); const before = JSON.stringify(snapshot);
    const inventory = reviewInventory(root);
    for (const path of inventory.paths) if (!snapshot.files.some(file => file.path.toLowerCase() === path.toLowerCase()) && !snapshot.omitted.some(file => file.path === path)) {
      try {
        const current = reviewText(root, path); if (!current) continue;
        const item: ReviewFile = { id: randomUUID(), path, baselineText: null, baselineSha256: null, baselineHost: null, observedText: current.text, observedSha256: current.sha256, observedHost: documentState(root, path, documents), effect: 'written', conflict: null };
        if (Buffer.byteLength(JSON.stringify(snapshot)) + Buffer.byteLength(JSON.stringify(item)) > 480 * 1024) throw Error();
        snapshot.files.push(item);
      } catch { if (snapshot.omitted.length < 100) snapshot.omitted.push({ id: randomUUID(), path, reason: 'Added file is outside bounded text review; its bytes remain untouched.' }); }
    }
    const rows: ReviewViewItem[] = [];
    for (const file of snapshot.files) {
      let current: ReturnType<typeof reviewText>;
      try { current = reviewText(root, file.path); }
      catch { file.effect = 'conflicted'; file.conflict = 'Current file cannot be read safely; retained versions remain available.'; current = null; }
      const host = documentState(root, file.path, documents);
      if (file.baselineHost && host && host.version !== file.baselineHost.version && file.observedSha256 === undefined) { file.effect = 'conflicted'; file.conflict = 'The host document changed since task admission; retained disk and editor versions require explicit reconciliation.'; }
      if (file.observedSha256 === undefined && current?.sha256 !== file.baselineSha256 || file.observedSha256 === undefined && current === null && file.baselineSha256 !== null) {
        const candidate = { ...file, observedText: current?.text ?? null, observedSha256: current?.sha256 ?? null, observedHost: host };
        if (Buffer.byteLength(JSON.stringify(snapshot)) + Buffer.byteLength(JSON.stringify(candidate)) > 480 * 1024) { file.effect = 'conflicted'; file.conflict = 'Changed text exceeds the retained review budget; inspect externally.'; }
        else Object.assign(file, candidate);
      }
      if (file.observedSha256 !== undefined && !['kept', 'reverted'].includes(file.effect) && (current?.sha256 ?? null) !== file.observedSha256) { file.effect = 'conflicted'; file.conflict = 'Source changed after the reviewed observed version; current and retained bytes were preserved.'; }
      if (host?.dirty || file.observedSha256 !== undefined && file.observedHost && !same(host, file.observedHost)) { file.effect = 'conflicted'; file.conflict = 'An editor buffer changed or has unsaved content; resolve the native diff without overwriting either version.'; }
      if (host && current && host.textSha256 !== current.sha256) { file.effect = 'conflicted'; file.conflict = 'Visible editor and saved source differ; both versions require explicit reconciliation.'; }
      if (file.observedSha256 === undefined && file.proposedText === undefined && file.effect !== 'conflicted') continue;
      rows.push({ id: file.id, path: file.path, effect: file.effect, baselineSha256: file.baselineSha256, currentSha256: current?.sha256 ?? null, summary: file.conflict ?? (file.effect === 'kept' ? 'Source edits accepted; source acceptance does not upload firmware.' : file.effect === 'reverted' ? file.proposedText !== undefined ? 'Proposal dismissed; source was not changed.' : 'Source reverted; reverting source does not restore device firmware or physical wiring.' : file.proposedText !== undefined ? 'Unapplied source proposal; acceptance does not upload firmware.' : file.baselineText === null ? 'Added file observed during task; writer unverified.' : file.observedText === null ? 'Deleted file observed during task; writer unverified.' : 'Source changes observed during task; writer unverified. Revert requires review and confirmation of all shown changes.') });
    }
    rows.push(...snapshot.omitted.map(item => ({ id: item.id, path: item.path, effect: 'conflicted' as const, baselineSha256: null, currentSha256: null, summary: item.reason })));
    if (JSON.stringify(snapshot) !== before) await this.save(snapshot);
    return rows;
  }
  async propose(taskId: string, root: string, path: string, text: string, documents: readonly ReviewDocument[]): Promise<string> {
    if (Buffer.byteLength(text) > REVIEW_FILE_BYTES) throw new WorkbenchError('INVALID_REQUEST', 'Proposal exceeds the bounded file size.');
    assertSafeAgentText(text); reviewPath(root, path, true);
    const snapshot = await this.load(taskId, root);
    if (snapshot.omitted.some(item => item.path === path)) throw new WorkbenchError('CAPABILITY_UNSUPPORTED', 'This file was excluded from automatic review.');
    let file = snapshot.files.find(item => item.path === path);
    if (!file) { const current = reviewText(root, path); file = { id: randomUUID(), path, baselineText: current?.text ?? null, baselineSha256: current?.sha256 ?? null, baselineHost: documentState(root, path, documents), effect: 'proposed', conflict: null }; snapshot.files.push(file); }
    if (file.observedSha256 !== undefined || file.proposedText !== undefined) conflict('This file already has a task change; inspect it before another proposal.');
    file.proposedText = text; file.effect = 'proposed'; await this.save(snapshot); return file.id;
  }
  async act(taskId: string, root: string, id: string, action: 'diff' | 'keep' | 'revert' | 'apply' | 'dismiss', documents: readonly ReviewDocument[]): Promise<void> {
    await this.list(taskId, root, documents); const snapshot = await this.load(taskId, root);
    const file = snapshot.files.find(item => item.id === id);
    if (!file) throw new WorkbenchError('NOT_FOUND', 'This review item has no retained text versions.');
    if (action === 'diff') {
      if (file.effect === 'conflicted') {
        const path = reviewPath(root, file.path, true).toLowerCase();
        const editor = documents.find(document => document.uri.scheme === 'file' && document.uri.fsPath.toLowerCase() === path);
        const current = editor ? editor.getText() : reviewText(root, file.path)?.text ?? null;
        if (current !== null) {
          if (Buffer.byteLength(current) > REVIEW_FILE_BYTES) throw new WorkbenchError('INVALID_REQUEST', 'Current text exceeds the diff preview limit. Inspect the current source in its ordinary editor.');
          assertSafeAgentText(current);
        }
        const retained = file.proposedText !== undefined ? 'proposed' : file.observedText !== undefined ? 'observed' : 'baseline';
        await this.host.showDiff({ title: `Source conflict: ${file.path}`, leftText: current ?? '', rightText: (file.proposedText ?? (file.observedText === undefined ? file.baselineText : file.observedText)) ?? '', leftLabel: editor ? 'current-editor' : current === null ? 'current-file-absent' : 'current-saved', rightLabel: `retained-${retained}` });
      } else await this.host.showDiff({ title: `Task change: ${file.path}`, leftText: file.baselineText ?? '', rightText: file.proposedText ?? file.observedText ?? '' });
      return;
    }
    if (file.effect === 'conflicted') conflict(file.conflict ?? 'Review conflict must be resolved before changing source.');
    if (action === 'keep' || action === 'dismiss') {
      if (action === 'keep' && file.effect !== 'written' || action === 'dismiss' && file.effect !== 'proposed') throw new WorkbenchError('INVALID_REQUEST', 'Review action does not match the change effect.');
      file.effect = action === 'keep' ? 'kept' : 'reverted'; await this.save(snapshot); return;
    }
    if (action === 'apply' && file.effect !== 'proposed' || action === 'revert' && file.effect !== 'written') throw new WorkbenchError('INVALID_REQUEST', 'Review action does not match the change effect.');
    const current = reviewText(root, file.path), host = documentState(root, file.path, documents);
    const expectedSha256 = action === 'apply' ? file.baselineSha256 : file.observedSha256 ?? null;
    const expectedHost = action === 'apply' ? file.baselineHost : file.observedHost;
    if ((current?.sha256 ?? null) !== expectedSha256 || host?.dirty || host && current && host.textSha256 !== current.sha256 || expectedHost && !same(host, expectedHost)) conflict('Current source/editor differs from the reviewed baseline; both versions remain intact.');
    if (action === 'revert') {
      await this.host.showDiff({ title: `Review all changes before reverting: ${file.path}`, leftText: file.baselineText ?? '', rightText: file.observedText ?? '' });
      if (!await this.host.confirmRevert?.({ path: reviewPath(root, file.path, true), baselineSha256: file.baselineSha256, observedSha256: file.observedSha256 ?? null })) throw new WorkbenchError('REVIEW_CANCELLED', 'Source revert was not confirmed; current and retained versions are unchanged.');
      const confirmed = reviewText(root, file.path), confirmedHost = documentState(root, file.path, documents);
      if ((confirmed?.sha256 ?? null) !== expectedSha256 || confirmedHost?.dirty || !same(confirmedHost, host)) conflict('Source or editor changed during revert confirmation; no source edit was applied.');
    }
    let nextText = action === 'apply' ? file.proposedText! : file.baselineText;
    if (file.path === 'workbench.json' && current && nextText !== null) {
      let prior: ReturnType<typeof validateManifest>, next: ReturnType<typeof validateManifest>;
      try { prior = validateManifest(JSON.parse(current.text)); next = validateManifest(JSON.parse(nextText)); } catch { conflict('Manifest review requires valid current and proposed source; both original texts remain intact.'); }
      if (prior.projectId !== next.projectId) conflict('Manifest review cannot replace the project identity.');
      next.projectRevision = prior.projectRevision + 1; assertManifestSemantics(next);
      nextText = nextText.replace(/("projectRevision"\s*:\s*)\d+/, `$1${next.projectRevision}`);
    }
    await this.host.applyEdit({ root: snapshot.root, path: reviewPath(root, file.path, true), expectedSha256, expectedVersion: host?.version ?? null, currentText: current?.text ?? null, nextText });
    const after = reviewText(root, file.path);
    if ((after?.sha256 ?? null) !== (nextText === null ? null : reviewHash(nextText))) conflict('Source changed during the host edit; inspect the actual file and retained versions.');
    file.effect = action === 'apply' ? 'kept' : 'reverted'; await this.save(snapshot);
  }
  dispose(): void { this.host.dispose?.(); }
}

export function nativeReviewHost(confirmRevert?: ReviewHost['confirmRevert']): ReviewHost {
  let registration: { dispose(): void } | undefined;
  const contents = new Map<string, string>(), scheme = `robotics-review-${randomUUID()}`;
  return {
    async confirmRebind(input) {
      const vscode = await import('vscode');
      const action = 'Rebind retained review';
      return await vscode.window.showWarningMessage(`Rebind task ${input.taskId} to this restored project?`, { modal: true, detail: `Original location: ${input.previousRoot}\nRestored location: ${input.root}\nVerified restore hops: ${input.restorationChain?.length ?? 1}\nRestored at: ${input.restoredAt}\nRetained review SHA-256: ${input.reviewSha256}\n\nEvery retained file matches its recorded bytes and has no dirty editor conflict. This appends a new review snapshot; original evidence stays retained. No source, firmware or physical wiring changes.` }, action) === action;
    },
    async confirmRevert(input) {
      if (confirmRevert) return confirmRevert(input);
      const vscode = await import('vscode');
      const action = 'Revert shown changes';
      const selected = await vscode.window.showWarningMessage(`Revert all shown source changes in ${input.path}?`, {
        modal: true,
        detail: `Writer unverified. This reverts every change shown in the retained diff, including any user changes present in that version.\n\nBaseline SHA-256: ${input.baselineSha256 ?? '[file absent]'}\nObserved SHA-256: ${input.observedSha256 ?? '[file absent]'}\n\nBoth retained versions remain available. Source revert does not restore device firmware or physical wiring.`
      }, action);
      return selected === action;
    },
    async showDiff(input) {
      const vscode = await import('vscode');
      registration ??= vscode.workspace.registerTextDocumentContentProvider(scheme, { provideTextDocumentContent: uri => contents.get(uri.toString()) ?? 'Retained review content is unavailable.' });
      const leftLabel = input.leftLabel ?? 'baseline', rightLabel = input.rightLabel ?? 'reviewed';
      const id = reviewHash(`${input.title}\0${leftLabel}\0${input.leftText}\0${rightLabel}\0${input.rightText}`), left = vscode.Uri.parse(`${scheme}:/${id}/${leftLabel}`), right = vscode.Uri.parse(`${scheme}:/${id}/${rightLabel}`);
      contents.set(left.toString(), input.leftText); contents.set(right.toString(), input.rightText);
      while (contents.size > 200) contents.delete(contents.keys().next().value!);
      await vscode.commands.executeCommand('vscode.diff', left, right, input.title);
    },
    async applyEdit(input) {
      const vscode = await import('vscode'), uri = vscode.Uri.file(input.path);
      const path = relative(input.root, input.path).replaceAll('\\', '/');
      const disk = () => reviewText(input.root, path)?.sha256 ?? null;
      if (disk() !== input.expectedSha256) conflict('Saved source changed immediately before host edit.');
      if (input.currentText === null) {
        if (input.nextText === null) return;
        const edit = new vscode.WorkspaceEdit(); edit.createFile(uri, { overwrite: false }); edit.insert(uri, new vscode.Position(0, 0), input.nextText);
        if (!await vscode.workspace.applyEdit(edit)) conflict('Host refused file creation; inspect actual source.');
        const document = await vscode.workspace.openTextDocument(uri); if (!await document.save()) conflict('New source could not be saved; its editor content was preserved.');
      } else {
        const document = await vscode.workspace.openTextDocument(uri);
        if (document.isDirty || input.expectedVersion !== null && document.version !== input.expectedVersion || document.getText() !== input.currentText) conflict('Visible source differs from the reviewed saved version.');
        if (input.nextText === null) {
          const edit = new vscode.WorkspaceEdit(); edit.deleteFile(uri, { recursive: false, ignoreIfNotExists: false });
          if (disk() !== input.expectedSha256 || !await vscode.workspace.applyEdit(edit)) conflict('Host refused deletion of the exact reviewed added file.');
        } else {
          const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
          const version = document.version, change = minimalReviewEdit(input.currentText, input.nextText);
          if (disk() !== input.expectedSha256 || document.isDirty || document.version !== version) conflict('Source changed while preparing the host edit.');
          if (!await editor.edit(builder => builder.replace(new vscode.Range(document.positionAt(change.start), document.positionAt(change.end)), change.text), { undoStopBefore: true, undoStopAfter: true })) conflict('Host rejected the versioned source edit.');
          if (disk() !== input.expectedSha256 || document.getText() !== input.nextText || !await document.save()) conflict('Source changed before save; dirty editor and saved bytes were preserved for reconciliation.');
        }
      }
    },
    dispose() { registration?.dispose(); registration = undefined; contents.clear(); }
  };
}
