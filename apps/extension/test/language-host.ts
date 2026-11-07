import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { ArduinoLanguageService } from '../src/language-service';

const execute = promisify(execFile);
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const installed = 'C:/Program Files/Arduino IDE/resources/app/lib/backend/resources';
const tools = { server: join(installed, 'arduino-language-server.exe'), clangd: join(installed, 'clangd.exe'), cli: join(installed, 'arduino-cli.exe'), config: join(homedir(), '.arduinoIDE', 'arduino-cli.yaml') };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(check: () => boolean, label: string, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) { if (Date.now() >= end) throw Error(`Language-service deadline: ${label}`); await new Promise(resolveWait => setTimeout(resolveWait, 200)); }
}
async function descendants(pid: number): Promise<{ pid: number; parentPid: number; name: string }[]> {
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'], { windowsHide: true, timeout: 30_000, maxBuffer: 256 * 1024 });
  const list = JSON.parse(stdout) as { ProcessId: number; ParentProcessId: number; Name: string }[], seen = new Set([pid]);
  let changed = true;
  while (changed) { changed = false; for (const child of list) if (seen.has(child.ParentProcessId) && !seen.has(child.ProcessId)) { seen.add(child.ProcessId); changed = true; } }
  return list.filter(p => seen.has(p.ProcessId)).map(p => ({ pid: p.ProcessId, parentPid: p.ParentProcessId, name: p.Name }));
}

