import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkbenchError } from '@robotics-workbench/contracts';

export type ProcessSpec = {
  executable: string;
  args: readonly string[];
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  logDirectory?: string;
  maxLogBytes?: number;
  env?: Record<string, string>;
};
export type ProcessResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutPath?: string;
  stderrPath?: string;
  logsTruncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  terminationObserved: boolean;
};
const environmentKeys = new Set(['systemroot', 'windir', 'comspec', 'temp', 'tmp', 'path', 'pathext', 'userprofile', 'appdata', 'localappdata', 'home', 'lang', 'lc_all', 'arduino_directories_data', 'arduino_directories_downloads', 'arduino_directories_user']);

/** Owns only processes launched here. An unobserved stop disables further execution. */
export class ProcessRunner {
  private active = new Map<AbortController, Promise<ProcessResult>>();
  private stopping = false;
  private terminationFailed = false;

  get isIdle(): boolean { return this.active.size === 0 && !this.terminationFailed && !this.stopping; }

  run(spec: ProcessSpec): Promise<ProcessResult> {
    if (this.stopping || this.terminationFailed) return Promise.reject(new WorkbenchError('DEVICE_BUSY', 'Process supervisor is stopping or requires termination reconciliation.'));
    if (!isAbsolute(spec.executable) || /\.(?:cmd|bat)$/i.test(spec.executable) || !isAbsolute(spec.cwd) || spec.executable.includes('\0') || spec.cwd.includes('\0') || !Array.isArray(spec.args) || spec.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
      return Promise.reject(new WorkbenchError('INVALID_REQUEST', 'Use an absolute executable and working directory with literal argument arrays; batch wrappers require a tested adapter.'));
    }
    const limit = spec.maxOutputBytes ?? 64 * 1024;
    const logLimit = spec.maxLogBytes ?? 64 * 1024 * 1024;
    const timeout = spec.timeoutMs ?? 180000;
    if (![limit, logLimit, timeout].every(Number.isSafeInteger) || limit < 1 || limit > 1024 * 1024 || logLimit < 1 || logLimit > 64 * 1024 * 1024 || timeout < 1 || timeout > 86400000 || (spec.logDirectory && !isAbsolute(spec.logDirectory))) {
      return Promise.reject(new WorkbenchError('INVALID_REQUEST', 'Invalid process output, log, timeout or directory limit.'));
    }
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) if (environmentKeys.has(key.toLowerCase()) && value !== undefined) env[key] = value;
    for (const [key, value] of Object.entries(spec.env ?? {})) {
      if (!environmentKeys.has(key.toLowerCase()) || typeof value !== 'string' || value.includes('\0')) return Promise.reject(new WorkbenchError('INVALID_REQUEST', 'Process environment override is not allowlisted.'));
      for (const existing of Object.keys(env)) if (existing.toLowerCase() === key.toLowerCase()) delete env[existing];
      env[key] = value;
    }
    const controller = new AbortController();
    const externalAbort = () => controller.abort();
    spec.signal?.addEventListener('abort', externalAbort, { once: true });
    if (spec.signal?.aborted) controller.abort();
    const task = this.execute(spec, env, controller, limit, logLimit, timeout).finally(() => {
      spec.signal?.removeEventListener('abort', externalAbort);
      this.active.delete(controller);
    });
    this.active.set(controller, task);
    return task;
  }

  private execute(spec: ProcessSpec, env: NodeJS.ProcessEnv, controller: AbortController, limit: number, logLimit: number, timeoutMs: number): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[][] = [[], []];
      const retained = [0, 0], counts = [0, 0], handles: (number | undefined)[] = [], paths: (string | undefined)[] = [];
      let logsTruncated = false, timedOut = false, finished = false, launchError: Error | undefined, ioError: Error | undefined;
      let deadline: NodeJS.Timeout | undefined, stopDeadline: NodeJS.Timeout | undefined;
      let childClosed: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      let treeStopPending = false, treeStopFinished = false, treeStopSucceeded = false;
      const complete = (code: number | null, signal: NodeJS.Signals | null, observed: boolean) => {
        if (finished) return;
        finished = true; clearTimeout(deadline); clearTimeout(stopDeadline);
        controller.signal.removeEventListener('abort', stop);
        for (const handle of handles) if (handle !== undefined) { try { closeSync(handle); } catch (error) { ioError ??= error as Error; } }
        if (!observed) { this.terminationFailed = true; reject(new WorkbenchError('OUTCOME_UNKNOWN', 'Owned process termination was not observed; reconcile before further execution.')); return; }
        if (launchError) { reject(new WorkbenchError('TOOL_UNAVAILABLE', 'Executable could not be launched; inspect its configured path and permissions.')); return; }
        if (ioError) { reject(new WorkbenchError('INTERNAL_ERROR', 'Process diagnostic storage failed; partial logs were retained.')); return; }
        resolve({ exitCode: code, signal, stdout: Buffer.concat(chunks[0]).toString('utf8'), stderr: Buffer.concat(chunks[1]).toString('utf8'),
          stdoutBytes: counts[0], stderrBytes: counts[1], stdoutTruncated: counts[0] > limit, stderrTruncated: counts[1] > limit,
          ...(paths[0] ? { stdoutPath: paths[0], stderrPath: paths[1] } : {}), logsTruncated, timedOut,
          cancelled: controller.signal.aborted && !timedOut, terminationObserved: observed });
      };
      let child: ChildProcess | undefined;
      const stop = () => {
        if (finished || stopDeadline || !child?.pid) return;
        stopDeadline = setTimeout(() => {
          child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
          complete(null, null, false);
        }, 7000);
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.stdout?.pause(); child.stderr?.pause();
        if (process.platform === 'win32') {
          treeStopPending = true;
          const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => { /* The close deadline records uncertainty if OS termination is unavailable. */ });
          const killTimer = setTimeout(() => killer.kill(), 4000);
          killer.once('close', code => {
            clearTimeout(killTimer); treeStopFinished = true; treeStopSucceeded = code === 0;
            child?.stdout?.resume(); child?.stderr?.resume();
            if (childClosed) complete(childClosed.code, childClosed.signal, treeStopSucceeded);
          });
        } else {
          try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); }
          child.stdout?.resume(); child.stderr?.resume();
        }
      };
      if (controller.signal.aborted) { complete(null, null, true); return; }
      try {
        if (spec.logDirectory) {
          mkdirSync(spec.logDirectory, { recursive: true });
          const id = randomUUID();
          for (const name of ['stdout', 'stderr']) { const path = join(spec.logDirectory, `${id}.${name}.log`); paths.push(path); handles.push(openSync(path, 'wx', 0o600)); }
        }
      } catch (error) { ioError = error as Error; complete(null, null, true); return; }
      try { child = spawn(spec.executable, [...spec.args], { cwd: spec.cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (error) { launchError = error as Error; complete(null, null, true); return; }
      const consume = (index: number, input: Buffer) => {
        if (finished) return;
        const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input);
        const prior = counts[index]; counts[index] = Math.min(Number.MAX_SAFE_INTEGER, prior + chunk.length);
        const keep = chunk.subarray(0, Math.max(0, limit - retained[index]));
        if (keep.length) { chunks[index].push(keep); retained[index] += keep.length; }
        if (handles[index] !== undefined) {
          const writable = chunk.subarray(0, Math.max(0, logLimit - prior));
          try { let offset = 0; while (offset < writable.length) offset += writeSync(handles[index]!, writable, offset); }
          catch (error) { ioError ??= error as Error; controller.abort(); }
          if (counts[index] > logLimit) { logsTruncated = true; controller.abort(); }
        }
      };
      child.stdout!.on('data', chunk => consume(0, chunk));
      child.stderr!.on('data', chunk => consume(1, chunk));
      child.once('error', error => { launchError = error; });
      child.once('close', (code, signal) => {
        childClosed = { code, signal };
        if (!treeStopPending || treeStopFinished) complete(code, signal, !treeStopPending || treeStopSucceeded);
      });
      controller.signal.addEventListener('abort', stop, { once: true });
      if (controller.signal.aborted) stop();
      deadline = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    });
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    const tasks = [...this.active];
    for (const [controller] of tasks) controller.abort();
    const results = await Promise.allSettled(tasks.map(([, task]) => task));
    if (this.terminationFailed || results.some(result => result.status === 'rejected')) throw new WorkbenchError('OUTCOME_UNKNOWN', 'One or more owned process outcomes require reconciliation.');
  }
}
