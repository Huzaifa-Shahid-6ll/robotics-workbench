import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { WorkbenchManifest } from '@robotics-workbench/contracts';

const delay = (durationMs: number) => new Promise(resolve => setTimeout(resolve, durationMs));
const measured = async (run: () => Promise<unknown>) => { const start = performance.now(); await run(); return performance.now() - start; };
type ProcessMemory = { processId: number; parentId: number; name: string; workingSetBytes: number };
const optionalWorkers = (tree: ProcessMemory[], companionPid: number) => tree.filter(item => item.processId !== companionPid && !(item.name.toLowerCase() === 'conhost.exe' && item.parentId === companionPid));

async function processTree(seed: number): Promise<ProcessMemory[]> {
  assert.ok(Number.isSafeInteger(seed) && seed > 0);
  const command = `$all = @(Get-CimInstance Win32_Process); $ids = [System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(${seed}); do { $changed = $false; foreach ($item in $all) { if ($ids.Contains([int]$item.ParentProcessId) -and $ids.Add([int]$item.ProcessId)) { $changed = $true } } } while ($changed); @($all | Where-Object { $ids.Contains([int]$_.ProcessId) } | ForEach-Object { @{ processId = [int]$_.ProcessId; parentId = [int]$_.ParentProcessId; name = $_.Name; workingSetBytes = [double]$_.WorkingSetSize } }) | ConvertTo-Json -Compress`;
  const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
  const parsed = JSON.parse(result.stdout.trim());
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function idle() {
  const started = performance.now(), samples: { elapsedMs: number; rssBytes: number; heapUsedBytes: number }[] = [];
  do {
    const memory = process.memoryUsage();
    samples.push({ elapsedMs: performance.now() - started, rssBytes: memory.rss, heapUsedBytes: memory.heapUsed });
    if (performance.now() - started >= 60000) break;
    await delay(5000);
  } while (true);
  return { durationMs: performance.now() - started, samples, final: samples.at(-1)! };
}

/** Separate benchmark host; ordinary smoke tests never wait through these idle workloads. */
export async function run(): Promise<void> {
  const report = process.env.WORKBENCH_PERFORMANCE_REPORT!;
  const mode = process.env.WORKBENCH_PERFORMANCE_MODE;
  const startedAt = new Date().toISOString();
  const result: Record<string, unknown> = { schemaVersion: 1, mode, startedAt, evidenceClass: 'actual-windows-vscode-host-performance', vscodeVersion: vscode.version,
    runtime: process.version, hostPid: process.pid, limitation: 'Host/controller completion and IPC publication are measured. Visible rendered command acknowledgement, rendered context latency and per-listener allocation require separate UI instrumentation.' };
  const extension = vscode.extensions.getExtension('local-workbench.robotics-workbench');
  assert.ok(extension);
  try {
    if (mode === 'baseline') {
      assert.equal(extension.isActive, false, 'Baseline must not activate the workbench.');
      result.idle = await idle();
      assert.equal(extension.isActive, false, 'Workbench unexpectedly activated during baseline.');
      result.workbenchActive = false;
    } else {
      const alreadyActive = extension.isActive, start = performance.now();
      const api = await extension.activate();
      result.activation = { durationMs: performance.now() - start, alreadyActive, budgetMs: 1000, meaning: 'Public Extension.activate promise completion; OS filesystem cache is warm after baseline.' };
      assert.equal(api.getCompanionPid(), undefined, 'Unused optional features must be lazy.');
      await api.wiring.refresh();
      const state = api.wiring.getState(); assert.equal(state.manifest.components.length, 100); assert.equal(state.error, null);
      const companionPid = api.getCompanionPid(); assert.ok(companionPid);
      result.companionPid = companionPid;
      result.beforeIdleProcesses = await processTree(companionPid);
      assert.equal((result.beforeIdleProcesses as ProcessMemory[]).find(item => item.processId === companionPid)?.name.toLowerCase(), 'node.exe');
      assert.equal(optionalWorkers(result.beforeIdleProcesses as ProcessMemory[], companionPid).length, 0, 'Ordinary project reads must not start optional workers.');
      result.idle = await idle();
      const idleProcesses = await processTree(companionPid);
      result.idleProcesses = idleProcesses;
      assert.equal(optionalWorkers(idleProcesses, companionPid).length, 0, 'Unused provider/CAD/KiCad workers appeared during idle.');
      result.commandCompletionMs = [];
      for (let index = 0; index < 30; index++) (result.commandCompletionMs as number[]).push(await measured(async () => { await vscode.commands.executeCommand('roboticsWorkbench.openComponents'); }));
      result.selectionPostedStateMs = [];
      for (let index = 0; index < 30; index++) {
        const componentId = state.manifest.components[index].componentId;
        (result.selectionPostedStateMs as number[]).push(await measured(async () => {
          await api.wiring.handle({ schemaVersion: 1, requestId: randomUUID(), projectId: state.project.projectId, type: 'select', payload: { kind: 'component', id: componentId } });
          assert.equal(api.wiring.getState().selection.id, componentId);
        }));
      }
      result.contextCommandCompletionMs = [];
      for (let index = 0; index < 30; index++) (result.contextCommandCompletionMs as number[]).push(await measured(async () => { await vscode.commands.executeCommand('roboticsWorkbench.inspectContext'); }));
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      const panelCycles: { cycle: number; rssBytes: number; remainingWebviewTabs: number }[] = [];
      for (let cycle = 0; cycle < 3; cycle++) {
        for (const command of ['openWiring', 'openDocuments', 'openTelemetry', 'openSchematic', 'openCad']) {
          await vscode.commands.executeCommand(`roboticsWorkbench.${command}`);
          const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputWebview);
          assert.ok(tabs.length > 0, `${command} must open its real panel.`);
          assert.equal(await vscode.window.tabGroups.close(tabs, true), true);
        }
        const remainingWebviewTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputWebview).length;
        assert.equal(remainingWebviewTabs, 0);
        panelCycles.push({ cycle, rssBytes: process.memoryUsage().rss, remainingWebviewTabs });
      }
      await vscode.commands.executeCommand('roboticsWorkbench.openAgent');
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      const manifest = JSON.parse(await readFile(join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'workbench.json'), 'utf8')) as WorkbenchManifest;
      assert.equal(manifest.components.length, 100);
      const log = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'generated-10000.log'));
      assert.equal(log.lineCount, 10001);
      await vscode.window.showTextDocument(log); await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      result.panelCycles = panelCycles;
      result.afterPanelsProcesses = await processTree(companionPid);
      const shutdownStarted = performance.now(); await api.stop();
      result.shutdownMs = performance.now() - shutdownStarted;
      assert.ok(Number(result.shutdownMs) <= 10000, 'Companion shutdown exceeded10seconds.');
      assert.throws(() => process.kill(companionPid, 0), 'Owned companion must actually exit.');
      result.shutdownExitObserved = true;
      result.fixture = { components: 100, generatedLogRows: 10000, multiFileSketch: true, realHardware: false };
    }
    result.passed = true;
  } catch (error) {
    result.passed = false; result.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally { result.endedAt = new Date().toISOString(); await writeFile(report, JSON.stringify(result, null, 2) + '\n'); }
}
