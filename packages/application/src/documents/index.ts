import { createHash, randomUUID } from 'node:crypto';
import { isDocumentExtraction, isDocumentRegion, isDocumentTextRange, isRequestId, WorkbenchError, type DocumentApplicability, type DocumentExcerpt, type DocumentExtraction, type DocumentMediaType, type DocumentPage, type DocumentRegion, type DocumentTextRange, type DocumentVersion } from '@robotics-workbench/contracts';

export interface DocumentStorage {
  getProject(projectId: string): unknown;
  storeArtifact(projectId: string, bytes: Uint8Array, mediaType: string): { artifactId: string; sha256: string; sizeBytes: number };
  readArtifact(projectId: string, artifactId: string): Uint8Array;
  putRecord(table: 'documents', id: string, projectId: string, value: unknown): void;
  getRecord<T>(table: 'documents', id: string, projectId: string): T;
  listRecords<T>(table: 'documents', projectId: string): T[];
  replaceDocumentIndex(projectId: string, versionId: string, documentId: string, pages: { page: number; text: string }[]): void;
  searchDocumentIndex(projectId: string, query: string, documentIds: string[] | undefined, limit: number, versionIds?: string[]): { versionId: string; page: number }[];
  clearDocumentIndex(projectId: string): void;
}
export type DocumentExtractor = (bytes: Uint8Array, mediaType: DocumentMediaType) => Promise<DocumentExtraction>;
export interface DocumentIngestion {
  projectId: string;
  documentId: string;
  filename: string;
  bytes: Uint8Array;
  mediaType: DocumentMediaType;
  componentIds?: string[];
  applicability?: DocumentApplicability;
  title?: string;
  sourceUrl?: string;
}
export interface DocumentCitation {
  documentId: string;
  artifactSha256: string;
  extractorVersion: string;
  page: number;
  region?: DocumentRegion;
  textRange?: DocumentTextRange;
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const digest = /^[a-f0-9]{64}$/;
const invalid = (message: string): never => { throw new WorkbenchError('INVALID_REQUEST', message); };
const splitPair = (text: string, offset: number) => offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]);
const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
function matchOffset(text: string, terms: string[]): number {
  let searchable = '', offset = 0;
  const originalOffsets: number[] = [];
  for (const point of text) {
    const normalized = fold(point); searchable += normalized;
    for (let i = 0; i < normalized.length; i++) originalOffsets.push(offset);
    offset += point.length;
  }
  const hits = terms.map(term => searchable.indexOf(fold(term))).filter(index => index >= 0);
  return hits.length ? originalOffsets[Math.min(...hits)] : 0;
}
function utf8Prefix(text: string, limit: number): string {
  let bytes = 0, result = '';
  for (const point of text) { bytes += Buffer.byteLength(point); if (bytes > limit) break; result += point; }
  return result;
}
function assertCitation(citation: DocumentCitation): void {
  if (!citation || !isRequestId(citation.documentId) || !digest.test(citation.artifactSha256) || typeof citation.extractorVersion !== 'string' || !citation.extractorVersion || citation.extractorVersion.length > 128 || !Number.isInteger(citation.page) || citation.page < 1 || (citation.region !== undefined && !isDocumentRegion(citation.region)) || (citation.textRange !== undefined && (!isDocumentTextRange(citation.textRange) || citation.region !== undefined))) invalid('Citation requires exact document/hash/extractor/page and either a valid region or text range.');
}
function assertExtraction(value: DocumentExtraction, expectedHash: string, mediaType: DocumentMediaType): void {
  if (!isDocumentExtraction(value) || value.artifactSha256 !== expectedHash || value.mediaType !== mediaType) throw new WorkbenchError('ARTIFACT_MISMATCH', 'Extraction does not identify the retained source and supported method.');
}

/** Manifest attachment intent is supplied by the caller; records retain immutable source versions. */
export class DocumentRepository {
  constructor(private readonly storage: DocumentStorage, private readonly extract: DocumentExtractor) {}

