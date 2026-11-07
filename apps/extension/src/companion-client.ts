import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { isControlResponse, isProjectResponse, methodPolicies, type ControlRequest, type ControlResult, type ProjectRequest } from '@robotics-workbench/contracts';

export class CompanionClient {
  private child?: ChildProcess;
  private starting?: Promise<ControlResult>;
  private stopping?: Promise<void>;
  private exited?: Promise<void>;
  private pending = new Map<string, { resolve: (result: ControlResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private projectPending = new Map<string, { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly script: string, private readonly executable: string, private readonly log: (line: string) => void, private readonly onDisconnected: () => void = () => {}, private readonly project?: { projectRoot: string; dataRoot: string; arduinoPath?: string; nativeBindingPath?: string; codexPath?: string; opencodePath?: string; kicadPath?: string; kicadSha256?: string; cadPythonPath?: string }) {}

  get pid(): number | undefined { return this.child?.pid; }

  start(): Promise<ControlResult> {
    if (this.stopping) return Promise.reject(new Error('Companion shutdown is in progress.'));
    if (this.starting) return this.starting;
    this.starting = this.connect().catch(async error => {
      await this.stop();
      throw error;
    });
    return this.starting;
  }

  private async connect(): Promise<ControlResult> {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const args = this.project ? ['--project-root', this.project.projectRoot, '--data-root', this.project.dataRoot] : [];
    if (this.project?.arduinoPath) args.push('--arduino-path', this.project.arduinoPath);
    if (this.project?.nativeBindingPath) args.push('--native-binding-path', this.project.nativeBindingPath);
    if (this.project?.codexPath) args.push('--codex-path', this.project.codexPath);
    if (this.project?.opencodePath) args.push('--opencode-path', this.project.opencodePath);
    if (this.project?.kicadPath) args.push('--kicad-path', this.project.kicadPath);
    if (this.project?.kicadSha256) args.push('--kicad-sha256', this.project.kicadSha256);
    if (this.project?.cadPythonPath) args.push('--cad-python-path', this.project.cadPythonPath);
    const child = spawn(this.executable, [this.script, ...args], {
      env, cwd: dirname(this.script),
      serialization: 'json', stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true
    });
    this.child = child;
    this.exited = new Promise<void>(resolve => {
      child.once('close', () => {
        this.rejectPending(new Error('Companion disconnected. Run Robotics: Check Tools to reconnect.'));
        this.child = undefined;
        this.starting = undefined;
        resolve();
        this.onDisconnected();
      });
    });
    child.on('error', error => this.rejectPending(error));
    child.on('disconnect', () => this.rejectPending(new Error('Companion IPC disconnected.')));
    child.stdout?.on('data', () => { /* Protocol uses IPC; stdout is not authoritative. */ });
    child.stderr?.on('data', chunk => this.log(String(chunk).slice(0, 4096).trim()));
    child.on('message', (message: unknown) => {
      if (isProjectResponse(message) && this.projectPending.has(message.requestId)) {
        const pending = this.projectPending.get(message.requestId)!;
        clearTimeout(pending.timer);
        this.projectPending.delete(message.requestId);
        if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
        else pending.resolve(message.result);
        return;
      }
      if (!isControlResponse(message)) {
        if (isProjectResponse(message)) return; // A timed-out request can still have an attributable late response.
        this.rejectPending(new Error('INVALID_REQUEST: Companion sent an invalid response.'));
        child.kill();
        return;
      }
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.requestId);
      if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else pending.resolve(message.result);
    });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const result = await this.request('companion.hello');
    if (result.state !== 'ready' || result.pid !== child.pid) throw new Error('INVALID_REQUEST: Companion identity mismatch.');
    this.log(`Connected to companion PID ${result.pid}, ${result.runtimeVersion}.`);
    return result;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const pending of this.projectPending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.projectPending.clear();
  }

  async requestProject(request: ProjectRequest): Promise<unknown> {
    await this.start();
    if (!this.project) throw new Error('UNAUTHORIZED_SCOPE: No project is bound to this connection.');
    return new Promise((resolve, reject) => {
      if (this.projectPending.has(request.requestId)) { reject(new Error('REQUEST_ID_CONFLICT: Request is already pending.')); return; }
      const timer = setTimeout(() => { this.projectPending.delete(request.requestId); reject(new Error('TIMEOUT: Query the operation before retrying a mutation.')); }, methodPolicies[request.method]?.deadlineMs ?? 10000);
      this.projectPending.set(request.requestId, { resolve, reject, timer });
      this.child!.send(request, error => {
        if (!error) return;
        clearTimeout(timer); this.projectPending.delete(request.requestId); reject(error);
      });
    });
  }

  private request(method: ControlRequest['method']): Promise<ControlResult> {
    return new Promise((resolve, reject) => {
      const child = this.child;
      if (!child?.connected) { reject(new Error('Companion is disconnected.')); return; }
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`TIMEOUT: ${method} exceeded 5 seconds.`));
      }, 5000);
      this.pending.set(requestId, { resolve, reject, timer });
      child.send({ schemaVersion: 1, requestId, method, params: {} } satisfies ControlRequest, error => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.shutdown().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  private async shutdown(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      const response = await this.request('companion.shutdown');
      if (response.state !== 'stopping') throw new Error('Invalid shutdown acknowledgement.');
    } catch (error) {
      this.log(`Graceful shutdown unavailable: ${String(error)}`);
      child.kill();
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([this.exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { child.kill(); reject(new Error('TIMEOUT: Companion exit was not observed. Inspect operation receipts before retrying effects.')); }, 10000);
      })]);
    } finally { clearTimeout(timer); }
    this.starting = undefined;
  }
}
