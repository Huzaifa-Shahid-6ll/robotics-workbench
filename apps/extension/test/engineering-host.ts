import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { OperationReceipt, ProjectMethod, WorkbenchManifest } from '@robotics-workbench/contracts';
import { EngineeringController } from '../src/engineering-controller';
import { CompanionClient } from '../src/companion-client';

/** Actual native host/companion over ordinary synthetic files; no hardware or GUI launch. */
export async function checkEngineeringHost(extensionUri: vscode.Uri, rootTemp: string): Promise<unknown> {
  const root = join(rootTemp, 'engineering-project'), dataRoot = join(rootTemp, 'engineering-data'); await mkdir(root, { recursive: true }); await mkdir(dataRoot, { recursive: true });
  const executable = process.env.WORKBENCH_TEST_NODE_EXECUTABLE!;
  const seed = process.env.WORKBENCH_TASK10_SEED ?? resolve('artifacts/task10-seed.cjs');
  const seeded = await promisify(execFile)(executable, [seed, root, dataRoot], { windowsHide: true, timeout: 30000 });
  const ids = JSON.parse(seeded.stdout.trim().split(/\r?\n/).at(-1)!) as { projectId: string; assetId: string; mappingPath: string };
  const manifest = JSON.parse(await readFile(join(root, 'workbench.json'), 'utf8')) as WorkbenchManifest, bound = { root, manifest };
  const client = new CompanionClient(vscode.Uri.joinPath(extensionUri, 'dist/companion.js').fsPath, executable, () => {}, () => {}, { projectRoot: root, dataRoot,
    ...(process.env.WORKBENCH_TASK10_KICAD_PATH ? { kicadPath: process.env.WORKBENCH_TASK10_KICAD_PATH } : {}), ...(process.env.WORKBENCH_TASK10_KICAD_SHA ? { kicadSha256: process.env.WORKBENCH_TASK10_KICAD_SHA } : {}), ...(process.env.WORKBENCH_TASK10_CAD_PYTHON ? { cadPythonPath: process.env.WORKBENCH_TASK10_CAD_PYTHON } : {}) });
  const counts = new Map<string, number>();
  let refuseKicadSnapshot = false;
  const request = async <T>(_bound: unknown, method: ProjectMethod, params: Record<string, unknown> = {}, revision?: number): Promise<T> => { counts.set(method, (counts.get(method) ?? 0) + 1); if (refuseKicadSnapshot && method === 'kicad.snapshot') throw Error('Synthetic disconnected KiCad inspection; no mutation was requested.'); return client.requestProject({ schemaVersion: 1, requestId: randomUUID(), projectId: manifest.projectId, method, params, ...(revision === undefined ? {} : { expectedProjectRevision: revision }) }) as Promise<T>; };
  const wait = async (_bound: unknown, receipt: OperationReceipt): Promise<OperationReceipt> => {
    const deadline = Date.now() + 360000;
    while (['queued', 'running', 'awaiting-input'].includes(receipt.status) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 50)); receipt = await request(bound, 'operation.get', { operationId: receipt.operationId }); }
    assert.ok(!['queued', 'running', 'awaiting-input'].includes(receipt.status)); return receipt;
  };
  const controller = new EngineeringController({ extensionUri } as vscode.ExtensionContext, { project: async () => bound, request, wait });
  const send = async (type: string, payload: Record<string, unknown> = {}, requestId = randomUUID()) => controller.handle({ schemaVersion: 1, requestId, projectId: manifest.projectId, type, payload });
  try {
    await client.start();
    const assetsPath = join(root, 'mechanical/assets.json'), declaredAssets = await readFile(assetsPath, 'utf8');
    await writeFile(assetsPath, '{ malformed CAD source preserved');
    await controller.show(); let state = controller.getState();
    assert.equal(state.project?.projectId, ids.projectId); assert.ok(state.schematic, 'Malformed optional CAD inputs must not hide independent schematic inspection on first open.'); assert.equal(state.cad, null); assert.match(state.error ?? '', /CAD inspection unavailable/); assert.equal(await readFile(assetsPath, 'utf8'), '{ malformed CAD source preserved');
    await writeFile(assetsPath, declaredAssets); await send('refresh'); state = controller.getState();
    assert.equal(state.error, null); assert.ok(state.cad?.assets.some(asset => asset.assetId === ids.assetId));
    refuseKicadSnapshot = true; await controller.refresh(); state = controller.getState();
    assert.match(state.error ?? '', /KiCad inspection unavailable/); assert.ok(state.cad?.assets.some(asset => asset.assetId === ids.assetId), 'Failed optional KiCad inspection must not hide independent CAD source/evidence.');
    refuseKicadSnapshot = false; await send('refresh'); state = controller.getState(); assert.equal(state.error, null);
    if (!process.env.WORKBENCH_TASK10_KICAD_PATH) assert.equal(state.schematic!.readiness.available, false);
    const unknown = await request<{ projectRevision: number }>(bound, 'cad.snapshot'); assert.equal(unknown.projectRevision, manifest.projectRevision);
    const action = randomUUID(); await send('screen', { screen: 'cad' }, action); await send('screen', { screen: 'cad' }, action); assert.equal(controller.getState().screen, 'cad');
    await send('screen', { screen: 'schematic' }, action); assert.match(controller.getState().error ?? '', /reused/); assert.equal(controller.getState().screen, 'cad');
    const before = counts.size; await send('executeCommand', { command: 'firmware.upload' }); assert.equal(counts.size, before);
    const asset = controller.getState().cad!.assets.find(item => item.assetId === ids.assetId)!;
    await send('openCadSource', { assetId: asset.assetId, source: 'script' });
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(join(root, asset.scriptRelativePath)));
    const disk = await readFile(document.uri.fsPath, 'utf8'), edit = new vscode.WorkspaceEdit(); edit.insert(document.uri, new vscode.Position(0, 0), '# Unsaved user edit\n'); assert.ok(await vscode.workspace.applyEdit(edit));
    const user = document.getText(), provider = `${disk}\n# External provider edit\n`; await writeFile(document.uri.fsPath, provider);
    const generatedBefore = counts.get('cad.generate') ?? 0;
    await send('generateCad', { assetId: asset.assetId, mode: 'production', assumptions: {} });
    assert.match(controller.getState().error ?? '', /dirty/); assert.equal(document.getText(), user); assert.equal(await readFile(document.uri.fsPath, 'utf8'), provider); assert.equal(counts.get('cad.generate') ?? 0, generatedBefore);
    await vscode.window.showTextDocument(document); await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await writeFile(document.uri.fsPath, disk); await controller.refresh();
    state = controller.getState(); const fingerprint = state.cad!.assets.find(item => item.assetId === asset.assetId)!.currentFingerprint;
    if (process.env.WORKBENCH_TASK10_CAD_PYTHON && fingerprint) {
      const generation = randomUUID(); await send('generateCad', { assetId: asset.assetId, mode: 'production', assumptions: {} }, generation); await send('generateCad', { assetId: asset.assetId, mode: 'production', assumptions: {} }, generation);
      state = controller.getState(); assert.equal(state.error, null); assert.equal(state.cad!.assets[0]!.lastGood?.status, 'succeeded'); assert.equal(counts.get('cad.generate'), generatedBefore + 1);
      const good = state.cad!.assets[0]!.lastGood!.operationId; await send('cadViewer', { assetId: asset.assetId, operationId: good }); assert.equal(controller.getState().error, null); assert.match(controller.getState().notice ?? '', /handoff required/); assert.equal(controller.getState().cad!.assets[0]!.lastGood!.operationId, good);
      await writeFile(document.uri.fsPath, `${disk}\n# Saved external source change\n`);
      const deadline = Date.now() + 15000;
      while (!controller.getState().cad!.assets[0]!.stale && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(controller.getState().cad!.assets[0]!.stale, true, 'Saved external input changes must invalidate a visible artifact without replay.');
      assert.equal(controller.getState().cad!.assets[0]!.lastGood!.operationId, good); assert.equal(counts.get('cad.generate'), generatedBefore + 1);
    }
    assert.ok(!counts.has('firmware.upload') && !counts.has('serial.capture') && !counts.has('build.compile'));
    return { passed: true, source: 'Synthetic ordinary files through actual companion, SQLite and VS Code native controller', projectId: ids.projectId, cadAssetId: ids.assetId, toolModes: { kicad: process.env.WORKBENCH_TASK10_KICAD_PATH ? 'configured actual tool' : 'missing optional tool', cad: process.env.WORKBENCH_TASK10_CAD_PYTHON ? 'configured actual interpreter' : 'missing optional tool' }, optionalFeatureFailuresIsolated: true, nativeDirtyAndProviderPreserved: true, malformedFrameRejected: true, reusedRequestConflict: true, hardwareOperations: 0, limitation: 'Native software test; no physical circuit/fit, OS KiCad GUI association, Windows screen reader or viewer rendering established.' };
  } finally { controller.dispose(); await client.stop(); }
}
