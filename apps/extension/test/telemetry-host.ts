import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { OperationReceipt, ProjectMethod, RecordingSelection, WorkbenchManifest } from '@robotics-workbench/contracts';
import { freezeTelemetrySelection } from '@robotics-workbench/webviews';
import { TelemetryController } from '../src/telemetry-controller';
import { CompanionClient } from '../src/companion-client';

/** Native software evidence over a separately seeded synthetic recording; opens no physical port. */
export async function checkTelemetryHost(extensionUri: vscode.Uri, rootTemp: string): Promise<unknown> {
  const root = join(rootTemp, 'telemetry-project'), dataRoot = join(rootTemp, 'telemetry-data'); await mkdir(root, { recursive: true }); await mkdir(dataRoot, { recursive: true });
  const executable = process.env.WORKBENCH_TEST_NODE_EXECUTABLE!;
  const seed = process.env.WORKBENCH_TASK09_SEED ?? resolve('artifacts/task09-seed.cjs');
  const seeded = await promisify(execFile)(executable, [seed, root, dataRoot], { windowsHide: true, timeout: 30000 });
  const ids = JSON.parse(seeded.stdout.trim().split(/\r?\n/).at(-1)!) as { recordingId: string; profileId: string; procedureId: string; projectId: string; projectRevision: number };
  const manifest = JSON.parse(await readFile(join(root, 'workbench.json'), 'utf8')) as WorkbenchManifest, bound = { root, manifest };
  const client = new CompanionClient(vscode.Uri.joinPath(extensionUri, 'dist/companion.js').fsPath, executable, () => {}, () => {}, { projectRoot: root, dataRoot });
  const counts = new Map<string, number>(); let asked: RecordingSelection | undefined;
  const request = async <T>(_bound: unknown, method: ProjectMethod, params: Record<string, unknown> = {}, revision?: number): Promise<T> => { counts.set(method, (counts.get(method) ?? 0) + 1); return client.requestProject({ schemaVersion: 1, requestId: randomUUID(), projectId: manifest.projectId, method, params, ...(revision === undefined ? {} : { expectedProjectRevision: revision }) }) as Promise<T>; };
  const wait = async (_bound: unknown, receipt: OperationReceipt): Promise<OperationReceipt> => {
    const deadline = Date.now() + 45000;
    while (['queued', 'running', 'awaiting-input'].includes(receipt.status) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 50)); receipt = await request(bound, 'operation.get', { operationId: receipt.operationId }); }
    assert.ok(!['queued', 'running', 'awaiting-input'].includes(receipt.status)); return receipt;
  };
  const controller = new TelemetryController({ extensionUri } as vscode.ExtensionContext, { project: async () => bound, request, wait, ask: selection => { asked = structuredClone(selection); } });
  const send = async (type: string, payload: Record<string, unknown> = {}, requestId = randomUUID()) => controller.handle({ schemaVersion: 1, requestId, projectId: manifest.projectId, type, payload });
  try {
    await client.start(); await controller.show(); assert.equal(controller.getState().error, null); assert.ok(controller.getState().recordings.some(r => r.recordingId === ids.recordingId));
    await send('selectRecording', { recordingId: ids.recordingId }); const action = randomUUID();
    await send('selectProfile', { recordingId: ids.recordingId, profileId: ids.profileId }, action); await send('selectProfile', { recordingId: ids.recordingId, profileId: ids.profileId }, action);
    let state = controller.getState(); assert.equal(state.error, null); assert.ok(state.window?.samples.length); assert.ok(state.window?.gaps.length); assert.equal(counts.get('telemetry.derive'), 1, 'Duplicate frame request cannot regenerate an operation.');
    const selection = freezeTelemetrySelection(state, state.window!.start, state.window!.end, state.window!.channelIds); assert.ok(selection);
    await send('ask', { selection }); assert.deepEqual(asked, selection); const frozen = structuredClone(asked);
    await send('ask', { selection: { ...selection, configurationSha256: 'f'.repeat(64) } }); assert.ok(controller.getState().error); assert.deepEqual(asked, frozen, 'Forged parser provenance cannot replace retained context.');
    manifest.projectRevision++; await writeFile(join(root, 'workbench.json'), JSON.stringify(manifest)); await controller.refresh(); await send('ask', { selection });
    assert.deepEqual(asked, frozen); assert.equal(asked.projectRevision, ids.projectRevision, 'Historical recording revision survives current source changes.');
    const profilesFile = join(root, 'telemetry/parsers.json'), profilesBefore = await readFile(profilesFile, 'utf8'), profiles = JSON.parse(profilesBefore);
    const numeric = profiles.profiles.find((p: { id: string }) => p.id === ids.profileId); numeric.channels[0].unit = 'changed-unit';
    await writeFile(profilesFile, JSON.stringify(profiles)); await controller.reveal(selection); state = controller.getState();
    assert.equal(state.error, null); assert.equal(state.window!.derivationId, selection.derivationId); assert.equal(state.window!.configurationSha256, selection.configurationSha256); assert.deepEqual(state.revealedSelection, selection);
    const retainedUnits = state.profiles.find(p => p.id === ids.profileId)!.channels[0].unit; assert.notEqual(retainedUnits, 'changed-unit'); assert.ok(state.recordings.find(r => r.recordingId === ids.recordingId)!.limitations.some(l => l.includes('Historical parser pinned')));
    const first = state.window!.samples.find(s => s.channelId === selection.channelIds[0])!;
    await send('query', { recordingId: ids.recordingId, profileId: ids.profileId, channelIds: [first.channelId], timeBasis: 'host-receive', start: first.hostReceiveMs, end: first.hostReceiveMs });
    const queried = controller.getState().revealedSelection!; assert.equal(controller.getState().error, null); assert.equal(queried.start, first.hostReceiveMs); assert.equal(queried.end, first.hostReceiveMs); assert.equal(queried.projectRevision, ids.projectRevision); assert.deepEqual(queried.channelIds, [first.channelId]);
    await send('ask', { selection: queried }); assert.deepEqual(asked, queried, 'An explicit historical query must Ask its changed range, channels and original recording revision.');
    await controller.refresh(); assert.deepEqual(controller.getState().revealedSelection, queried, 'Background refresh must retain the explicitly queried historical range.');
    const deriveCount = counts.get('telemetry.derive'); await controller.refresh(); assert.equal(counts.get('telemetry.derive'), deriveCount, 'Historical polling must not derive from changed current parser source.');
    profiles.profiles = profiles.profiles.filter((p: { id: string }) => p.id !== ids.profileId);
    const rawId = randomUUID(); profiles.profiles.push({ schemaVersion: 1, id: rawId, parserVersion: 'telemetry-v1', mode: 'raw-text', channels: [] });
    await writeFile(profilesFile, JSON.stringify(profiles)); await controller.refresh(); assert.equal(controller.getState().window!.configurationSha256, selection.configurationSha256, 'Removed current parser cannot replace retained profile.');
    await send('selectProfile', { recordingId: ids.recordingId, profileId: rawId }); state = controller.getState(); assert.equal(state.error, null); assert.equal(state.window, null); assert.equal(state.live?.captureActive, false); assert.ok(state.live?.text);
    await writeFile(profilesFile, profilesBefore); await controller.refresh(); await send('selectProfile', { recordingId: ids.recordingId, profileId: ids.profileId }); assert.equal(controller.getState().revealedSelection, null);
    const raw = controller.getState().profiles.find(p => p.mode === 'raw-text');
    if (raw) { await send('selectProfile', { recordingId: ids.recordingId, profileId: raw.id }); state = controller.getState(); assert.equal(state.error, null); assert.equal(state.window, null); assert.equal(state.live?.captureActive, false); assert.ok(state.live?.text); }
    await send('selectProfile', { recordingId: ids.recordingId, profileId: ids.profileId });
    const before = await readFile(join(root, 'experiments/procedures.json'), 'utf8');
    await send('createProcedure'); const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(join(root, 'experiments/procedures.json'))); assert.ok(doc.isDirty); const user = doc.getText(); assert.match(user, /TODO:/); assert.equal(await readFile(doc.uri.fsPath, 'utf8'), before, 'Procedure template remains an unsaved native draft.');
    const external = before.replace(/\n?$/, '\n '); await writeFile(doc.uri.fsPath, external);
    await send('createProcedure'); assert.match(controller.getState().error ?? '', /dirty|reconcile/); assert.equal(doc.getText(), user); assert.equal(await readFile(doc.uri.fsPath, 'utf8'), external);
    await vscode.window.showTextDocument(doc); await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    const unknown = randomUUID(); await send('selectRecording', { recordingId: unknown }); assert.match(controller.getState().error ?? '', /unavailable/);
    assert.ok(!counts.has('serial.capture') && !counts.has('firmware.upload') && !counts.has('telemetry.stopCapture'));
    return { passed: true, source: 'Synthetic retained raw recording through actual companion worker, SQLite and native VS Code controller', recordingId: ids.recordingId, derivationId: selection.derivationId, frozenSelection: selection, duplicateDerivationRefused: true, forgedSelectionRefused: true, historicalRevisionRetained: true, historicalParserEditAndRemovalPreserved: true, historicalQueryUpdatesExactAsk: true, historicalRawPreview: true, nativeDirtyAndExternalProviderPreserved: true, serialWrites: 0, limitation: 'Native intents and retained software evidence; no physical board, procedure judgment or screen-reader test.' };
  } finally { controller.dispose(); await client.stop(); }
}
