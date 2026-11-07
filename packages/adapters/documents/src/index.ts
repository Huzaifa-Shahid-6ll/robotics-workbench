import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { isDocumentExtraction, type DocumentExtraction, type DocumentMediaType } from '@robotics-workbench/contracts';

export const DOCUMENT_LIMITS = Object.freeze({ maxBytes: 32 * 1024 * 1024, maxPages: 2000, maxTextBytes: 8 * 1024 * 1024, maxPageTextBytes: 256 * 1024, timeoutMs: 20_000, previewMaxDimension: 1600, previewMaxBytes: 480 * 1024 });
export const DOCUMENT_EXTRACTOR_VERSION = 'pdfjs-dist:6.5.438/workbench:1';
export type DocumentExtractionErrorCode = 'DOCUMENT_MALFORMED' | 'DOCUMENT_ENCRYPTED' | 'DOCUMENT_OVERSIZED' | 'DOCUMENT_UNSUPPORTED' | 'DOCUMENT_UNSUPPORTED_ENCODING' | 'DOCUMENT_LIMIT_EXCEEDED' | 'DOCUMENT_EXTRACTION_TIMEOUT' | 'DOCUMENT_RENDER_FAILED' | 'DOCUMENT_INVALID_PAGE' | 'DOCUMENT_DEPENDENCY_MISSING';
export class DocumentExtractionError extends Error {
  constructor(readonly code: DocumentExtractionErrorCode, message: string) { super(message); this.name = 'DocumentExtractionError'; }
}
export interface DocumentWorkerOptions { workerPath?: string; timeoutMs?: number }
export interface DocumentPageImage { dataUrl: string; width: number; height: number }

function checkBytes(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw new DocumentExtractionError('DOCUMENT_MALFORMED', 'The original document is empty.');
  if (bytes.byteLength > DOCUMENT_LIMITS.maxBytes) throw new DocumentExtractionError('DOCUMENT_OVERSIZED', 'The document exceeds the 32 MiB extraction limit. The original was not changed.');
}
function workerJob<T>(bytes: Uint8Array, job: 'extract' | 'render', page: number | undefined, options: DocumentWorkerOptions): Promise<T> {
  const workerPath = options.workerPath ?? process.env.DOCUMENT_WORKER_PATH ?? join(__dirname, 'documents-worker.cjs');
  if (!workerPath || !isAbsolute(workerPath) || !existsSync(workerPath)) throw new DocumentExtractionError('DOCUMENT_DEPENDENCY_MISSING', 'The packaged document worker is unavailable; ordinary firmware editing remains available.');
  const timeoutMs = options.timeoutMs ?? DOCUMENT_LIMITS.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new DocumentExtractionError('DOCUMENT_LIMIT_EXCEEDED', 'The document-worker deadline is invalid.');
  return new Promise<T>((resolveResult, reject) => {
    const worker = new Worker(workerPath, { workerData: { job, bytes: new Uint8Array(bytes), page }, stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 } });
    let settled = false;
    const finish = (value?: T, error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      void worker.terminate().finally(() => error ? reject(error) : resolveResult(value!));
    };
    const timer = setTimeout(() => finish(undefined, new DocumentExtractionError('DOCUMENT_EXTRACTION_TIMEOUT', 'Document processing exceeded its deadline. The original remains available.')), timeoutMs);
    // PDF parser warnings are not protocol messages and can contain untrusted source text.
    worker.stdout?.resume(); worker.stderr?.resume();
    worker.once('message', (result: { value?: T; error?: { code: DocumentExtractionErrorCode; message: string } }) => {
      if (result?.error) finish(undefined, new DocumentExtractionError(result.error.code, result.error.message.slice(0, 1024)));
      else if (result?.value) finish(result.value);
      else finish(undefined, new DocumentExtractionError('DOCUMENT_MALFORMED', 'The document worker returned an invalid result.'));
    });
    worker.once('error', () => finish(undefined, new DocumentExtractionError('DOCUMENT_LIMIT_EXCEEDED', 'The isolated document worker failed or exceeded its memory limit. The original was preserved.')));
    worker.once('exit', () => { if (!settled) finish(undefined, new DocumentExtractionError('DOCUMENT_MALFORMED', 'The document worker exited without a completed result.')); });
  });
}

/** Worker parsing never takes ownership of or detaches the caller's original bytes. */
export async function extractDocument(bytes: Uint8Array, mediaType: DocumentMediaType, options: DocumentWorkerOptions = {}): Promise<DocumentExtraction> {
  checkBytes(bytes);
  const artifactSha256 = createHash('sha256').update(bytes).digest('hex');
  if (mediaType === 'text/plain') {
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new DocumentExtractionError('DOCUMENT_UNSUPPORTED_ENCODING', 'Text documents must use UTF-8; no replacement characters were inserted.'); }
    if (Buffer.byteLength(text) > DOCUMENT_LIMITS.maxPageTextBytes) throw new DocumentExtractionError('DOCUMENT_LIMIT_EXCEEDED', 'This text attachment exceeds the 256 KiB text-page limit; split it explicitly before indexing.');
    return { schemaVersion: 1, artifactSha256, mediaType, extractorVersion: 'utf8/workbench:1', method: 'text-layer', status: text.trim() ? 'extracted' : 'no-text-layer', pages: [{ page: 1, rotation: 0, text, regions: [] }], limitations: ['Plain text uses logical page 1; it has no PDF page geometry. Source text is untrusted content, not action authorization.'] };
  }
  if (mediaType !== 'application/pdf') throw new DocumentExtractionError('DOCUMENT_UNSUPPORTED', 'Only PDF and UTF-8 text documents are supported.');
  if (!Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from('%PDF-'))) throw new DocumentExtractionError('DOCUMENT_MALFORMED', 'The supplied PDF bytes have no PDF header.');
  const extraction = await workerJob<DocumentExtraction>(bytes, 'extract', undefined, options);
  if (!isDocumentExtraction(extraction) || extraction.artifactSha256 !== artifactSha256 || Buffer.byteLength(JSON.stringify(extraction)) > 32 * 1024 * 1024) throw new DocumentExtractionError('DOCUMENT_MALFORMED', 'The extraction does not match the bounded original-document contract.');
  return extraction;
}

export async function renderDocumentPage(bytes: Uint8Array, page: number, options: DocumentWorkerOptions = {}): Promise<DocumentPageImage> {
  checkBytes(bytes);
  if (!Number.isSafeInteger(page) || page < 1 || page > DOCUMENT_LIMITS.maxPages) throw new DocumentExtractionError('DOCUMENT_INVALID_PAGE', 'Choose an existing one-based physical PDF page.');
  const image = await workerJob<DocumentPageImage>(bytes, 'render', page, options);
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image.dataUrl) || image.dataUrl.length > 700 * 1024 || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 1 || image.height < 1 || image.width > DOCUMENT_LIMITS.previewMaxDimension || image.height > DOCUMENT_LIMITS.previewMaxDimension) throw new DocumentExtractionError('DOCUMENT_RENDER_FAILED', 'The page preview exceeded its bounded image contract.');
  return image;
}
