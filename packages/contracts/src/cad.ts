import type { OperationReceipt } from './project';

export type CadParameter = { value: number | null; unit: 'mm' | 'deg' | 'unitless'; basis: 'design-choice' | 'manufacturer' | 'measured' | 'proposed' | 'unknown'; fitCritical: boolean; uncertainty?: number };
export type CadAsset = { assetId: string; label: string; scriptRelativePath: string; parameterRelativePath: string; localModulePaths: string[]; environmentLockRelativePath: string; dependencyDiscovery: 'declared' | 'dynamic'; componentIds: string[]; dimensionEvidenceRefs: { path: string; sha256: string }[]; output: { linearTolerance: number; angularTolerance: number; expectedBoundsMm: [number, number, number]; boundsToleranceMm: number; expectedVolumeMm3: number; volumeToleranceMm3: number } };
export type CadGeometry = { valid: true; boundsMm: [number, number, number]; volumeMm3: number; stepReopened: true; stlReopened: true; stlUnit: 'mm' };
export type CadAssetStatus = CadAsset & { parameters: Record<string, CadParameter>; currentFingerprint: string | null; issues: string[]; latestOperation: OperationReceipt | null; lastGood: OperationReceipt | null; stale: boolean; viewer: { status: 'handoff-required'; instructions: string[] } };
export type CadSnapshot = { schemaVersion: 1; projectRevision: number; capabilities: { configured: boolean; pythonPath: string | null; viewer: 'explicit-handoff' }; assets: CadAssetStatus[] };
export type CadExport = { path: string; sha256: string; mediaType: string; unit: 'mm'; productionAllowed: boolean };
export type CadViewer = { path: string; script: string; workflow: 'explicit-handoff'; instructions: string[]; status: 'handoff-required' };
export const cadMethodPolicies = {
  'cad.snapshot': { classification: 'read', deadlineMs: 10000 },
  'cad.generate': { classification: 'execute', deadlineMs: 5000 },
  'cad.export': { classification: 'read', deadlineMs: 10000 },
  'cad.viewer': { classification: 'read', deadlineMs: 10000 }
} as const;
const id = { type: 'string', format: 'uuid' }, sha = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
export const cadParamSchemas = {
  'cad.snapshot': object({}),
  'cad.generate': object({ assetId: id, expectedFingerprint: sha, mode: { enum: ['production', 'exploratory'] }, assumptions: { type: 'object', maxProperties: 64, propertyNames: { pattern: '^[A-Za-z][A-Za-z0-9_]{0,63}$' }, additionalProperties: { type: 'number', minimum: -1000000, maximum: 1000000 } } }, ['assetId', 'expectedFingerprint', 'mode']),
  'cad.export': object({ assetId: id, operationId: id, format: { enum: ['step', 'stl'] } }, ['assetId', 'operationId', 'format']),
  'cad.viewer': object({ assetId: id, operationId: id }, ['assetId', 'operationId'])
};

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const text = (value: unknown, max = 512): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const strings = (value: unknown, max: number) => Array.isArray(value) && value.length <= max && value.every(item => text(item, 2048));
const uuid = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const date = (value: unknown) => typeof value === 'string' && value.length <= 40 && value.endsWith('Z') && Number.isFinite(Date.parse(value));
function isOperationReceipt(value: unknown): value is OperationReceipt {
  if (!record(value) || value.schemaVersion !== 1 || !uuid(value.operationId) || !uuid(value.requestId) || !uuid(value.projectId) || value.kind !== 'cad-generate' || !['queued', 'running', 'awaiting-input', 'succeeded', 'failed', 'cancelled', 'outcome-unknown'].includes(String(value.status)) || !Number.isSafeInteger(value.expectedProjectRevision) || Number(value.expectedProjectRevision) < 1 || !date(value.createdAt) || !record(value.tool) || !text(value.tool.name, 128) || !text(value.tool.version, 128)) return false;
  if (value.sourceSnapshotId !== undefined && !uuid(value.sourceSnapshotId) || value.startedAt !== undefined && !date(value.startedAt) || value.finishedAt !== undefined && !date(value.finishedAt) || value.result !== undefined && !record(value.result)) return false;
  if (value.error !== undefined && (!record(value.error) || !text(value.error.code, 128) || !text(value.error.message, 2048) || typeof value.error.retryable !== 'boolean')) return false;
  return Array.isArray(value.artifacts) && value.artifacts.length <= 32 && value.artifacts.every(artifact => record(artifact) && uuid(artifact.artifactId) && digest(artifact.sha256) && text(artifact.mediaType, 128) && text(artifact.relativePath, 512));
}
export function isCadParameter(value: unknown): value is CadParameter {
  return record(value) && (value.value === null || finite(value.value) && Math.abs(value.value) <= 1000000) && (value.value === null) === (value.basis === 'unknown') && ['mm', 'deg', 'unitless'].includes(String(value.unit)) && ['design-choice', 'manufacturer', 'measured', 'proposed', 'unknown'].includes(String(value.basis)) && typeof value.fitCritical === 'boolean' && (value.uncertainty === undefined || finite(value.uncertainty) && value.uncertainty >= 0);
}
export function isCadSnapshot(value: unknown): value is CadSnapshot {
  try { if (new TextEncoder().encode(JSON.stringify(value)).length > 1024 * 1024) return false; } catch { return false; }
  if (!record(value) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.projectRevision) || Number(value.projectRevision) < 1 || !record(value.capabilities) || typeof value.capabilities.configured !== 'boolean' || !(value.capabilities.pythonPath === null || text(value.capabilities.pythonPath, 32768)) || value.capabilities.viewer !== 'explicit-handoff' || !Array.isArray(value.assets) || value.assets.length > 32) return false;
  return value.assets.every(asset => record(asset) && text(asset.assetId) && text(asset.label, 128) && text(asset.scriptRelativePath) && text(asset.parameterRelativePath) && strings(asset.localModulePaths, 64) && text(asset.environmentLockRelativePath) && ['declared', 'dynamic'].includes(String(asset.dependencyDiscovery)) && strings(asset.componentIds, 64) && Array.isArray(asset.dimensionEvidenceRefs) && asset.dimensionEvidenceRefs.length <= 64 && asset.dimensionEvidenceRefs.every(ref => record(ref) && text(ref.path) && typeof ref.sha256 === 'string' && /^[a-f0-9]{64}$/.test(ref.sha256)) && record(asset.output) && Array.isArray(asset.output.expectedBoundsMm) && asset.output.expectedBoundsMm.length === 3 && asset.output.expectedBoundsMm.every(finite) && ['linearTolerance', 'angularTolerance', 'boundsToleranceMm', 'expectedVolumeMm3', 'volumeToleranceMm3'].every(key => finite((asset.output as Record<string, unknown>)[key])) && record(asset.parameters) && Object.keys(asset.parameters).length <= 64 && Object.values(asset.parameters).every(isCadParameter) && (asset.currentFingerprint === null || typeof asset.currentFingerprint === 'string' && /^[a-f0-9]{64}$/.test(asset.currentFingerprint)) && strings(asset.issues, 128) && (asset.latestOperation === null || isOperationReceipt(asset.latestOperation)) && (asset.lastGood === null || isOperationReceipt(asset.lastGood)) && typeof asset.stale === 'boolean' && record(asset.viewer) && asset.viewer.status === 'handoff-required' && strings(asset.viewer.instructions, 8));
}
