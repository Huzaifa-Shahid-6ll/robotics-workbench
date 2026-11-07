import type { OperationStatus } from './project';

export const DIAGNOSTIC_BUNDLE_BYTES = 64 * 1024;
export const DIAGNOSTIC_MEDIA_TYPE = 'application/vnd.robotics-workbench.diagnostics+json';
export const DIAGNOSTIC_PRIVACY_NOTICE = 'Historical receipts do not establish current tool readiness, firmware, physical wiring or behavior. Source, serial bytes, document text, provider transcripts, credentials, private paths and raw log text are excluded.';
export const diagnosticMethodPolicies = {
  'diagnostics.preview': { classification: 'read', deadlineMs: 10000 },
  'diagnostics.export': { classification: 'mutate', deadlineMs: 10000 }
} as const;
const id = { type: 'string', format: 'uuid' }, sha = { type: 'string', pattern: '^[a-f0-9]{64}$' };
export const diagnosticParamSchemas = {
  'diagnostics.preview': { type: 'object', properties: {}, additionalProperties: false },
  'diagnostics.export': { type: 'object', properties: { previewId: id, expectedBundleSha256: sha, destination: { type: 'string', minLength: 1, maxLength: 32768 } }, required: ['previewId', 'expectedBundleSha256', 'destination'], additionalProperties: false }
};
export const diagnosticLogTypes = ['project.changed', 'request.admitted', 'operation.changed', 'operation.cancel-admitted', 'operation.cancel-requested', 'build.failed', 'design.changed', 'design.unchanged', 'recording.recovery-failed', 'agent.session.opened', 'agent.turn.started', 'agent.text.delta', 'agent.tool.started', 'agent.tool.finished', 'agent.approval.requested', 'agent.turn.finished', 'agent.connection.changed', 'other-redacted'] as const;
export type DiagnosticToolId = 'arduino-cli' | 'kicad-cli' | 'cadquery' | 'codex' | 'opencode';
export type DiagnosticBundleV1 = {
  schemaVersion: 1; kind: 'workbench-diagnostics'; privacy: 'default-private'; observedAt: string;
  scope: { projectId: string; projectRevision: number; epoch: string; snapshotSequence: number };
  versions: { app: string; companionNode: string; sqlite: string | null; modulesAbi: string | null; platform: string; arch: string; osRelease: string | null };
  configuration: { dataRoot: 'external-local'; companionRuntime: 'detected-local-node'; telemetry: 'disabled'; privatePayloadsIncluded: false };
  tools: { toolId: DiagnosticToolId; version: string | null; basis: 'retained-operation' | 'not-recorded'; observedAt: string | null; currentVerified: false }[];
  operations: { operationId: string; kind: string; status: OperationStatus; createdAt: string; finishedAt: string | null; artifactCount: number; errorPresent: boolean }[];
  logs: { sequence: number; type: typeof diagnosticLogTypes[number]; occurredAt: string; operationId: string | null }[];
  storage: { databaseBytes: number; freeBytes: string | null; recoveryBasis: 'companion-startup-scan'; quarantined: number; missing: number; corrupt: number };
  omitted: { operations: number; olderLogWindow: boolean };
  notice: typeof DIAGNOSTIC_PRIVACY_NOTICE;
};
export type DiagnosticPreviewV1 = { schemaVersion: 1; previewId: string; projectId: string; projectRevision: number; createdAt: string; bundleSha256: string; byteLength: number; text: string };
export type DiagnosticExportResultV1 = { previewId: string; bundleSha256: string; byteLength: number; destination: string };

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const revision = (value: unknown): value is number => count(value) && value > 0;
const timestamp = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && value.endsWith('Z') && Number.isFinite(Date.parse(value));
const version = (value: unknown): value is string => typeof value === 'string' && /^\d{1,6}(?:\.\d{1,6}){1,3}$/.test(value);
const statuses = ['queued', 'running', 'awaiting-input', 'succeeded', 'failed', 'cancelled', 'outcome-unknown'];
const operationKinds = ['compile', 'upload', 'serial-capture', 'kicad-export', 'cad-generate', 'document-ingest', 'experiment-record'];
const toolIds = ['arduino-cli', 'kicad-cli', 'cadquery', 'codex', 'opencode'];
const byteLength = (value: string) => new TextEncoder().encode(value).length;

