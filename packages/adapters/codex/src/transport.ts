import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute, join } from 'node:path';

export interface RpcMessage { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: unknown }
export interface CodexTransport {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string): void;
  respond(id: string | number, result: unknown): void;
  listen(message: (value: RpcMessage) => void, disconnected: () => void): void;
  close(): Promise<void>;
}
export class CodexError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export function nativeVersion(executable: string): Promise<string> {
  if (!isAbsolute(executable)) throw new CodexError('PROVIDER_NOT_FOUND', 'Configure an absolute native Codex executable.');
  return new Promise((resolve, reject) => execFile(executable, ['--version'], { windowsHide: true, timeout: 10000, maxBuffer: 4096 }, (error, stdout) => {
    if (error) reject(new CodexError('PROVIDER_NOT_FOUND', 'Codex version inspection failed.'));
    else resolve(stdout.trim());
  }));
}

/** One owned stdio app-server; diagnostics never enter protocol or renderer output. */
export class StdioCodexTransport implements CodexTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private sequence = 0;
  private buffer = '';
  private ended = false;
  private onMessage: (value: RpcMessage) => void = () => {};
  private onDisconnected: () => void = () => {};
  constructor(executable: string, cwd: string) {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'CODEX_HOME']) if (process.env[key]) env[key] = process.env[key];
    this.child = spawn(executable, ['app-server', '--stdio'], { cwd, windowsHide: true, shell: false, env, stdio: 'pipe' });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 2 * 1024 * 1024) return this.fail();
      for (let index; (index = this.buffer.indexOf('\n')) >= 0;) {
        const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
        try {
          const value: unknown = JSON.parse(line);
          if (!value || typeof value !== 'object' || Array.isArray(value)) return this.fail();
          const message = value as RpcMessage;
          if (message.method !== undefined && typeof message.method !== 'string') return this.fail();
          if ('id' in message && !(typeof message.id === 'string' && message.id.length <= 512) && !(typeof message.id === 'number' && Number.isSafeInteger(message.id))) return this.fail();
          if (message.method) this.onMessage(message);
          else if (typeof message.id === 'number' && this.pending.has(message.id)) {
            const pending = this.pending.get(message.id)!; this.pending.delete(message.id); clearTimeout(pending.timer);
            if (message.error) {
              const detail = typeof message.error === 'object' && message.error !== null && 'message' in message.error && typeof message.error.message === 'string' ? message.error.message : '';
              const code = /authenticat|log.?in|unauthorized/i.test(detail) ? 'AUTH_REQUIRED' : /rate.?limit|\b429\b/i.test(detail) ? 'RATE_LIMITED' : /model.*(?:unavailable|not found|not supported)/i.test(detail) ? 'MODEL_UNAVAILABLE' : 'PROTOCOL_ERROR';
              pending.reject(new CodexError(code, 'Codex rejected the request; inspect provider readiness and permissions.'));
            }
            else if ('result' in message) pending.resolve(message.result);
            else pending.reject(new CodexError('PROTOCOL_ERROR', 'Codex returned an invalid response.'));
          }
        } catch { this.fail(); }
      }
    });
    this.child.stderr.resume();
    this.child.stdin.on('error', () => this.fail());
    this.child.on('error', () => this.fail()); this.child.on('close', () => this.fail());
  }
  listen(message: (value: RpcMessage) => void, disconnected: () => void): void { this.onMessage = message; this.onDisconnected = disconnected; }
  private send(value: unknown): void {
    if (this.ended) throw new CodexError('TRANSPORT_LOST', 'Codex disconnected; reconcile before submitting again.');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new CodexError('TRANSPORT_LOST', 'Codex acknowledgement deadline exceeded; delivery is unknown.')); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  notify(method: string): void { this.send({ method }); }
  respond(id: string | number, result: unknown): void { this.send({ id, result }); }
  private fail(): void {
    if (this.ended) return; this.ended = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new CodexError('TRANSPORT_LOST', 'Codex disconnected; request delivery may be unknown.')); }
    this.pending.clear(); this.onDisconnected(); this.killTree();
  }
  private killTree(): void {
    if (this.child.exitCode !== null || this.child.signalCode !== null || !this.child.pid) return;
    if (process.platform === 'win32') {
      const killer = spawn(join(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
      killer.on('error', () => this.child.kill());
    } else this.child.kill('SIGTERM');
  }
  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.killTree(); }, 5000);
      this.child.once('close', () => { clearTimeout(timer); resolve(); });
    });
    this.fail();
  }
}
