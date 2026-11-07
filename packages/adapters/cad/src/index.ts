import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { WorkbenchError } from '@robotics-workbench/contracts';
import type { CadAsset, CadParameter } from '@robotics-workbench/contracts';
import type { ProjectFiles } from '@robotics-workbench/application';

export const cadHash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const path = { type: 'string', minLength: 1, maxLength: 512 }, positive = { type: 'number', exclusiveMinimum: 0, maximum: 1000000000 };
const ajv = new Ajv({ strict: true, ownProperties: true }); addFormats(ajv);
const assetSchema = object({ assetId: { type: 'string', format: 'uuid' }, label: { type: 'string', minLength: 1, maxLength: 128 }, scriptRelativePath: path, parameterRelativePath: path, localModulePaths: { type: 'array', maxItems: 64, uniqueItems: true, items: path }, environmentLockRelativePath: path, dependencyDiscovery: { enum: ['declared', 'dynamic'] }, componentIds: { type: 'array', maxItems: 64, uniqueItems: true, items: { type: 'string', format: 'uuid' } }, dimensionEvidenceRefs: { type: 'array', maxItems: 64, items: object({ path, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } }) }, output: object({ linearTolerance: positive, angularTolerance: positive, expectedBoundsMm: { type: 'array', minItems: 3, maxItems: 3, items: positive }, boundsToleranceMm: positive, expectedVolumeMm3: positive, volumeToleranceMm3: positive }) });
const assetsValid = ajv.compile<{ schemaVersion: 1; assets: CadAsset[] }>(object({ schemaVersion: { const: 1 }, assets: { type: 'array', maxItems: 32, items: assetSchema } }));
const parametersValid = ajv.compile<Record<string, CadParameter>>({ type: 'object', maxProperties: 64, propertyNames: { pattern: '^[A-Za-z][A-Za-z0-9_]{0,63}$' }, additionalProperties: object({ value: { type: ['number', 'null'], minimum: -1000000, maximum: 1000000 }, unit: { enum: ['mm', 'deg', 'unitless'] }, basis: { enum: ['design-choice', 'manufacturer', 'measured', 'proposed', 'unknown'] }, fitCritical: { type: 'boolean' }, uncertainty: { type: 'number', minimum: 0, maximum: 1000000 } }, ['value', 'unit', 'basis', 'fitCritical']) });
export const cadEnvironmentValid = ajv.compile<{ python: string; packages: Record<string, string> }>(object({ python: { type: 'string', pattern: '^3\\.[0-9]+\\.[0-9]+$' }, packages: { type: 'object', minProperties: 2, maxProperties: 512, propertyNames: { pattern: '^[A-Za-z0-9_.-]{1,100}$' }, additionalProperties: { type: 'string', minLength: 1, maxLength: 100 } } }));
function read(files: ProjectFiles, path: string): Buffer {
  const full = files.resolvePath(path);
  if (!statSync(full).isFile() || statSync(full).size > 4 * 1024 * 1024) throw new WorkbenchError('CAD_INPUT_LIMIT', 'CAD inputs must be ordinary local files up to 4 MiB each.');
  const bytes = readFileSync(full);
  if (bytes.length > 4 * 1024 * 1024) throw new WorkbenchError('CAD_INPUT_LIMIT', 'CAD input grew beyond its bound.');
  return bytes;
}
function parseJson(bytes: Buffer, path: string, code: string): unknown {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new WorkbenchError(code, `Repair the saved JSON in ${path}; its original bytes were preserved.`); }
}
export function loadCadAssets(files: ProjectFiles): CadAsset[] {
  if (!existsSync(files.resolvePath('mechanical/assets.json', true))) return [];
  const value = parseJson(read(files, 'mechanical/assets.json'), 'mechanical/assets.json', 'CAD_MANIFEST_INVALID');
  if (!assetsValid(value) || new Set(value.assets.map(asset => asset.assetId)).size !== value.assets.length) throw new WorkbenchError('CAD_MANIFEST_INVALID', 'Validate mechanical/assets.json against the version 1 CAD convention.');
  return value.assets;
}
export type PreparedCad = { asset: CadAsset; parameters: Record<string, CadParameter>; files: { path: string; bytes: Buffer; sha256: string }[]; sourceSha256: string; fingerprint: string; environment: { python: string; packages: Record<string, string> }; issues: string[] };
export function prepareCad(files: ProjectFiles, asset: CadAsset, pythonPath: string): PreparedCad {
  const paths = [...new Set([asset.scriptRelativePath, ...asset.localModulePaths, asset.parameterRelativePath, asset.environmentLockRelativePath, ...asset.dimensionEvidenceRefs.map(ref => ref.path)])].sort();
  if (!asset.scriptRelativePath.endsWith('.py') || asset.localModulePaths.some(path => !path.endsWith('.py'))) throw new WorkbenchError('CAD_MANIFEST_INVALID', 'CAD source and local module paths must be Python files.');
  for (const path of paths) { const info = statSync(files.resolvePath(path)); if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new WorkbenchError('CAD_INPUT_LIMIT', 'CAD inputs must be ordinary files up to 4 MiB.'); }
  const snapshot = files.snapshotSource({ paths, host: () => ({ dirtyPaths: [] }) });
  const sources = snapshot.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
  if (sources.reduce((size, file) => size + file.bytes.length, 0) > 32 * 1024 * 1024) throw new WorkbenchError('CAD_INPUT_LIMIT', 'CAD input snapshots are bounded to 32 MiB.');
  const parameters = parseJson(sources.find(file => file.path === asset.parameterRelativePath)!.bytes, asset.parameterRelativePath, 'CAD_PARAMETERS_INVALID');
  if (!parametersValid(parameters) || Object.values(parameters).some(p => (p.value === null) !== (p.basis === 'unknown'))) throw new WorkbenchError('CAD_PARAMETERS_INVALID', 'Unknown parameters must retain null and unknown basis; known parameters need an explicit basis and unit.');
  const environment = parseJson(sources.find(file => file.path === asset.environmentLockRelativePath)!.bytes, asset.environmentLockRelativePath, 'CAD_ENVIRONMENT_INVALID');
  if (!cadEnvironmentValid(environment) || !environment.packages.cadquery || !environment.packages['cadquery-ocp']) throw new WorkbenchError('CAD_ENVIRONMENT_INVALID', 'The CAD environment lock must record exact Python and all installed distribution versions, including cadquery and cadquery-ocp.');
  const issues: string[] = [];
  if (!asset.dimensionEvidenceRefs.length && Object.values(parameters).some(parameter => parameter.basis === 'manufacturer' || parameter.basis === 'measured')) throw new WorkbenchError('CAD_DIMENSION_EVIDENCE_MISSING', 'Measured and manufacturer dimensions require declared hash-checked evidence files.');
  if (asset.dependencyDiscovery === 'dynamic') issues.push('Dynamic dependencies: non-reproducible generation; caching is disabled.');
  for (const [name, parameter] of Object.entries(parameters)) if (parameter.value === null) issues.push(`${name} remains unknown${parameter.fitCritical ? ' and fit-critical' : ''}.`);
  for (const ref of asset.dimensionEvidenceRefs) if (sources.find(file => file.path === ref.path)!.sha256 !== ref.sha256) throw new WorkbenchError('CAD_EVIDENCE_CHANGED', 'Dimension evidence bytes changed; review and update their declared hashes.');
  return { asset, parameters, files: sources, sourceSha256: snapshot.sha256, environment, issues, fingerprint: cadHash(JSON.stringify({ schemaVersion: 1, adapter: 'cad-v1', asset, pythonPath, files: sources.map(({ path, sha256 }) => ({ path, sha256 })) })) };
}
export const cadViewerInstructions = [
  'Install OCP CAD Viewer and the Microsoft Python extension explicitly in VS Code, then select the same isolated CAD interpreter.',
  'Open this handoff Python file. Its documented ocp_vscode import can start the viewer; use the Viewer Manager if it does not.',
  'Run > Run Without Debugging (Ctrl-F5). The public ocp_vscode.show() call displays the retained STEP artifact. If multiple viewers are open, select the intended port.',
  'Viewer display is a separate observation. Geometry validation does not certify physical fit, strength, material suitability or manufacturability.'
];
