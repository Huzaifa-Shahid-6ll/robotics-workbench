import type { DocumentExcerpt, DocumentRegion } from '@robotics-workbench/contracts';

export interface DocumentLocation { documentId: string; artifactSha256: string; extractorVersion: string; page: number }
export interface DocumentViewVersion { artifactSha256: string; extractorVersion: string; pageCount: number; status: 'extracted' | 'no-text-layer' | 'extraction-failed'; mediaType: 'application/pdf' | 'text/plain'; attachedAt: string }
export interface DocumentViewItem { documentId: string; title: string; path: string; currentSha256: string | null; versions: DocumentViewVersion[] }
export interface DocumentViewPage {
  citation: DocumentExcerpt; pageCount: number; rotation: 0 | 90 | 180 | 270; text: string;
  regions: { text: string; region: DocumentRegion }[];
  image: { dataUrl: string; width: number; height: number } | null;
  limitations: string[]; sourceCurrent: boolean;
}
export interface DocumentViewState {
  schemaVersion: 1; trusted: boolean; loading: boolean; error: string | null;
  project: { projectId: string; projectRevision: number; name: string } | null;
  documents: DocumentViewItem[]; selection: DocumentLocation | null; page: DocumentViewPage | null;
  results: DocumentExcerpt[]; query: string; queryTruncated: boolean;
}
export type DocumentViewAction = 'ready' | 'refresh' | 'selectDocument' | 'ingest' | 'search' | 'navigate' | 'page' | 'ask' | 'openOriginal';
export interface DocumentViewRequest { schemaVersion: 1; requestId: string; projectId: string | null; type: DocumentViewAction; payload: Record<string, unknown> }
export interface DocumentViewResponse { schemaVersion: 1; type: 'state'; state: DocumentViewState }

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const keys = (v: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(key => Object.hasOwn(v, key)) && Object.keys(v).every(key => [...required, ...optional].includes(key));
const text = (v: unknown, max: number, min = 0): v is string => typeof v === 'string' && v.length >= min && v.length <= max;
const id = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const positive = (v: unknown, max = 1_000_000): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= max;
const array = (v: unknown, max: number, test: (item: unknown) => boolean): v is unknown[] => Array.isArray(v) && v.length <= max && v.every(test);
function bounded(v: unknown, limit: number): boolean {
  const scan = (x: unknown, depth = 0): boolean => depth <= 16 && (x === null || typeof x === 'string' || typeof x === 'boolean' || typeof x === 'number' && Number.isFinite(x) || Array.isArray(x) && x.every(item => scan(item, depth + 1)) || object(x) && Object.values(x).every(item => scan(item, depth + 1)));
  try { return scan(v) && new TextEncoder().encode(JSON.stringify(v)).byteLength <= limit; } catch { return false; }
}
export function isDocumentRegion(v: unknown): v is DocumentRegion {
  return Array.isArray(v) && v.length === 4 && v.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1) && v[0] <= v[2] && v[1] <= v[3];
}
export function isDocumentLocation(v: unknown): v is DocumentLocation {
  return object(v) && keys(v, ['documentId', 'artifactSha256', 'extractorVersion', 'page']) && id(v.documentId) && hash(v.artifactSha256) && text(v.extractorVersion, 256, 1) && positive(v.page, 10000);
}
export function isDocumentExcerpt(v: unknown): v is DocumentExcerpt {
  return object(v) && keys(v, ['documentId', 'artifactSha256', 'page', 'text', 'method', 'extractorVersion', 'applicability', 'truncated'], ['printedPageLabel', 'region', 'textRange', 'expansionHandle'])
    && id(v.documentId) && hash(v.artifactSha256) && positive(v.page, 10000) && text(v.text, 16384) && ['text-layer', 'ocr', 'table-parser', 'model-interpretation'].includes(String(v.method))
    && text(v.extractorVersion, 256, 1) && ['confirmed', 'candidate', 'unresolved'].includes(String(v.applicability)) && typeof v.truncated === 'boolean'
    && (v.printedPageLabel === undefined || text(v.printedPageLabel, 256)) && (v.region === undefined || isDocumentRegion(v.region))
    && (v.textRange === undefined || v.region === undefined && Array.isArray(v.textRange) && v.textRange.length === 2 && v.textRange.every(n => Number.isSafeInteger(n) && n >= 0) && v.textRange[1] - v.textRange[0] === v.text.length)
    && (v.expansionHandle === undefined || text(v.expansionHandle, 2048, 1));
}
export function isDocumentViewRequest(v: unknown, projectId?: string | null): v is DocumentViewRequest {
  if (!bounded(v, 32768) || !object(v) || !keys(v, ['schemaVersion', 'requestId', 'projectId', 'type', 'payload']) || v.schemaVersion !== 1 || !id(v.requestId) || !(v.projectId === null || id(v.projectId)) || !object(v.payload)) return false;
  if (projectId !== undefined && v.projectId !== projectId && !(v.type === 'ready' && v.projectId === null)) return false;
  const p = v.payload;
  if (v.type === 'ready' || v.type === 'refresh') return keys(p, []);
  if (!id(v.projectId)) return false;
  switch (v.type) {
    case 'selectDocument': case 'ingest': return keys(p, ['documentId']) && id(p.documentId);
    case 'search': return keys(p, ['query'], ['documentId']) && text(p.query, 1024, 1) && new TextEncoder().encode(p.query).byteLength <= 1024 && !!p.query.trim() && (p.documentId === undefined || id(p.documentId));
    case 'navigate': case 'ask': return keys(p, ['citation']) && isDocumentExcerpt(p.citation);
    case 'page': return isDocumentLocation(p);
    case 'openOriginal': return keys(p, ['documentId', 'artifactSha256']) && id(p.documentId) && hash(p.artifactSha256);
    default: return false;
  }
}
function version(v: unknown): boolean {
  return object(v) && keys(v, ['artifactSha256', 'extractorVersion', 'pageCount', 'status', 'mediaType', 'attachedAt']) && hash(v.artifactSha256) && text(v.extractorVersion, 256, 1)
    && (positive(v.pageCount, 10000) || v.status === 'extraction-failed' && v.pageCount === 0) && ['extracted', 'no-text-layer', 'extraction-failed'].includes(String(v.status)) && ['application/pdf', 'text/plain'].includes(String(v.mediaType)) && text(v.attachedAt, 64, 1) && /Z$/.test(v.attachedAt) && Number.isFinite(Date.parse(v.attachedAt));
}
function item(v: unknown): boolean {
  return object(v) && keys(v, ['documentId', 'title', 'path', 'currentSha256', 'versions']) && id(v.documentId) && text(v.title, 1024, 1) && text(v.path, 4096, 1)
    && !/[\\:\x00-\x1f]/.test(v.path) && !v.path.startsWith('/') && !v.path.split('/').some(part => !part || part === '.' || part === '..')
    && (v.currentSha256 === null || hash(v.currentSha256)) && array(v.versions, 100, version);
}
function page(v: unknown): boolean {
  return object(v) && keys(v, ['citation', 'pageCount', 'rotation', 'text', 'regions', 'image', 'limitations', 'sourceCurrent']) && isDocumentExcerpt(v.citation) && positive(v.pageCount, 10000) && v.citation.page <= v.pageCount
    && [0, 90, 180, 270].includes(Number(v.rotation)) && typeof v.rotation === 'number' && text(v.text, 65536)
    && array(v.regions, 1000, region => object(region) && keys(region, ['text', 'region']) && text(region.text, 16384) && isDocumentRegion(region.region))
    && (v.image === null || object(v.image) && keys(v.image, ['dataUrl', 'width', 'height']) && text(v.image.dataUrl, 700 * 1024, 34) && /^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(v.image.dataUrl) && positive(v.image.width, 4096) && positive(v.image.height, 4096))
    && array(v.limitations, 32, limitation => text(limitation, 2048, 1)) && typeof v.sourceCurrent === 'boolean';
}
export function isDocumentViewState(v: unknown): v is DocumentViewState {
  if (!bounded(v, 1024 * 1024) || !object(v) || !keys(v, ['schemaVersion', 'trusted', 'loading', 'error', 'project', 'documents', 'selection', 'page', 'results', 'query', 'queryTruncated']) || v.schemaVersion !== 1 || typeof v.trusted !== 'boolean' || typeof v.loading !== 'boolean' || !(v.error === null || text(v.error, 4096))) return false;
  if (!(v.project === null || object(v.project) && keys(v.project, ['projectId', 'projectRevision', 'name']) && id(v.project.projectId) && positive(v.project.projectRevision, Number.MAX_SAFE_INTEGER) && text(v.project.name, 1024, 1))) return false;
  if (!array(v.documents, 500, item) || !(v.selection === null || isDocumentLocation(v.selection)) || !(v.page === null || page(v.page)) || !array(v.results, 100, isDocumentExcerpt) || !text(v.query, 1024) || typeof v.queryTruncated !== 'boolean') return false;
  if (v.project === null && (v.documents.length || v.selection !== null || v.page !== null || v.results.length)) return false;
  if (v.selection !== null) {
    const selection = v.selection as unknown as DocumentLocation;
    if (!v.documents.some(document => object(document) && document.documentId === selection.documentId)) return false;
    if (v.page !== null && (!object(v.page) || !object(v.page.citation) || !['documentId', 'artifactSha256', 'extractorVersion', 'page'].every(key => v.page !== null && object(v.page) && object(v.page.citation) && v.page.citation[key] === selection[key as keyof DocumentLocation]))) return false;
  } else if (v.page !== null) return false;
  return true;
}
export function isDocumentViewResponse(v: unknown): v is DocumentViewResponse { return object(v) && keys(v, ['schemaVersion', 'type', 'state']) && v.schemaVersion === 1 && v.type === 'state' && isDocumentViewState(v.state); }
