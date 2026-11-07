import { WorkbenchError, type ErrorResult, type OperationReceipt, type OperationStatus } from '@robotics-workbench/contracts';

type ReceiptPatch = Partial<Pick<OperationReceipt, 'artifacts' | 'error' | 'result' | 'startedAt' | 'finishedAt'>>;
export interface OperationRepository {
  getProject(projectId: string): { projectRevision: number };
  createOperation(receipt: OperationReceipt, payload: unknown): OperationReceipt;
  getOperation(projectId: string, operationId: string): OperationReceipt;
  getOperationByRequest(projectId: string, requestId: string): OperationReceipt;
  transitionOperation(projectId: string, operationId: string, status: OperationStatus, patch?: ReceiptPatch): OperationReceipt;
  appendEvent(projectId: string, projectRevision: number, type: string, payload: Record<string, unknown>, operationId?: string): unknown;
  reconcileOperations(): OperationReceipt[];
}
export type JobContext = { signal: AbortSignal; receipt: OperationReceipt };
export type JobOutput = Pick<ReceiptPatch, 'artifacts' | 'result'>;
export type JobSubmission = {
  receipt: OperationReceipt;
  payload: unknown;
  heavy?: boolean;
  cancellable?: boolean;
  preflight?: () => void | Promise<void>;
  /** Resolves only after owned subprocesses/effects have an observed result. */
  execute: (context: JobContext) => Promise<JobOutput | void>;
};
type Entry = {
  input: JobSubmission; receipt: OperationReceipt; controller: AbortController; started: boolean; settled: boolean;
  promise: Promise<OperationReceipt>; resolve: (receipt: OperationReceipt) => void; reject: (error: unknown) => void;
};
const terminal = (status: OperationStatus) => ['succeeded', 'failed', 'cancelled', 'outcome-unknown'].includes(status);

/** Admission persists intent synchronously; execution starts in a later microtask. */
export class JobCoordinator {
  private entries = new Map<string, Entry>();
  private recent: string[] = [];
  private heavyRunning = false;
  private stopping = false;

  constructor(private readonly repository: OperationRepository) { repository.reconcileOperations(); }
  get isIdle(): boolean { return [...this.entries.values()].every(entry => entry.settled); }

  submit(input: JobSubmission): OperationReceipt {
    if (this.stopping) throw new WorkbenchError('DEVICE_BUSY', 'Job coordinator is shutting down.');
    let existing: OperationReceipt | undefined;
    try { existing = this.repository.getOperationByRequest(input.receipt.projectId, input.receipt.requestId); }
    catch (error) { if (!(error instanceof WorkbenchError) || error.code !== 'NOT_FOUND') throw error; }
    if (!existing && [...this.entries.values()].filter(entry => !entry.settled).length >= 256) throw new WorkbenchError('DEVICE_BUSY', 'Job queue is full; wait for admitted operations to finish.');
    const receipt = this.repository.createOperation(structuredClone(input.receipt), input.payload);
    if (existing || terminal(receipt.status)) return receipt;
    let resolve!: Entry['resolve'], reject!: Entry['reject'];
    const promise = new Promise<OperationReceipt>((accept, refuse) => { resolve = accept; reject = refuse; });
    // A persisted failure is observable through operation.get even if nobody awaits this in-process handle.
    void promise.catch(() => {});
    const frozen: JobSubmission = { ...input, receipt: structuredClone(receipt), payload: structuredClone(input.payload),
      heavy: input.heavy ?? ['compile', 'cad-generate', 'document-ingest'].includes(receipt.kind) };
    this.entries.set(receipt.operationId, { input: frozen, receipt, controller: new AbortController(), started: false, settled: false, promise, resolve, reject });
    queueMicrotask(() => this.pump());
    return receipt;
  }

