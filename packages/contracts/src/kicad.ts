/** Version 1 of the bounded native schematic handoff contract. */
export interface KicadDiagnostic { severity: 'error' | 'warning' | 'exclusion'; code: string; message: string; sheetPath?: string }
export interface KicadCapability {
  executable: string; executableSha256: string; version: string; formatVersion: number;
  helpSha256: string; environmentSha256: string; libraryPaths: string[];
}
export interface KicadGeneration {
  generationId: string; operationId: string; origin: 'generated' | 'native';
  projectRevision: number; manifestSha256: string; sourcePath: string | null; sourceSha256: string;
  dependencySha256: string; toolVersion: string; nativeArtifactId: string; nativePath: string;
  createdAt: string; verdict: 'pass' | 'fail'; diagnostics: KicadDiagnostic[];
  netlistEquivalent: boolean | null; sheets: { sheetId: string; name: string; artifactId: string; sha256: string }[];
  files: { name: string; artifactId: string; sha256: string; mediaType: string }[];
  stale: boolean;
}
export interface KicadSnapshot {
  schemaVersion: 1; readiness: { available: boolean; reason: string; capability?: KicadCapability };
  projectRevision: number; manifestSha256: string;
  source: { path: string; sha256: string | null; diverged: boolean } | null;
  generations: KicadGeneration[]; limitations: string[];
}
export interface KicadPreview { generationId: string; sheetId: string; dataUrl: string; sourceSha256: string; projectRevision: number; stale: boolean }
export interface KicadExport { generationId: string; path: string; files: { path: string; sha256: string }[] }
export const kicadMethodPolicies = {
  'kicad.snapshot': { classification: 'read', deadlineMs: 60000 },
  'kicad.generate': { classification: 'execute', deadlineMs: 5000 },
  'kicad.validate': { classification: 'execute', deadlineMs: 5000 },
  'kicad.preview': { classification: 'read', deadlineMs: 10000 },
  'kicad.export': { classification: 'mutate', deadlineMs: 30000 }
} as const;
const sha = { type: 'string', pattern: '^[a-f0-9]{64}$' }, path = { type: 'string', minLength: 1, maxLength: 4096 }, id = { type: 'string', format: 'uuid' };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
export const kicadParamSchemas = {
  'kicad.snapshot': object({ sourcePath: path }),
  'kicad.generate': object({ mappingPath: path, expectedManifestSha256: sha, sourcePath: path, expectedSourceSha256: { anyOf: [sha, { type: 'null' }] } }, ['mappingPath', 'expectedManifestSha256']),
  'kicad.validate': object({ sourcePath: path, expectedSourceSha256: sha }, ['sourcePath', 'expectedSourceSha256']),
  'kicad.preview': object({ generationId: id, sheetId: id }, ['generationId']),
  'kicad.export': object({ generationId: id, destinationPath: path, sourcePath: path, expectedSourceSha256: { anyOf: [sha, { type: 'null' }] } }, ['generationId', 'destinationPath'])
};

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export function isKicadPreview(value: unknown): value is KicadPreview {
  return record(value) && uuid(value.generationId) && uuid(value.sheetId) && typeof value.dataUrl === 'string' && value.dataUrl.length <= 720000 && /^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/.test(value.dataUrl) && digest(value.sourceSha256) && Number.isSafeInteger(value.projectRevision) && Number(value.projectRevision) > 0 && typeof value.stale === 'boolean';
}
export function isKicadSnapshot(value: unknown): value is KicadSnapshot {
  if (!record(value) || value.schemaVersion !== 1 || !record(value.readiness) || typeof value.readiness.available !== 'boolean' || typeof value.readiness.reason !== 'string' || !Number.isSafeInteger(value.projectRevision) || !digest(value.manifestSha256) || !Array.isArray(value.limitations) || !value.limitations.every(item => typeof item === 'string') || !Array.isArray(value.generations) || value.generations.length > 20) return false;
  if (value.source !== null && (!record(value.source) || typeof value.source.path !== 'string' || value.source.sha256 !== null && !digest(value.source.sha256) || typeof value.source.diverged !== 'boolean')) return false;
  return value.generations.every(item => record(item) && uuid(item.generationId) && uuid(item.operationId) && ['generated', 'native'].includes(String(item.origin)) && Number.isSafeInteger(item.projectRevision) && digest(item.manifestSha256) && digest(item.sourceSha256) && digest(item.dependencySha256) && typeof item.nativePath === 'string' && uuid(item.nativeArtifactId) && typeof item.toolVersion === 'string' && typeof item.createdAt === 'string' && typeof item.stale === 'boolean' && ['pass', 'fail'].includes(String(item.verdict)) && [true, false, null].includes(item.netlistEquivalent as boolean | null) && Array.isArray(item.diagnostics) && item.diagnostics.every(diagnostic => record(diagnostic) && ['error', 'warning', 'exclusion'].includes(String(diagnostic.severity)) && typeof diagnostic.code === 'string' && typeof diagnostic.message === 'string') && Array.isArray(item.sheets) && item.sheets.length <= 16 && item.sheets.every(sheet => record(sheet) && uuid(sheet.sheetId) && typeof sheet.name === 'string' && uuid(sheet.artifactId) && digest(sheet.sha256)) && Array.isArray(item.files) && item.files.length <= 32 && item.files.every(file => record(file) && typeof file.name === 'string' && uuid(file.artifactId) && digest(file.sha256) && typeof file.mediaType === 'string'));
}