/** Real installed server/CLI/clangd with an isolated, synthetic multi-file sketch; no USB access. */
export async function checkLanguageService(_extensionUri: vscode.Uri | undefined, rootTemp: string): Promise<unknown> {
  assert.equal(vscode.workspace.isTrusted, true);
  const startedAt = new Date().toISOString(), root = join(rootTemp, 'LanguageProbe');
  await mkdir(root, { recursive: true });
  const sources: Record<string, string> = {
    'LanguageProbe.ino': '#include "helpers.h"\nvoid setup() { int mainValue = PRIMARY_UNKNOWN; beginProbe(); }\nvoid loop() {}\n',
    'Second.ino': 'int secondValue() { return MULTI_TAB_UNKNOWN; }\n',
    'helpers.h': '#pragma once\ninline int headerValue() { return HEADER_UNKNOWN; }\nvoid beginProbe();\n',
    'helpers.cpp': '#include "helpers.h"\nvoid beginProbe() { int cppValue = CPP_UNKNOWN; }\n',
  };
  for (const [name, text] of Object.entries(sources)) await writeFile(join(root, name), text);
  let log = '';
  const output = vscode.window.createOutputChannel('Robotics Language Host Probe');
  const captured: vscode.OutputChannel = { name: output.name, append: text => { log = (log + text).slice(-64 * 1024); output.append(text); }, appendLine: text => { log = (log + text + '\n').slice(-64 * 1024); output.appendLine(text); }, clear: () => output.clear(), replace: text => { log = text.slice(-64 * 1024); output.replace(text); }, show: () => output.show(true), hide: () => output.hide(), dispose: () => output.dispose() };
  const service = new ArduinoLanguageService(captured);
  const documents: vscode.TextDocument[] = [];
  let owned: { pid: number; parentPid: number; name: string }[] = [];
  const diagnostics = (name: string) => vscode.languages.getDiagnostics(vscode.Uri.file(join(root, name)));
  const snapshot = () => Object.fromEntries(Object.keys(sources).map(name => [name, diagnostics(name).map(d => ({ message: d.message, severity: d.severity, source: d.source ?? null, range: { start: { line: d.range.start.line, character: d.range.start.character }, end: { line: d.range.end.line, character: d.range.end.character } } }))]));
  let report: Record<string, unknown> = { passed: false, startedAt, hardware: 'not-run', sourceKind: 'synthetic multi-file sketch; real installed language tools', root };
  try {
    const versions: Record<string, unknown> = {};
    for (const [name, path] of Object.entries(tools)) versions[name] = { path, sha256: hash(await readFile(path)) };
    const clangd = await execute(tools.clangd, ['--version'], { windowsHide: true, timeout: 5000 });
    const cli = await execute(tools.cli, ['version', '--format', 'json'], { windowsHide: true, timeout: 5000 });
    // This installed Go server has no version flag; initialization metadata and exact bytes identify it.
    const help = await execute(tools.server, ['-help'], { windowsHide: true, timeout: 5000 });
    versions.clangd = { ...(versions.clangd as object), versionOutput: clangd.stdout.trim() };
    versions.cli = { ...(versions.cli as object), version: JSON.parse(cli.stdout) };
    versions.server = { ...(versions.server as object), helpSha256: hash(help.stderr + help.stdout), versionFlag: 'unsupported; identify by executable hash and initialize metadata' };
    report.tools = versions;
    for (const name of Object.keys(sources)) {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(join(root, name)));
      assert.equal(document.languageId, 'cpp', 'Arduino source must reuse the native C++ language/grammar association.');
      documents.push(document);
    }
    const pattern = vscode.Uri.file(root).fsPath.replaceAll('\\', '/').replace(/[[\]{}*?]/g, char => `[${char}]`) + '/**/*.{ino,h,hpp,c,cpp}';
    report.selector = { pattern, matches: documents.map(document => ({ path: document.uri.fsPath, score: vscode.languages.match({ scheme: 'file', pattern }, document) })) };
    assert.ok(documents.every(document => vscode.languages.match({ scheme: 'file', pattern }, document) > 0), 'Every fixture document must match the exact scoped language selector.');
    await service.start(root, { path: '.', targetId: 'probe-target' }, { targetId: 'probe-target', fqbn: 'arduino:avr:uno', options: {} }, tools);
    report.serverInfo = service.serverInfo;
    assert.ok(service.processId, 'Language server must have an observable owned PID.');
    owned = await descendants(service.processId);
    const expected: Record<string, string> = { 'LanguageProbe.ino': 'PRIMARY_UNKNOWN', 'Second.ino': 'MULTI_TAB_UNKNOWN', 'helpers.h': 'HEADER_UNKNOWN', 'helpers.cpp': 'CPP_UNKNOWN' };
    await waitFor(() => Object.entries(expected).every(([file, token]) => diagnostics(file).some(d => d.message.includes(token))), 'all original .ino/.h/.cpp locations');
    owned = await descendants(service.processId);
    const initial = snapshot();
    for (const [name, token] of Object.entries(expected)) {
      const diagnostic = diagnostics(name).find(d => d.message.includes(token))!;
      const lines = sources[name]!.split('\n');
      assert.ok(lines[diagnostic.range.start.line]?.includes(token), `${name} maps to its original source line.`);
      assert.equal(diagnostic.range.start.character, lines[diagnostic.range.start.line]!.indexOf(token), `${name} maps to its original token column.`);
    }
    const second = documents.find(doc => doc.uri.fsPath.toLowerCase() === join(root, 'Second.ino').toLowerCase())!;
    const start = second.getText().indexOf('MULTI_TAB_UNKNOWN'), diskHash = hash(await readFile(second.uri.fsPath));
    const edit = new vscode.WorkspaceEdit(); edit.replace(second.uri, new vscode.Range(second.positionAt(start), second.positionAt(start + 'MULTI_TAB_UNKNOWN'.length)), 'UNSAVED_NEW_UNKNOWN');
    assert.equal(await vscode.workspace.applyEdit(edit), true); assert.equal(second.isDirty, true);
    await waitFor(() => diagnostics('Second.ino').some(d => d.message.includes('UNSAVED_NEW_UNKNOWN')) && !diagnostics('Second.ino').some(d => d.message.includes('MULTI_TAB_UNKNOWN')), 'unsaved secondary .ino error reflected by server');
    const unsavedDiagnostics = snapshot();
    const fix = new vscode.WorkspaceEdit(); fix.replace(second.uri, new vscode.Range(second.positionAt(start), second.positionAt(start + 'UNSAVED_NEW_UNKNOWN'.length)), '123');
    assert.equal(await vscode.workspace.applyEdit(fix), true);
    await waitFor(() => !diagnostics('Second.ino').some(d => d.message.includes('UNSAVED_NEW_UNKNOWN')), 'unsaved secondary .ino fix reflected by server');
    assert.equal(hash(await readFile(second.uri.fsPath)), diskHash, 'Language diagnostics must not save dirty source.');
    assert.ok(diagnostics('LanguageProbe.ino').some(d => d.message.includes('PRIMARY_UNKNOWN')), 'Other source diagnostics remain attributable.');
    for (const [name, text] of Object.entries(sources)) assert.equal(await readFile(join(root, name), 'utf8'), text, 'Language analysis leaves every original disk file unchanged.');
    const pid = service.processId!, fixedDiagnostics = snapshot();
    await service.stop();
    await waitFor(() => owned.every(p => !alive(p.pid)), 'owned language-tool process tree exits', 10_000);
    report = { ...report, passed: true, endedAt: new Date().toISOString(), fqbn: 'arduino:avr:uno', diagnostics: initial, unsavedBuffer: { path: 'Second.ino', documentVersion: second.version, dirty: second.isDirty, diskSha256: diskHash, newErrorDiagnostics: unsavedDiagnostics, diagnosticsAfterFix: fixedDiagnostics }, shutdown: { serverPid: pid, observedProcesses: owned, allExited: true }, originalSourceHashes: Object.fromEntries(Object.entries(sources).map(([name, text]) => [name, hash(text)])), limitations: ['No hardware, ports or uploads accessed.', 'This validates the recorded installed executable hashes, not arbitrary server/core/clangd versions.'] };
    return report;
  } catch (error) {
    report = { ...report, error: error instanceof Error ? error.message : String(error), diagnostics: snapshot(), ownedProcesses: owned, endedAt: new Date().toISOString() };
    throw error;
  } finally {
    await service.stop().catch(() => {});
    for (const document of documents) if (document.isDirty) { await vscode.window.showTextDocument(document); await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor'); }
    service.dispose();
    await writeFile(join(rootTemp, 'language-report.json'), JSON.stringify(report, null, 2) + '\n');
    await writeFile(join(rootTemp, 'language-server.log'), log);
  }
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('local-workbench.robotics-workbench');
  assert.ok(extension); await extension.activate();
  const root = resolve(process.env.WORKBENCH_LANGUAGE_ROOT!);
  await mkdir(root, { recursive: true });
  const report = await checkLanguageService(extension.extensionUri, root);
  console.log(JSON.stringify(report));
}
