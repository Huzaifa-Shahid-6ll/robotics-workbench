import * as vscode from 'vscode';
import { LanguageClient, ErrorAction, CloseAction, RevealOutputChannelOn, type InitializeParams } from 'vscode-languageclient/node';
import { relative, isAbsolute } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { WorkbenchManifest } from '@robotics-workbench/contracts';
import { languagePlan } from './language-plan';

class ArduinoClient extends LanguageClient {
  protected override fillInitializeParams(params: InitializeParams): void {
    super.fillInitializeParams(params);
    // The installed ALS bridge panics when clangd sends this advertised-but-unimplemented request.
    if (params.capabilities.workspace?.semanticTokens) params.capabilities.workspace.semanticTokens.refreshSupport = false;
  }
}

/** Explicitly started, project-scoped language features; never a build/upload owner. */
export class ArduinoLanguageService implements vscode.Disposable {
  private client?: LanguageClient;
  private child?: ChildProcess;
  private starting = false;
  constructor(private readonly output = vscode.window.createOutputChannel('Robotics Arduino Language Service')) {}
  get processId(): number | undefined { return this.child?.pid; }
  get serverInfo(): unknown { return this.client?.initializeResult?.serverInfo ?? null; }
  async start(root: string, sketch: WorkbenchManifest['sketches'][number], target: WorkbenchManifest['targets'][number], tools: Parameters<typeof languagePlan>[3]): Promise<void> {
    if (!vscode.workspace.isTrusted || vscode.env.remoteName) throw Error('Trust a local workspace before starting Arduino language tools.');
    if (this.starting) throw Error('Arduino language service is already starting.');
    this.starting = true;
    try {
      await this.stop();
      const plan = languagePlan(root, sketch, target, tools);
      const folder: vscode.WorkspaceFolder = { uri: vscode.Uri.file(plan.cwd), name: 'Arduino sketch', index: 0 };
      const client = this.client = new ArduinoClient('roboticsArduino', 'Robotics Arduino', async () => {
        const child = this.child = spawn(plan.command, plan.args, { cwd: plan.cwd, shell: false, windowsHide: true, stdio: 'pipe' });
        child.once('close', () => { if (this.child === child) this.child = undefined; });
        return child;
      }, {
        documentSelector: [{ scheme: 'file', pattern: vscode.Uri.file(plan.cwd).fsPath.replaceAll('\\', '/').replace(/[[\]{}*?]/g, char => `[${char}]`) + '/**/*.{ino,h,hpp,c,cpp}' }],
        workspaceFolder: folder, diagnosticCollectionName: 'roboticsArduino', outputChannel: this.output,
        revealOutputChannelOn: RevealOutputChannelOn.Never, markdown: { isTrusted: false, supportHtml: false },
        connectionOptions: { maxRestartCount: 0 },
        errorHandler: { error: () => ({ action: ErrorAction.Shutdown }), closed: () => ({ action: CloseAction.DoNotRestart }) },
        middleware: { handleDiagnostics: (uri, diagnostics, next) => {
          const local = relative(plan.cwd, uri.fsPath);
          if (uri.scheme === 'file' && !isAbsolute(local) && local !== '..' && !local.startsWith('..\\') && !local.startsWith('../')) next(uri, diagnostics);
        } }
      });
      try { await client.start(); } catch (error) { await this.stop(); throw error; }
    } finally { this.starting = false; }
  }
  async stop(): Promise<void> {
    const client = this.client, child = this.child; this.client = undefined;
    if (client) await client.stop(5000);
    if (child && this.child === child) await new Promise<void>((resolveStop, reject) => {
      const timer = setTimeout(() => reject(Error('Arduino language server did not close its owned streams after shutdown.')), 5000);
      child.once('close', () => { clearTimeout(timer); resolveStop(); });
    });
  }
  dispose(): void { void this.stop().finally(() => this.output.dispose()); }
}