export function isDiagnosticBundle(value: unknown): value is DiagnosticBundleV1 {
  try { if (byteLength(JSON.stringify(value)) > DIAGNOSTIC_BUNDLE_BYTES) return false; } catch { return false; }
  if (!record(value) || !keys(value, ['schemaVersion', 'kind', 'privacy', 'observedAt', 'scope', 'versions', 'configuration', 'tools', 'operations', 'logs', 'storage', 'omitted', 'notice']) || value.schemaVersion !== 1 || value.kind !== 'workbench-diagnostics' || value.privacy !== 'default-private' || !timestamp(value.observedAt)) return false;
  const scope = value.scope, versions = value.versions, configuration = value.configuration, storage = value.storage, omitted = value.omitted;
  if (!record(scope) || !keys(scope, ['projectId', 'projectRevision', 'epoch', 'snapshotSequence']) || !uuid(scope.projectId) || !revision(scope.projectRevision) || !uuid(scope.epoch) || !count(scope.snapshotSequence)) return false;
  if (!record(versions) || !keys(versions, ['app', 'companionNode', 'sqlite', 'modulesAbi', 'platform', 'arch', 'osRelease']) || !version(versions.app) || !version(versions.companionNode) || !(versions.sqlite === null || version(versions.sqlite)) || !(versions.modulesAbi === null || typeof versions.modulesAbi === 'string' && /^\d{1,6}$/.test(versions.modulesAbi)) || !['win32', 'linux', 'darwin', 'aix', 'freebsd', 'openbsd', 'sunos', 'android'].includes(String(versions.platform)) || !['x64', 'arm64', 'ia32', 'arm', 'ppc', 'ppc64', 's390', 's390x', 'mips', 'mipsel', 'riscv64', 'loong64'].includes(String(versions.arch)) || !(versions.osRelease === null || version(versions.osRelease))) return false;
  if (!record(configuration) || !keys(configuration, ['dataRoot', 'companionRuntime', 'telemetry', 'privatePayloadsIncluded']) || configuration.dataRoot !== 'external-local' || configuration.companionRuntime !== 'detected-local-node' || configuration.telemetry !== 'disabled' || configuration.privatePayloadsIncluded !== false) return false;
  if (!Array.isArray(value.tools) || value.tools.length !== 5 || new Set(value.tools.map(tool => record(tool) && tool.toolId)).size !== 5 || !value.tools.every(tool => record(tool) && keys(tool, ['toolId', 'version', 'basis', 'observedAt', 'currentVerified']) && toolIds.includes(String(tool.toolId)) && (tool.version === null || version(tool.version)) && ['retained-operation', 'not-recorded'].includes(String(tool.basis)) && (tool.observedAt === null || timestamp(tool.observedAt)) && tool.currentVerified === false && (tool.basis === 'not-recorded' ? tool.version === null && tool.observedAt === null : tool.version !== null && tool.observedAt !== null))) return false;
  if (!Array.isArray(value.operations) || value.operations.length > 100 || !value.operations.every(operation => record(operation) && keys(operation, ['operationId', 'kind', 'status', 'createdAt', 'finishedAt', 'artifactCount', 'errorPresent']) && uuid(operation.operationId) && operationKinds.includes(String(operation.kind)) && statuses.includes(String(operation.status)) && timestamp(operation.createdAt) && (operation.finishedAt === null || timestamp(operation.finishedAt)) && count(operation.artifactCount) && typeof operation.errorPresent === 'boolean')) return false;
  if (!Array.isArray(value.logs) || value.logs.length > 100 || !value.logs.every(log => record(log) && keys(log, ['sequence', 'type', 'occurredAt', 'operationId']) && revision(log.sequence) && diagnosticLogTypes.includes(log.type as typeof diagnosticLogTypes[number]) && timestamp(log.occurredAt) && (log.operationId === null || uuid(log.operationId)))) return false;
  return record(storage) && keys(storage, ['databaseBytes', 'freeBytes', 'recoveryBasis', 'quarantined', 'missing', 'corrupt']) && count(storage.databaseBytes) && (storage.freeBytes === null || typeof storage.freeBytes === 'string' && /^\d{1,32}$/.test(storage.freeBytes)) && storage.recoveryBasis === 'companion-startup-scan' && count(storage.quarantined) && count(storage.missing) && count(storage.corrupt)
    && record(omitted) && keys(omitted, ['operations', 'olderLogWindow']) && count(omitted.operations) && typeof omitted.olderLogWindow === 'boolean'
    && value.notice === DIAGNOSTIC_PRIVACY_NOTICE;
}

export function isDiagnosticPreview(value: unknown): value is DiagnosticPreviewV1 {
  if (!record(value) || !keys(value, ['schemaVersion', 'previewId', 'projectId', 'projectRevision', 'createdAt', 'bundleSha256', 'byteLength', 'text']) || value.schemaVersion !== 1 || !uuid(value.previewId) || !uuid(value.projectId) || !revision(value.projectRevision) || !timestamp(value.createdAt) || !digest(value.bundleSha256) || !count(value.byteLength) || value.byteLength > DIAGNOSTIC_BUNDLE_BYTES || typeof value.text !== 'string' || byteLength(value.text) !== value.byteLength) return false;
  try { const bundle = JSON.parse(value.text); return isDiagnosticBundle(bundle) && bundle.scope.projectId === value.projectId && bundle.scope.projectRevision === value.projectRevision && bundle.observedAt === value.createdAt; } catch { return false; }
}
export function isDiagnosticExportResult(value: unknown): value is DiagnosticExportResultV1 {
  return record(value) && keys(value, ['previewId', 'bundleSha256', 'byteLength', 'destination']) && uuid(value.previewId) && digest(value.bundleSha256) && count(value.byteLength) && value.byteLength <= DIAGNOSTIC_BUNDLE_BYTES && typeof value.destination === 'string' && value.destination.length > 0 && value.destination.length <= 32768;
}