  requestCancel(projectId: string, operationId: string): OperationReceipt {
    const current = this.repository.getOperation(projectId, operationId);
    if (terminal(current.status)) return current;
    const entry = this.entries.get(operationId);
    if (!entry || entry.receipt.projectId !== projectId) throw new WorkbenchError('NOT_FOUND', 'Operation is not owned by this running coordinator.');
    if (entry.input.cancellable === false && current.status !== 'queued') throw new WorkbenchError('CANCEL_UNSUPPORTED', 'This operation has no supported interruption path.');
    this.repository.appendEvent(projectId, current.expectedProjectRevision, 'operation.cancel-requested', {}, operationId);
    entry.controller.abort();
    if (current.status === 'queued') {
      entry.receipt = this.repository.transitionOperation(projectId, operationId, 'cancelled');
      if (!entry.started) this.finish(entry);
    }
    return this.repository.getOperation(projectId, operationId);
  }

  wait(operationId: string): Promise<OperationReceipt> {
    const entry = this.entries.get(operationId);
    if (!entry) return Promise.reject(new WorkbenchError('NOT_FOUND', 'No recent in-process job handle; query the durable operation receipt.'));
    return entry.promise;
  }

  private pump(): void {
    for (const entry of this.entries.values()) {
      if (entry.started || entry.settled || (entry.input.heavy && this.heavyRunning)) continue;
      entry.started = true;
      if (entry.input.heavy) this.heavyRunning = true;
      void this.run(entry).finally(() => { if (entry.input.heavy) this.heavyRunning = false; this.pump(); });
    }
  }

  private async run(entry: Entry): Promise<void> {
    try {
      const checkRevision = () => {
        if (this.repository.getProject(entry.receipt.projectId).projectRevision !== entry.receipt.expectedProjectRevision) throw new WorkbenchError('REVISION_CONFLICT', 'Queued operation refers to a stale project revision.');
      };
      checkRevision();
      await entry.input.preflight?.();
      checkRevision();
      if (entry.controller.signal.aborted) {
        if (!terminal(entry.receipt.status)) entry.receipt = this.repository.transitionOperation(entry.receipt.projectId, entry.receipt.operationId, 'cancelled');
      } else {
        entry.receipt = this.repository.transitionOperation(entry.receipt.projectId, entry.receipt.operationId, 'running');
        const result = await entry.input.execute({ signal: entry.controller.signal, receipt: structuredClone(entry.receipt) });
        const status = entry.controller.signal.aborted ? entry.receipt.kind === 'upload' ? 'outcome-unknown' : 'cancelled' : 'succeeded';
        entry.receipt = this.repository.transitionOperation(entry.receipt.projectId, entry.receipt.operationId, status, result ?? {});
      }
      this.finish(entry);
    } catch (error) {
      try {
        if (!terminal(entry.receipt.status)) {
          const status = entry.receipt.status !== 'queued' && error instanceof WorkbenchError && error.code === 'OUTCOME_UNKNOWN' ? 'outcome-unknown'
            : entry.controller.signal.aborted && entry.receipt.status !== 'queued' ? entry.receipt.kind === 'upload' ? 'outcome-unknown' : 'cancelled' : 'failed';
          const diagnostic: ErrorResult = error instanceof WorkbenchError
            ? { code: error.code, message: error.message.slice(0, 2048), retryable: error.retryable }
            : { code: 'INTERNAL_ERROR', message: 'Operation failed; inspect its retained diagnostic artifacts.', retryable: false };
          entry.receipt = this.repository.transitionOperation(entry.receipt.projectId, entry.receipt.operationId, status, { error: diagnostic });
        }
        this.finish(entry);
      } catch (persistenceError) { entry.settled = true; entry.reject(persistenceError); }
    }
  }

  private finish(entry: Entry): void {
    if (entry.settled) return;
    entry.settled = true; entry.resolve(entry.receipt);
    this.recent.push(entry.receipt.operationId);
    // shortcut: only 256 settled wait handles stay in memory; older history uses durable operation.get.
    if (this.recent.length > 256) this.entries.delete(this.recent.shift()!);
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const entry of this.entries.values()) if (!entry.settled) {
      entry.controller.abort();
      if (entry.receipt.status === 'queued') {
        entry.receipt = this.repository.transitionOperation(entry.receipt.projectId, entry.receipt.operationId, 'cancelled');
        if (!entry.started) this.finish(entry);
      }
    }
    await Promise.all([...this.entries.values()].filter(entry => !entry.settled).map(entry => entry.promise));
  }
}
