import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { isDiagnosticPreview, type ProjectMethod, type RecoverySnapshot, type WorkbenchManifest } from '@robotics-workbench/contracts';
import type { CompanionClient } from '../src/companion-client';
import { RecoveryController, nativeRecoveryUi } from '../src/recovery-controller';

export async function checkDiagnosticsHost(client: CompanionClient, root: string, temporaryRoot: string, manifest: WorkbenchManifest): Promise<unknown> {
  const privateSource = join(root, 'diagnostic-private.txt'), sentinel = 'SYNTHETIC_PRIVATE_SOURCE_NEVER_INCLUDE_IN_DIAGNOSTICS';
  await writeFile(privateSource, sentinel);
  const destination = join(temporaryRoot, 'reviewed-diagnostics.json'), rejectedDestination = join(temporaryRoot, 'rejected-diagnostics.json');
  const observed: ProjectMethod[] = [];
  let previewSha256: string | undefined, previewId: string | undefined;
  const request = async <T>(method: ProjectMethod, params: Record<string, unknown> = {}, revision?: number): Promise<T> => client.requestProject({ schemaVersion: 1, requestId: randomUUID(), projectId: manifest.projectId, method, params, ...(revision === undefined ? {} : { expectedProjectRevision: revision }) }) as Promise<T>;
  const before = await request<RecoverySnapshot>('recovery.inspect');
  const ui = nativeRecoveryUi();
  const controller = new RecoveryController({ project: async () => ({ root, manifest }), prepareArchive: async () => { throw Error('Not a project archive fixture.'); }, request: async <T>(_bound: unknown, method: ProjectMethod, params?: Record<string, unknown>, revision?: number) => {
    observed.push(method); const value = await request<T>(method, params, revision);
    if (method === 'diagnostics.preview') {
      assert.ok(isDiagnosticPreview(value));
      assert.equal(value.projectId, manifest.projectId);
      assert.equal(value.bundleSha256, createHash('sha256').update(value.text).digest('hex'));
      assert.equal(value.text.includes(sentinel), false); assert.equal(value.text.includes(root), false); assert.equal(value.text.includes(manifest.name), false);
      previewSha256 = value.bundleSha256; previewId = value.previewId;
    }
    return value;
  } }, { ...ui, confirm: async (_message, _action, modal) => { assert.equal(modal, false); return true; }, saveFile: async () => destination, message: async () => {} });
  try {
    await controller.exportDiagnostics();
    assert.deepEqual(observed, ['diagnostics.preview', 'diagnostics.export']);
    const exported = await readFile(destination, 'utf8'), editor = vscode.window.activeTextEditor!;
    assert.ok(editor.document.uri.scheme.startsWith('robotics-recovery-'));
    assert.equal(editor.document.getText(), exported);
    await vscode.commands.executeCommand('type', { text: 'attempted user diagnostic rewrite' });
    assert.equal(editor.document.getText(), exported);
    assert.equal(createHash('sha256').update(exported).digest('hex'), previewSha256);
    assert.equal(JSON.parse(exported).configuration.privatePayloadsIncluded, false);
    await assert.rejects(request('diagnostics.export', { previewId, expectedBundleSha256: '0'.repeat(64), destination: rejectedDestination }, manifest.projectRevision));
    await assert.rejects(stat(rejectedDestination), { code: 'ENOENT' });
    assert.equal(await readFile(privateSource, 'utf8'), sentinel);
    const after = await request<RecoverySnapshot>('recovery.inspect');
    assert.deepEqual(after.operations.map(item => item.operationId), before.operations.map(item => item.operationId));
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    return { passed: true, evidenceClass: 'installed-native-preview-and-real-companion-export', previewSha256, sourcePreserved: true, privateSourceExcluded: true, immutableUserTyping: true, mismatchedPreviewRejected: true, newOperationReceipts: 0, limitation: 'Actual installed controller, read-only native preview and companion export. Review consent/file-picker choices are fixture callbacks; manual dialogs, appearance, keyboard traversal and spoken output are not verified.' };
  } finally { controller.dispose(); }
}
