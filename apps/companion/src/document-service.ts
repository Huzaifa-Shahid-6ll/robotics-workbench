import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { DocumentRepository, type DocumentCitation, type ContextCandidate } from '@robotics-workbench/application';
import { extractDocument, renderDocumentPage, DOCUMENT_EXTRACTOR_VERSION } from '@robotics-workbench/documents';
import { isProjectRequest, isProjectResponse, WorkbenchError, type DocumentExcerpt, type DocumentVersion, type OperationReceipt, type ProjectRequest, type ProjectResponse, type WorkbenchManifest } from '@robotics-workbench/contracts';
import type { ProjectService } from './project-service';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const artifactRef = ({ artifactId, sha256, mediaType, relativePath }: OperationReceipt['artifacts'][number]) => ({ artifactId, sha256, mediaType, relativePath });

/** Manifest associations remain file-owned; this service retains exact immutable source versions. */
export class DocumentService {
  readonly repository: DocumentRepository;
  private readonly previews = new Map<string, Awaited<ReturnType<typeof renderDocumentPage>>>();
  constructor(private readonly project: ProjectService) {
    this.repository = new DocumentRepository(project.store, extractDocument);
    project.references = this;
  }
  supports(method: string): boolean { return method.startsWith('document.'); }
  private current(request?: ProjectRequest): WorkbenchManifest {
    const response = this.project.handle({ schemaVersion: 1, requestId: randomUUID(), projectId: this.project.projectId, method: 'project.snapshot', params: {} }, { includeBuilds: false });
    if (response.error) throw new WorkbenchError(response.error.code, response.error.message);
    const current = this.project.files.inspectManifest().manifest;
    if (request?.expectedProjectRevision !== undefined && request.expectedProjectRevision !== current.projectRevision) throw new WorkbenchError('REVISION_CONFLICT', 'Refresh the current manifest before indexing document source.');
    return current;
  }
  private source(document: WorkbenchManifest['documents'][number]): Buffer {
    const full = this.project.files.resolvePath(document.path);
    if (statSync(full).size > 32 * 1024 * 1024) throw new WorkbenchError('DOCUMENT_OVERSIZED', 'Document exceeds the 32 MiB ingestion limit.');
    const bytes = readFileSync(full);
    if (bytes.length > 32 * 1024 * 1024) throw new WorkbenchError('DOCUMENT_OVERSIZED', 'Document grew beyond the ingestion limit.');
    return bytes;
  }
  private versions(documentId: string): DocumentVersion[] { return this.repository.list(this.project.projectId, documentId); }
  private async preview(version: DocumentVersion, page: number, revision: number) {
    const key = `${version.artifactSha256}:${page}`;
    if (this.previews.has(key)) return this.previews.get(key)!;
    const original = this.repository.original(this.project.projectId, version.versionId);
    const receipt: OperationReceipt = { schemaVersion: 1, operationId: randomUUID(), requestId: randomUUID(), projectId: this.project.projectId, kind: 'document-ingest', status: 'queued', expectedProjectRevision: revision, createdAt: new Date().toISOString(), tool: { name: 'document-page-preview', version: DOCUMENT_EXTRACTOR_VERSION }, artifacts: [] };
    const operation = this.project.jobs.submit({ receipt, payload: { kind: 'read-only-page-preview', sha256: version.artifactSha256, page }, heavy: true, cancellable: false, execute: async () => {
      const image = await renderDocumentPage(original, page);
      const artifact = this.project.store.storeArtifact(this.project.projectId, Buffer.from(image.dataUrl.split(',')[1]!, 'base64'), 'image/png');
      return { artifacts: [artifactRef(artifact)], result: { artifactId: artifact.artifactId, width: image.width, height: image.height } };
    } });
    const complete = await this.project.jobs.wait(operation.operationId);
    if (complete.status !== 'succeeded' || !complete.result) throw new WorkbenchError(complete.error?.code ?? 'DOCUMENT_RENDER_FAILED', complete.error?.message ?? 'The exact original page could not be rendered.');
    const image = { dataUrl: `data:image/png;base64,${this.project.store.readArtifact(this.project.projectId, String(complete.result.artifactId)).toString('base64')}`, width: Number(complete.result.width), height: Number(complete.result.height) };
    if (this.previews.size >= 8) this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(key, image); return image;
  }
  context(citation: DocumentCitation, revision: number): ContextCandidate {
    const excerpt = this.repository.cite(this.project.projectId, citation), { version } = this.repository.page(this.project.projectId, citation);
    return { entityIds: [citation.documentId], expansionHandle: excerpt.expansionHandle ?? null, evidence: {
      evidenceId: version.versionId, artifactId: version.artifactId, sha256: version.artifactSha256, basis: 'reported',
      sourceUri: `document://${citation.documentId}/${citation.artifactSha256}?extractor=${encodeURIComponent(citation.extractorVersion)}`,
      location: { kind: 'page', start: citation.page, end: citation.page, timeBasis: null }, projectRevision: revision,
      observedAt: version.attachedAt, applicability: 'historical', summary: JSON.stringify(excerpt)
    } };
  }
  async handle(value: unknown): Promise<ProjectResponse> {
    if (!isProjectRequest(value) || value.projectId !== this.project.projectId || !this.supports(value.method)) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Invalid document request scope.');
    try {
      if (value.method === 'document.ingest') {
        let previous: OperationReceipt | undefined;
        try { previous = this.project.store.getOperationByRequest(value.projectId, value.requestId); }
        catch (error) { if (!(error instanceof WorkbenchError) || error.code !== 'NOT_FOUND') throw error; }
        if (previous) {
          const { startedAt, finishedAt, error, result, ...queued } = previous;
          const retained = this.project.store.createOperation({ ...queued, status: 'queued', artifacts: [] }, value);
          return { schemaVersion: 1, requestId: value.requestId, result: retained };
        }
      }
      const manifest = this.current(value), p = value.params;
      let result: unknown;
      switch (value.method) {
        case 'document.list': {
          const attachments = [...manifest.documents], declared = new Set(attachments.map(item => item.documentId));
          for (const version of this.repository.list(value.projectId)) if (!attachments.some(item => item.documentId === version.documentId)) attachments.push({ documentId: version.documentId, path: version.filename, title: `Removed attachment · ${version.title ?? version.filename}` });
          if (attachments.length > 100) throw new WorkbenchError('DOCUMENT_LIMIT_EXCEEDED', 'The document view supports 100 declared or retained attachments. Exact historical citation queries remain available.');
          result = attachments.map(document => {
          let currentSha256: string | null = null;
          if (declared.has(document.documentId)) try { currentSha256 = hash(this.source(document)); } catch { /* Historical originals remain accessible when source is absent. */ }
          return { documentId: document.documentId, path: document.path, title: document.title || basename(document.path), currentSha256, versions: this.versions(document.documentId).slice(-50).map(version => ({ artifactSha256: version.artifactSha256, extractorVersion: version.extractorVersion, pageCount: version.pageCount, status: version.status, mediaType: version.mediaType, attachedAt: version.attachedAt })) };
          }); break;
        }
        case 'document.ingest': {
          const document = manifest.documents.find(item => item.documentId === p.documentId);
          if (!document) throw new WorkbenchError('NOT_FOUND', 'Attach this document in the ordinary manifest first.');
          const mediaType = extname(document.path).toLowerCase() === '.pdf' ? 'application/pdf' : ['.txt', '.md'].includes(extname(document.path).toLowerCase()) ? 'text/plain' : null;
          if (!mediaType) throw new WorkbenchError('DOCUMENT_UNSUPPORTED', 'Only PDF and UTF-8 text attachments are supported.');
          const bytes = this.source(document);
          if (hash(bytes) !== p.expectedSha256) throw new WorkbenchError('REVISION_CONFLICT', 'Document bytes changed before ingestion. Refresh and review the saved source.');
          const receipt: OperationReceipt = { schemaVersion: 1, operationId: randomUUID(), requestId: value.requestId, projectId: value.projectId, kind: 'document-ingest', status: 'queued', expectedProjectRevision: manifest.projectRevision, createdAt: new Date().toISOString(), tool: { name: 'document-extractor', version: DOCUMENT_EXTRACTOR_VERSION }, artifacts: [] };
          result = this.project.jobs.submit({ receipt, payload: value, heavy: true, cancellable: false,
            preflight: () => { this.current(value); if (hash(this.source(document)) !== p.expectedSha256) throw new WorkbenchError('REVISION_CONFLICT', 'Document source changed while indexing was queued.'); },
            execute: async () => {
              const version = await this.repository.ingest({ projectId: value.projectId, documentId: document.documentId, filename: basename(document.path), bytes, mediaType, componentIds: document.componentIds, title: document.title, applicability: 'unresolved' });
              const artifact = this.project.store.getArtifact(value.projectId, version.artifactId);
              if (version.error) throw new WorkbenchError(version.error.code, version.error.message + ' The original attachment remains retained.');
              return { artifacts: [artifactRef(artifact)], result: { versionId: version.versionId, documentId: version.documentId, artifactSha256: version.artifactSha256, status: version.status } };
            } }); break;
        }
        case 'document.page': {
          const citation = p as unknown as DocumentCitation, { version, page } = this.repository.page(value.projectId, citation);
          let image = null, imageError: string | null = null;
          if (version.mediaType === 'application/pdf') try { image = await this.preview(version, page.page, manifest.projectRevision); } catch (error) { imageError = error instanceof Error ? error.message : 'Original page preview is unavailable.'; }
          const document = manifest.documents.find(item => item.documentId === version.documentId);
          let sourceCurrent = false; try { sourceCurrent = !!document && hash(this.source(document)) === version.artifactSha256; } catch { /* Retained historical source is still identified. */ }
          result = { citation: this.repository.cite(value.projectId, citation), pageCount: version.pageCount, rotation: page.rotation,
            text: page.text.slice(0, 16000), regions: page.regions.slice(0, 100).map(region => ({ ...region, text: region.text.slice(0, 256) })), image,
            limitations: [...version.limitations, ...(page.text.length > 16000 || page.regions.length > 100 ? ['Auxiliary text/region preview is bounded; original and retrieval remain available.'] : []), ...(imageError ? [imageError] : [])], sourceCurrent }; break;
        }
        case 'document.excerpt': result = this.repository.cite(value.projectId, p as unknown as DocumentCitation); break;
        case 'document.query': result = this.repository.query(value.projectId, p as unknown as Parameters<DocumentRepository['query']>[1]); break;
        case 'document.expand': result = this.repository.expand(value.projectId, String(p.handle)); break;
        case 'document.rebuild': {
          if (!this.project.store.admitRequest(value.projectId, value.requestId, value)) result = { alreadyAdmitted: true };
          else result = this.repository.rebuild(value.projectId);
          break;
        }
        case 'document.original': {
          const version = this.versions(String(p.documentId)).find(item => item.artifactSha256 === p.artifactSha256);
          if (!version) throw new WorkbenchError('NOT_FOUND', 'Exact historical original is unavailable.');
          this.repository.original(value.projectId, version.versionId);
          result = { path: join(this.project.store.dataRoot, 'artifacts', version.artifactSha256), sha256: version.artifactSha256, mediaType: version.mediaType }; break;
        }
        default: throw new WorkbenchError('UNKNOWN_METHOD', 'Unsupported document request.');
      }
      const response: ProjectResponse = { schemaVersion: 1, requestId: value.requestId, result };
      if (!isProjectResponse(response)) throw new WorkbenchError('INVALID_REQUEST', 'Document preview exceeds the bounded message contract. Narrow the query.');
      return response;
    } catch (error) {
      const known = error instanceof WorkbenchError ? error : new WorkbenchError('DOCUMENT_UNAVAILABLE', 'Document operation failed. Retained originals and source were preserved.');
      return { schemaVersion: 1, requestId: value.requestId, error: { code: known.code, message: known.message, retryable: false } };
    }
  }
}
