import type { OperationReceipt, OperationStatus } from './project';

export type RecoveryOperationSummary = {
  operationId: string; kind: OperationReceipt['kind']; status: OperationStatus;
  createdAt: string; finishedAt?: string; artifactCount: number;
  error?: { code: string; message: string };
};
export type RecoverySnapshot = {
  projectId: string; projectRevision: number; operations: RecoveryOperationSummary[];
  storage: { quarantined: number; missing: number; corrupt: number };
  nextCursor: string | null; notice: string;
};
const statuses = ['queued', 'running', 'awaiting-input', 'succeeded', 'failed', 'cancelled', 'outcome-unknown'];
const kinds = ['compile', 'upload', 'serial-capture', 'kicad-export', 'cad-generate', 'document-ingest', 'experiment-record'];
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit;
const timestamp = (value: unknown) => text(value, 64) && Number.isFinite(Date.parse(value));
const isRequestId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);

export function isRecoverySnapshot(value: unknown): value is RecoverySnapshot {
  if (!value || typeof value !== 'object') return false;
  const s = value as RecoverySnapshot;
  return isRequestId(s.projectId) && count(s.projectRevision) && s.projectRevision > 0
    && Array.isArray(s.operations) && s.operations.length <= 100 && s.operations.every(op => op && isRequestId(op.operationId)
      && kinds.includes(op.kind) && statuses.includes(op.status) && timestamp(op.createdAt)
      && (op.finishedAt === undefined || timestamp(op.finishedAt)) && count(op.artifactCount)
      && (op.error === undefined || !!op.error && text(op.error.code, 128) && text(op.error.message, 2048)))
    && !!s.storage && ['quarantined', 'missing', 'corrupt'].every(key => count(s.storage[key as keyof typeof s.storage]))
    && (s.nextCursor === null || text(s.nextCursor, 512)) && text(s.notice, 2048);
}
