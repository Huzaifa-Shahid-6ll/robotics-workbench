import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { OperationReceipt, ProjectMethod, WorkbenchManifest } from '@robotics-workbench/contracts';
import { nativeRecoveryUi, RecoveryController } from '../src/recovery-controller';

export async function checkRecoveryHost(): Promise<unknown> {
  const commands = await vscode.commands.getCommands();
  for (const name of ['openRecovery', 'exportProject', 'restoreProject', 'exportDiagnostics']) assert.ok(commands.includes(`roboticsWorkbench.${name}`));
  const manifest: WorkbenchManifest = { schemaVersion: 1, projectId: randomUUID(), projectRevision: 1, name: 'Synthetic native recovery fixture', sketches: [], targets: [], components: [], nets: [], codeBindings: [], documents: [], extensions: {} };
  const receipt: OperationReceipt = { schemaVersion: 1, operationId: randomUUID(), requestId: randomUUID(), projectId: manifest.projectId, expectedProjectRevision: 1, kind: 'upload', status: 'outcome-unknown', createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(), deviceId: randomUUID(), sourceSnapshotId: randomUUID(), tool: { name: 'synthetic-no-device', version: '1' }, artifacts: [] };
  const observed: ProjectMethod[] = [];
  const ui = nativeRecoveryUi();
  const controller = new RecoveryController({ project: async () => ({ root: process.cwd(), manifest }), prepareArchive: async () => { throw Error('Not an export fixture.'); }, request: async <T>(_bound: unknown, method: ProjectMethod) => {
    observed.push(method); assert.equal(method, 'operation.get'); return receipt as T;
  } }, ui);
  try {
    await controller.inspectOperation({ root: process.cwd(), manifest }, receipt.operationId);
    const editor = vscode.window.activeTextEditor!;
    assert.ok(editor.document.uri.scheme.startsWith('robotics-recovery-'));
    const content = JSON.parse(editor.document.getText());
    assert.equal(content.receipt.operationId, receipt.operationId); assert.equal(content.receipt.status, 'outcome-unknown');
    assert.match(content.notice, /never replayed/);
    const original = editor.document.getText();
    await vscode.commands.executeCommand('type', { text: 'attempted user receipt rewrite' });
    assert.equal(editor.document.getText(), original);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    assert.deepEqual(observed, ['operation.get']);
    return { passed: true, evidenceClass: 'native-host-synthetic-receipt', userTypingPreservedReceipt: true, commandsRegistered: true, hardwareEffects: 0, limitation: 'The actual native user type command did not alter this virtual receipt. Extension APIs can edit temporary document models; this is no security boundary. Keyboard traversal, visual layout, Narrator and physical state require separate evidence.' };
  } finally { controller.dispose(); }
}
