/** Coordinates are normalized x1,y1,x2,y2 from the rotated page's top-left. */
export type DocumentRegion = [number, number, number, number];
/** UTF-16 code-unit offsets in the exact extracted page text, start-inclusive/end-exclusive. */
export type DocumentTextRange = [number, number];
export type DocumentMediaType = 'application/pdf' | 'text/plain';
export type DocumentApplicability = 'confirmed' | 'candidate' | 'unresolved';
export interface DocumentTextRegion { text: string; region: DocumentRegion }
export interface DocumentPage {
  page: number;
  printedPageLabel?: string;
  rotation: 0 | 90 | 180 | 270;
  text: string;
  regions: DocumentTextRegion[];
}
export interface DocumentExtraction {
  schemaVersion: 1;
  artifactSha256: string;
  mediaType: DocumentMediaType;
  extractorVersion: string;
  method: 'text-layer';
  status: 'extracted' | 'no-text-layer';
  pages: DocumentPage[];
  limitations: string[];
}
export interface DocumentExcerpt {
  documentId: string;
  artifactSha256: string;
  page: number;
  printedPageLabel?: string;
  region?: DocumentRegion;
  textRange?: DocumentTextRange;
  text: string;
  method: 'text-layer' | 'ocr' | 'table-parser' | 'model-interpretation';
  extractorVersion: string;
  applicability: DocumentApplicability;
  truncated: boolean;
  expansionHandle?: string;
}
export interface DocumentVersion {
  schemaVersion: 1;
  versionId: string;
  documentId: string;
  projectId: string;
  artifactId: string;
  artifactSha256: string;
  filename: string;
  mediaType: DocumentMediaType;
  sizeBytes: number;
  attachedAt: string;
  componentIds: string[];
  applicability: DocumentApplicability;
  extractorVersion: string;
  extractionArtifactId: string | null;
  status: 'extracted' | 'no-text-layer' | 'extraction-failed';
  pageCount: number;
  limitations: string[];
  error: { code: string; message: string } | null;
  title?: string;
  sourceUrl?: string;
}

export function isDocumentRegion(value: unknown): value is DocumentRegion {
  return Array.isArray(value) && value.length === 4 && value.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1) && value[0] <= value[2] && value[1] <= value[3];
}
export function isDocumentTextRange(value: unknown): value is DocumentTextRange {
  return Array.isArray(value) && value.length === 2 && value.every(n => Number.isSafeInteger(n) && n >= 0 && n <= 256 * 1024) && value[0] <= value[1];
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, maximum: number) => typeof value === 'string' && value.length <= maximum;
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const fields = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));

export function isDocumentExtraction(value: unknown): value is DocumentExtraction {
  if (!record(value) || !fields(value, ['schemaVersion', 'artifactSha256', 'mediaType', 'extractorVersion', 'method', 'status', 'pages', 'limitations']) || value.schemaVersion !== 1 || !hash(value.artifactSha256) || !['application/pdf', 'text/plain'].includes(String(value.mediaType)) || !text(value.extractorVersion, 128) || !value.extractorVersion || value.method !== 'text-layer' || !['extracted', 'no-text-layer'].includes(String(value.status)) || !Array.isArray(value.pages) || !value.pages.length || value.pages.length > 2000 || !Array.isArray(value.limitations) || value.limitations.length > 32 || !value.limitations.every(s => text(s, 2048))) return false;
  let bytes = 0, regions = 0;
  for (let i = 0; i < value.pages.length; i++) {
    const page: unknown = value.pages[i];
    if (!record(page) || !fields(page, ['page', 'printedPageLabel', 'rotation', 'text', 'regions']) || page.page !== i + 1 || typeof page.rotation !== 'number' || ![0, 90, 180, 270].includes(page.rotation) || !text(page.text, 256 * 1024) || !Array.isArray(page.regions) || page.regions.length > 20_000 || (page.printedPageLabel !== undefined && !text(page.printedPageLabel, 256))) return false;
    bytes += new TextEncoder().encode(page.text as string).byteLength; regions += page.regions.length;
    if (bytes > 8 * 1024 * 1024 || regions > 100_000) return false;
    if (!page.regions.every(item => record(item) && fields(item, ['text', 'region']) && text(item.text, 256 * 1024) && isDocumentRegion(item.region))) return false;
  }
  return value.status === (value.pages.some(page => (page as DocumentPage).text.trim()) ? 'extracted' : 'no-text-layer');
}

export function isDocumentExcerpt(value: unknown): value is DocumentExcerpt {
  return record(value) && fields(value, ['documentId', 'artifactSha256', 'page', 'printedPageLabel', 'region', 'textRange', 'text', 'method', 'extractorVersion', 'applicability', 'truncated', 'expansionHandle']) && uuid(value.documentId) && hash(value.artifactSha256) && Number.isSafeInteger(value.page) && Number(value.page) >= 1 && Number(value.page) <= 2000 && (value.printedPageLabel === undefined || text(value.printedPageLabel, 256)) && (value.region === undefined || isDocumentRegion(value.region)) && text(value.text, 16 * 1024) && (value.textRange === undefined || isDocumentTextRange(value.textRange) && value.region === undefined && value.textRange[1] - value.textRange[0] === (value.text as string).length) && new TextEncoder().encode(value.text as string).byteLength <= 16 * 1024 && ['text-layer', 'ocr', 'table-parser', 'model-interpretation'].includes(String(value.method)) && text(value.extractorVersion, 128) && !!value.extractorVersion && ['confirmed', 'candidate', 'unresolved'].includes(String(value.applicability)) && typeof value.truncated === 'boolean' && (value.expansionHandle === undefined || text(value.expansionHandle, 4096));
}
