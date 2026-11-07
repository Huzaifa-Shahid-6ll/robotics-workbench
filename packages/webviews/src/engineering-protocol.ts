import type { CadSnapshot, KicadSnapshot, KicadPreview } from '@robotics-workbench/contracts';
import { isCadSnapshot } from '@robotics-workbench/contracts/cad';
import { isKicadSnapshot, isKicadPreview } from '@robotics-workbench/contracts/kicad';

export type EngineeringScreen = 'schematic' | 'cad';
export interface EngineeringViewState {
  schemaVersion: 1; trusted: boolean; loading: boolean; error: string | null;
  project: { projectId: string; projectRevision: number; name: string } | null;
  screen: EngineeringScreen; mappingPath: string | null;
  schematic: KicadSnapshot | null; cad: CadSnapshot | null; preview: KicadPreview | null;
  notice: string | null;
}
export type EngineeringAction = 'ready' | 'refresh' | 'screen' | 'chooseMapping' | 'chooseSchematic' | 'generateSchematic' | 'validateSchematic' | 'previewSheet' | 'openSchematic' | 'exportSchematic' | 'openCadSource' | 'generateCad' | 'exportCad' | 'cadViewer';
export interface EngineeringRequest { schemaVersion: 1; requestId: string; projectId: string | null; type: EngineeringAction; payload: Record<string, unknown> }
export interface EngineeringResponse { schemaVersion: 1; type: 'state'; state: EngineeringViewState }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const keys = (v: Record<string, unknown>, names: string[], optional: string[] = []) => names.every(key => Object.hasOwn(v, key)) && Object.keys(v).every(key => [...names, ...optional].includes(key));
const id = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
function bounded(v: unknown, max: number): boolean {
  const scan = (value: unknown, depth: number): boolean => depth <= 20 && (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value) || Array.isArray(value) && value.every(item => scan(item, depth + 1)) || object(value) && Object.values(value).every(item => scan(item, depth + 1)));
  try { return scan(v, 0) && new TextEncoder().encode(JSON.stringify(v)).byteLength <= max; } catch { return false; }
}
export function isEngineeringRequest(v: unknown, projectId?: string | null): v is EngineeringRequest {
  if (!bounded(v, 32768) || !object(v) || !keys(v, ['schemaVersion', 'requestId', 'projectId', 'type', 'payload']) || v.schemaVersion !== 1 || !id(v.requestId) || !(v.projectId === null || id(v.projectId)) || !object(v.payload)) return false;
  if (projectId !== undefined && v.projectId !== projectId && !(v.type === 'ready' && v.projectId === null)) return false;
  const p = v.payload;
  if (v.type === 'ready' || v.type === 'refresh') return keys(p, []);
  if (!id(v.projectId)) return false;
  switch (v.type) {
    case 'screen': return keys(p, ['screen']) && ['schematic', 'cad'].includes(String(p.screen));
    case 'chooseMapping': case 'chooseSchematic': case 'generateSchematic': case 'validateSchematic': return keys(p, []);
    case 'previewSheet': return keys(p, ['generationId', 'sheetId']) && id(p.generationId) && id(p.sheetId);
    case 'openSchematic': case 'exportSchematic': return keys(p, ['generationId']) && id(p.generationId);
    case 'openCadSource': return keys(p, ['assetId', 'source']) && id(p.assetId) && ['script', 'parameters'].includes(String(p.source));
    case 'cadViewer': return keys(p, ['assetId', 'operationId']) && id(p.assetId) && id(p.operationId);
    case 'exportCad': return keys(p, ['assetId', 'operationId', 'format']) && id(p.assetId) && id(p.operationId) && ['step', 'stl'].includes(String(p.format));
    case 'generateCad': return keys(p, ['assetId', 'mode', 'assumptions']) && id(p.assetId) && ['production', 'exploratory'].includes(String(p.mode)) && object(p.assumptions) && Object.keys(p.assumptions).length <= 64 && Object.entries(p.assumptions).every(([key, val]) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) && typeof val === 'number' && Number.isFinite(val));
    default: return false;
  }
}
export function isEngineeringState(v: unknown): v is EngineeringViewState {
  if (!bounded(v, 1_000_000) || !object(v) || !keys(v, ['schemaVersion', 'trusted', 'loading', 'error', 'project', 'screen', 'mappingPath', 'schematic', 'cad', 'preview', 'notice']) || v.schemaVersion !== 1 || typeof v.trusted !== 'boolean' || typeof v.loading !== 'boolean' || !(v.error === null || text(v.error, 4096)) || !(v.notice === null || text(v.notice, 8192)) || !['schematic', 'cad'].includes(String(v.screen)) || !(v.mappingPath === null || text(v.mappingPath, 1024))) return false;
  if (!(v.project === null || object(v.project) && keys(v.project, ['projectId', 'projectRevision', 'name']) && id(v.project.projectId) && Number.isSafeInteger(v.project.projectRevision) && Number(v.project.projectRevision) > 0 && text(v.project.name, 256))) return false;
  if (!(v.schematic === null || isKicadSnapshot(v.schematic)) || !(v.cad === null || isCadSnapshot(v.cad)) || !(v.preview === null || isKicadPreview(v.preview))) return false;
  if (v.preview && v.schematic) {
    const generation = v.schematic.generations.find(item => item.generationId === (v.preview as KicadPreview).generationId);
    if (!generation || generation.sourceSha256 !== v.preview.sourceSha256 || generation.projectRevision !== v.preview.projectRevision || !generation.sheets.some(item => item.sheetId === (v.preview as KicadPreview).sheetId)) return false;
  }
  return true;
}
export function isEngineeringResponse(v: unknown): v is EngineeringResponse { return object(v) && keys(v, ['schemaVersion', 'type', 'state']) && v.schemaVersion === 1 && v.type === 'state' && isEngineeringState(v.state); }