  async ingest(input: DocumentIngestion): Promise<DocumentVersion> {
    this.storage.getProject(input.projectId);
    if (!isRequestId(input.documentId) || typeof input.filename !== 'string' || !input.filename || input.filename.length > 1024 || !(input.bytes instanceof Uint8Array) || input.bytes.byteLength > 32 * 1024 * 1024 || !['application/pdf', 'text/plain'].includes(input.mediaType) || (input.componentIds !== undefined && (!Array.isArray(input.componentIds) || input.componentIds.length > 500 || input.componentIds.some(id => !isRequestId(id)))) || (input.applicability !== undefined && !['confirmed', 'candidate', 'unresolved'].includes(input.applicability)) || (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 1024)) || (input.sourceUrl !== undefined && (typeof input.sourceUrl !== 'string' || input.sourceUrl.length > 4096))) invalid('Document ingestion requires a declared attachment and bounded original bytes/metadata.');
    const bytes = Uint8Array.from(input.bytes), original = this.storage.storeArtifact(input.projectId, bytes, input.mediaType);
    let extraction: DocumentExtraction | undefined, error: DocumentVersion['error'] = null;
    try { extraction = await this.extract(Uint8Array.from(bytes), input.mediaType); assertExtraction(extraction, original.sha256, input.mediaType); }
    catch (failure) { extraction = undefined; error = { code: failure instanceof Error && 'code' in failure ? String(failure.code).slice(0, 128) : 'DOCUMENT_EXTRACTION_FAILED', message: failure instanceof Error ? failure.message.slice(0, 4096) : 'Document extraction failed; original bytes remain retained.' }; }
    const versions = extraction ? this.list(input.projectId, input.documentId).filter(version => version.artifactSha256 === original.sha256 && version.extractorVersion === extraction!.extractorVersion) : [];
    if (extraction && versions.length && hash(Buffer.from(JSON.stringify(this.extraction(input.projectId, versions[0])))) !== hash(Buffer.from(JSON.stringify(extraction)))) throw new WorkbenchError('ARTIFACT_MISMATCH', 'This extractor identity produced different text for a retained source. Use an explicitly versioned extractor; historical citations and index entries were preserved.');
    const existing = versions.find(version => version.filename === input.filename && version.applicability === (input.applicability ?? 'unresolved') && JSON.stringify(version.componentIds) === JSON.stringify(input.componentIds ?? []) && version.title === input.title && version.sourceUrl === input.sourceUrl);
    if (existing) { this.storage.replaceDocumentIndex(input.projectId, existing.versionId, existing.documentId, extraction!.pages); return existing; }
    const derived = extraction && this.storage.storeArtifact(input.projectId, Buffer.from(JSON.stringify(extraction)), 'application/json');
    const version: DocumentVersion = {
      schemaVersion: 1, versionId: randomUUID(), documentId: input.documentId, projectId: input.projectId,
      artifactId: original.artifactId, artifactSha256: original.sha256, filename: input.filename, mediaType: input.mediaType, sizeBytes: original.sizeBytes,
      attachedAt: new Date().toISOString(), componentIds: [...(input.componentIds ?? [])], applicability: input.applicability ?? 'unresolved',
      extractorVersion: extraction?.extractorVersion ?? 'unavailable', extractionArtifactId: derived?.artifactId ?? null,
      status: extraction?.status ?? 'extraction-failed', pageCount: extraction?.pages.length ?? 0,
      limitations: extraction?.limitations ?? ['Original attachment retained; extraction is unavailable.'], error,
      ...(input.title !== undefined ? { title: input.title } : {}), ...(input.sourceUrl !== undefined ? { sourceUrl: input.sourceUrl } : {}),
    };
    this.storage.putRecord('documents', version.versionId, input.projectId, version);
    if (extraction) this.storage.replaceDocumentIndex(input.projectId, version.versionId, input.documentId, extraction.pages);
    return version;
  }
  list(projectId: string, documentId?: string): DocumentVersion[] {
    if (documentId !== undefined && !isRequestId(documentId)) invalid('Document filter requires a UUID.');
    return this.storage.listRecords<DocumentVersion>('documents', projectId).filter(version => documentId === undefined || version.documentId === documentId);
  }
  version(projectId: string, versionId: string): DocumentVersion { return this.storage.getRecord<DocumentVersion>('documents', versionId, projectId); }
  original(projectId: string, versionId: string): Uint8Array {
    const version = this.version(projectId, versionId), bytes = this.storage.readArtifact(projectId, version.artifactId);
    if (hash(bytes) !== version.artifactSha256 || bytes.byteLength !== version.sizeBytes) throw new WorkbenchError('ARTIFACT_MISMATCH', 'Original source differs from its immutable document version.');
    return bytes;
  }
  private extraction(projectId: string, version: DocumentVersion): DocumentExtraction {
    this.original(projectId, version.versionId);
    if (!version.extractionArtifactId) throw new WorkbenchError('TOOL_UNAVAILABLE', 'This original is retained but extraction is unavailable.', { reason: version.error?.code ?? 'DOCUMENT_EXTRACTION_UNAVAILABLE' });
    let extraction: DocumentExtraction;
    try { extraction = JSON.parse(Buffer.from(this.storage.readArtifact(projectId, version.extractionArtifactId)).toString('utf8')) as DocumentExtraction; }
    catch (error) { if (error instanceof WorkbenchError) throw error; throw new WorkbenchError('ARTIFACT_MISMATCH', 'Retained extraction JSON is invalid.'); }
    assertExtraction(extraction, version.artifactSha256, version.mediaType);
    if (extraction.extractorVersion !== version.extractorVersion) throw new WorkbenchError('ARTIFACT_MISMATCH', 'Retained extraction version differs from the citation.');
    return extraction;
  }
  page(projectId: string, citation: DocumentCitation): { version: DocumentVersion; page: DocumentPage } {
    assertCitation(citation);
    const version = this.list(projectId, citation.documentId).filter(item => item.artifactSha256 === citation.artifactSha256 && item.extractorVersion === citation.extractorVersion).at(-1);
    if (!version) throw new WorkbenchError('NOT_FOUND', 'The exact historical document/extraction is unavailable; a newer source was not substituted.');
    const page = this.extraction(projectId, version).pages[citation.page - 1];
    if (!page) throw new WorkbenchError('NOT_FOUND', 'Physical page is absent from this exact document version.');
    if (citation.region && !page.regions.some(item => JSON.stringify(item.region) === JSON.stringify(citation.region))) throw new WorkbenchError('NOT_FOUND', 'The exact cited region is unavailable in this extraction.');
    if (citation.textRange && (citation.textRange[1] > page.text.length || citation.textRange.some(offset => splitPair(page.text, offset)))) invalid('Text range must stay within the exact retained page and preserve Unicode pairs.');
    return { version, page };
  }
  private excerpt(projectId: string, citation: DocumentCitation, offset = 0): DocumentExcerpt {
    const { version, page } = this.page(projectId, citation);
    const text = citation.region ? page.regions.find(item => JSON.stringify(item.region) === JSON.stringify(citation.region))!.text : page.text;
    const start = citation.textRange?.[0] ?? offset;
    if (!Number.isInteger(start) || start < 0 || start > text.length || splitPair(text, start)) invalid('Invalid excerpt expansion offset.');
    if (citation.region && (start !== 0 || Buffer.byteLength(text) > 4096)) invalid('This region exceeds the bounded excerpt size. Select an exact page-text range or inspect the original page.');
    const window = citation.textRange ? text.slice(start, citation.textRange[1]) : utf8Prefix(text.slice(start), 4096);
    if (Buffer.byteLength(window) > 4096) invalid('Text range exceeds the 4096-byte excerpt bound.');
    const end = start + window.length, truncated = !citation.region && end < text.length;
    return { documentId: version.documentId, artifactSha256: version.artifactSha256, page: page.page,
      ...(page.printedPageLabel !== undefined ? { printedPageLabel: page.printedPageLabel } : {}), ...(citation.region ? { region: citation.region } : {}),
      ...(!citation.region ? { textRange: [start, end] as DocumentTextRange } : {}),
      text: window, method: 'text-layer', extractorVersion: version.extractorVersion, applicability: version.applicability, truncated,
      ...(truncated ? { expansionHandle: Buffer.from(JSON.stringify({ schemaVersion: 1, projectId, documentId: citation.documentId, artifactSha256: citation.artifactSha256, extractorVersion: citation.extractorVersion, page: citation.page, offset: end })).toString('base64url') } : {}),
    };
  }
  cite(projectId: string, citation: DocumentCitation): DocumentExcerpt { return this.excerpt(projectId, citation); }
  query(projectId: string, input: { query: string; documentIds?: string[]; componentId?: string; limit?: number; includeHistory?: boolean }): { excerpts: DocumentExcerpt[]; omitted: number } {
    if (!input || typeof input.query !== 'string' || !input.query.trim() || Buffer.byteLength(input.query) > 1024 || (input.includeHistory !== undefined && typeof input.includeHistory !== 'boolean') || (input.componentId !== undefined && !isRequestId(input.componentId))) invalid('Document search requires bounded literal text and valid filters.');
    const limit = input.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || (input.documentIds !== undefined && (!Array.isArray(input.documentIds) || input.documentIds.length > 500 || input.documentIds.some(id => !isRequestId(id))))) invalid('Document search limit or filters are invalid.');
    const versions = this.list(projectId), latest = new Map<string, string>();
    for (const version of versions) latest.set(version.documentId, version.versionId);
    const allowed = new Map(versions.filter(version => (!input.documentIds || input.documentIds.includes(version.documentId)) && (!input.componentId || version.componentIds.includes(input.componentId)) && (input.includeHistory || latest.get(version.documentId) === version.versionId)).map(version => [version.versionId, version]));
    const ids = [...new Set([...allowed.values()].map(version => version.documentId))];
    const matches = this.storage.searchDocumentIndex(projectId, input.query, ids, 500, [...allowed.keys()]).filter(match => allowed.has(match.versionId));
    const excerpts: DocumentExcerpt[] = [];
    for (const match of matches) {
      if (excerpts.length >= limit) break;
      const version = allowed.get(match.versionId)!, citation: DocumentCitation = { documentId: version.documentId, artifactSha256: version.artifactSha256, extractorVersion: version.extractorVersion, page: match.page };
      const page = this.page(projectId, citation).page;
      const terms = input.query.match(/[\p{L}\p{N}_]+/gu)?.map(term => term.toLowerCase()) ?? [];
      const region = page.regions.find(item => Buffer.byteLength(item.text) <= 4096 && terms.every(term => fold(item.text).includes(fold(term))));
      if (region) citation.region = region.region;
      else {
        let start = Math.max(0, matchOffset(page.text, terms) - 128);
        if (splitPair(page.text, start)) start--;
        citation.textRange = [start, start + utf8Prefix(page.text.slice(start), 4096).length];
      }
      const excerpt = this.excerpt(projectId, citation);
      if (Buffer.byteLength(JSON.stringify({ excerpts: [...excerpts, excerpt], omitted: matches.length })) > 32768) break;
      excerpts.push(excerpt);
    }
    return { excerpts, omitted: matches.length - excerpts.length };
  }
  expand(projectId: string, handle: string): DocumentExcerpt {
    if (typeof handle !== 'string' || !/^[A-Za-z0-9_-]+$/.test(handle) || handle.length > 2048) invalid('Invalid document expansion handle.');
    let value: DocumentCitation & { schemaVersion: number; projectId: string; offset: number };
    try { value = JSON.parse(Buffer.from(handle, 'base64url').toString('utf8')) as typeof value; }
    catch { return invalid('Invalid document expansion handle.'); }
    if (value.schemaVersion !== 1 || value.projectId !== projectId) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Document expansion belongs to another project or schema.');
    assertCitation(value); return this.excerpt(projectId, value, value.offset);
  }
  rebuild(projectId: string): { indexedVersions: number } {
    const versions = this.list(projectId).filter(version => version.extractionArtifactId !== null);
    for (const version of versions) this.extraction(projectId, version);
    this.storage.clearDocumentIndex(projectId);
    for (const version of versions) this.storage.replaceDocumentIndex(projectId, version.versionId, version.documentId, this.extraction(projectId, version).pages);
    return { indexedVersions: versions.length };
  }
}
