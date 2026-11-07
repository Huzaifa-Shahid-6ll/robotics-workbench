import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DocumentExcerpt, OperationReceipt, ProjectMethod, WorkbenchManifest } from '@robotics-workbench/contracts';
import { pdfFixture } from '../../../packages/test-fixtures/documents/fixtures';
import { DocumentController } from '../src/document-controller';
import type { CompanionClient } from '../src/companion-client';

export async function checkDocumentHost(extensionUri: vscode.Uri, client: CompanionClient, root: string): Promise<unknown> {
  const manifest = JSON.parse(await readFile(join(root, 'workbench.json'), 'utf8')) as WorkbenchManifest;
  const documentId = randomUUID(), textId = randomUUID();
  manifest.projectRevision++; manifest.documents.push({ documentId, path: 'synthetic-reference.pdf', title: 'Synthetic rotated reference' }, { documentId: textId, path: 'synthetic-note.txt' });
  await writeFile(join(root, 'synthetic-reference.pdf'), pdfFixture({ rotated: true, activeContent: true }));
  await writeFile(join(root, 'synthetic-note.txt'), 'Retained original text.');
  await writeFile(join(root, 'workbench.json'), JSON.stringify(manifest));
  const bound = { root, manifest };
  const request = async <T>(_bound: unknown, method: ProjectMethod, params: Record<string, unknown> = {}, revision?: number): Promise<T> => await client.requestProject({ schemaVersion: 1, requestId: randomUUID(), projectId: manifest.projectId, method, params, ...(revision !== undefined ? { expectedProjectRevision: revision } : {}) }) as T;
  const wait = async (_bound: unknown, receipt: OperationReceipt): Promise<OperationReceipt> => {
    const deadline = Date.now() + 45000;
    while (['queued', 'running', 'awaiting-input'].includes(receipt.status) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 50)); receipt = await request(bound, 'operation.get', { operationId: receipt.operationId }); }
    assert.ok(!['queued', 'running', 'awaiting-input'].includes(receipt.status), 'Document operation must reach an observed terminal result.'); return receipt;
  };
  let frozen: DocumentExcerpt | undefined;
  const controller = new DocumentController({ extensionUri } as vscode.ExtensionContext, { project: async () => bound, request, wait, ask: citation => { frozen = structuredClone(citation); } });
  const send = async (type: string, payload: Record<string, unknown> = {}, requestId = randomUUID()) => controller.handle({ schemaVersion: 1, requestId, projectId: manifest.projectId, type, payload });
  try {
    await controller.show(); assert.equal(controller.getState().documents.length, manifest.documents.length);
    const id = randomUUID(); await send('ingest', { documentId }, id); await send('ingest', { documentId }, id);
    let state = controller.getState(); assert.equal(state.error, null); assert.ok(state.page?.image?.dataUrl.startsWith('data:image/png;base64,'));
    assert.equal(state.page?.citation.page, 1); assert.equal(state.page?.citation.printedPageLabel, '10'); assert.equal(state.page?.rotation, 90);
    assert.equal(state.documents.find(doc => doc.documentId === documentId)?.versions.length, 1);
    const location = { documentId, artifactSha256: state.page!.citation.artifactSha256, extractorVersion: state.page!.citation.extractorVersion, page: 1, region: state.page!.regions[0]!.region };
    const exact = await request<DocumentExcerpt>(bound, 'document.excerpt', location);
    await send('navigate', { citation: exact }); state = controller.getState(); assert.deepEqual(state.page!.citation, exact);
    await send('ask', { citation: Object.fromEntries(Object.entries(exact).reverse()) }); assert.deepEqual(frozen, exact, 'Canonical selected region freezes despite object field order.');
    const before = structuredClone(frozen);
    await writeFile(join(root, 'synthetic-reference.pdf'), pdfFixture({ imageOnly: true })); await controller.refresh();
    assert.equal(controller.getState().page?.sourceCurrent, false); assert.deepEqual(frozen, before); assert.equal(controller.getState().page?.citation.artifactSha256, exact.artifactSha256);
    await send('ask', { citation: { ...exact, text: 'Invented source command' } }); assert.match(controller.getState().error ?? '', /differs/); assert.deepEqual(frozen, before);
    const text = await vscode.workspace.openTextDocument(vscode.Uri.file(join(root, 'synthetic-note.txt')));
    const edit = new vscode.WorkspaceEdit(); edit.insert(text.uri, new vscode.Position(0, 0), 'Unsaved user text. '); assert.ok(await vscode.workspace.applyEdit(edit));
    const user = text.getText(); await writeFile(text.uri.fsPath, 'External provider text.');
    await send('ingest', { documentId: textId }); assert.match(controller.getState().error ?? '', /dirty/); assert.equal(text.getText(), user); assert.equal(await readFile(text.uri.fsPath, 'utf8'), 'External provider text.');
    await vscode.window.showTextDocument(text); await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    return { passed: true, source: 'synthetic PDF/text, actual packaged extraction/FTS/native host', physicalPage: 1, printedLabel: '10', rotated: true, originalPng: true, retainedHistoricalHash: exact.artifactSha256, frozenRegion: exact.region, dirtyUserAndProviderPreserved: true };
  } finally { controller.dispose(); }
}
