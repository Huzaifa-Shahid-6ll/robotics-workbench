import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import type { DocumentExtraction, DocumentPage, DocumentRegion } from '@robotics-workbench/contracts';
import { DOCUMENT_EXTRACTOR_VERSION, DOCUMENT_LIMITS, DocumentExtractionError } from './index';

type TextItem = { str: string; transform: number[]; width: number; height: number; hasEOL?: boolean };

async function run(): Promise<unknown> {
  // Parsing/painting local bytes never follows source links, font URLs, XFA or document JavaScript.
  globalThis.fetch = async () => { throw new Error('Document-worker networking is disabled.'); };
  process.env.DISABLE_SYSTEM_FONTS_LOAD = '1';
  const vendor = join(__dirname, 'vendor');
  const runtime = createRequire(existsSync(vendor) ? join(vendor, 'package.json') : __filename);
  const pdfModule = runtime.resolve('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfRoot = dirname(dirname(dirname(pdfModule)));
  const { getDocument, Util } = await import(pathToFileURL(pdfModule).href) as typeof import('pdfjs-dist/legacy/build/pdf.mjs');
  class LocalAssets {
    async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
      const folder = ({ cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' } as Record<string, string>)[kind];
      if (!folder || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(filename) || filename.includes('..')) throw Error('Unsupported PDF asset reference.');
      const root = realpathSync(join(pdfRoot, folder)), path = join(root, filename), info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024 || realpathSync(path) !== path) throw Error('Invalid packaged PDF asset.');
      return new Uint8Array(readFileSync(path));
    }
  }
  const bytes = new Uint8Array(workerData.bytes);
  const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0, useSystemFonts: false, disableFontFace: true, useWorkerFetch: false, disableAutoFetch: true, disableStream: true, disableRange: true, enableXfa: false, stopAtErrors: true, isOffscreenCanvasSupported: false, isImageDecoderSupported: false, maxImageSize: 16_000_000, BinaryDataFactory: LocalAssets, cMapUrl: join(pdfRoot, 'cmaps') + '/', standardFontDataUrl: join(pdfRoot, 'standard_fonts') + '/', wasmUrl: join(pdfRoot, 'wasm') + '/' });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > DOCUMENT_LIMITS.maxPages) throw new DocumentExtractionError('DOCUMENT_LIMIT_EXCEEDED', 'The PDF exceeds the 2000-page processing limit.');
    if (workerData.job === 'render') {
      if (workerData.page > pdf.numPages) throw new DocumentExtractionError('DOCUMENT_INVALID_PAGE', 'The requested physical page does not exist in this exact PDF version.');
      const page = await pdf.getPage(workerData.page);
      const unscaled = page.getViewport({ scale: 1 });
      let scale = Math.min(1.5, DOCUMENT_LIMITS.previewMaxDimension / Math.max(unscaled.width, unscaled.height));
      for (let attempt = 0; attempt < 5; attempt++) {
        const viewport = page.getViewport({ scale });
        const { createCanvas } = runtime('@napi-rs/canvas') as typeof import('@napi-rs/canvas');
        const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
        const context = canvas.getContext('2d');
        await page.render({ canvas: canvas as never, canvasContext: context as never, viewport }).promise;
        const png = canvas.toBuffer('image/png');
        if (png.byteLength <= DOCUMENT_LIMITS.previewMaxBytes) return { dataUrl: `data:image/png;base64,${png.toString('base64')}`, width: canvas.width, height: canvas.height };
        scale *= 0.65;
      }
      throw new DocumentExtractionError('DOCUMENT_RENDER_FAILED', 'The page cannot fit the bounded PNG preview; the original was preserved.');
    }
    const labels = await pdf.getPageLabels();
    const pages: DocumentPage[] = [];
    let totalTextBytes = 0, totalRegions = 0;
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent({ disableNormalization: true, includeMarkedContent: false });
      const regions: DocumentPage['regions'] = [];
      const parts: string[] = [];
      let pageBytes = 0;
      for (const raw of content.items) {
        if (!('str' in raw)) continue;
        const item = raw as TextItem;
        pageBytes += Buffer.byteLength(item.str) + 1;
        if (pageBytes > DOCUMENT_LIMITS.maxPageTextBytes || totalTextBytes + pageBytes > DOCUMENT_LIMITS.maxTextBytes) throw new DocumentExtractionError('DOCUMENT_LIMIT_EXCEEDED', 'The PDF text exceeds the bounded extraction size; no partial index was presented as complete.');
        parts.push(item.str + (item.hasEOL ? '\n' : ' '));
        if (!item.str) continue;
        if (regions.length >= 20_000 || ++totalRegions > 100_000) throw new DocumentExtractionError('DOCUMENT_LIMIT_EXCEEDED', 'The PDF exceeds the bounded text-region count.');
        const style = content.styles[(raw as { fontName: string }).fontName];
        const ascent = typeof style?.ascent === 'number' ? style.ascent : typeof style?.descent === 'number' ? 1 + style.descent : 1;
        const tx = Util.transform(viewport.transform, item.transform);
        const angle = Math.atan2(tx[1], tx[0]) + (style?.vertical ? Math.PI / 2 : 0);
        const height = Math.hypot(tx[2], tx[3]), width = style?.vertical ? item.height : item.width;
        const topX = tx[4] + Math.sin(angle) * height * ascent;
        const topY = tx[5] - Math.cos(angle) * height * ascent;
        const corners = [[topX, topY], [topX + Math.cos(angle) * width, topY + Math.sin(angle) * width], [topX - Math.sin(angle) * height, topY + Math.cos(angle) * height], [topX + Math.cos(angle) * width - Math.sin(angle) * height, topY + Math.sin(angle) * width + Math.cos(angle) * height]];
        const clamp = (n: number) => Math.max(0, Math.min(1, n));
        const region: DocumentRegion = [clamp(Math.min(...corners.map(p => p[0]!)) / viewport.width), clamp(Math.min(...corners.map(p => p[1]!)) / viewport.height), clamp(Math.max(...corners.map(p => p[0]!)) / viewport.width), clamp(Math.max(...corners.map(p => p[1]!)) / viewport.height)];
        if (region.every(Number.isFinite)) regions.push({ text: item.str, region });
      }
      const text = parts.join('').trimEnd(); totalTextBytes += pageBytes;
      pages.push({ page: number, ...(labels?.[number - 1] !== undefined ? { printedPageLabel: labels[number - 1]! } : {}), rotation: ((page.rotate % 360 + 360) % 360) as DocumentPage['rotation'], text, regions });
      page.cleanup();
    }
    const result: DocumentExtraction = { schemaVersion: 1, artifactSha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'application/pdf', extractorVersion: DOCUMENT_EXTRACTOR_VERSION, method: 'text-layer', status: pages.some(page => page.text.trim()) ? 'extracted' : 'no-text-layer', pages, limitations: ['Text-layer reading order and table structure may be incomplete; review the original page image and footnotes. No OCR or numeric fact promotion was performed.', 'PDF instructions and links are untrusted document content, not action authorization.', 'Preview decoding limits individual images to 16 million pixels; unsupported or larger image content may be omitted. Open the exact original independently when full visual fidelity is required.'] };
    return result;
  } catch (error) {
    if (error instanceof DocumentExtractionError) throw error;
    const name = (error as Error)?.name;
    if (name === 'PasswordException') throw new DocumentExtractionError('DOCUMENT_ENCRYPTED', 'The PDF requires a password. Its original bytes remain attached; no password was requested or stored.');
    throw new DocumentExtractionError(workerData.job === 'render' ? 'DOCUMENT_RENDER_FAILED' : 'DOCUMENT_MALFORMED', 'PDF processing failed. The original remains available; malformed or unsupported content was not invented.');
  } finally { await task.destroy(); }
}

if (parentPort) void run().then(value => parentPort!.postMessage({ value }), error => parentPort!.postMessage({ error: { code: error instanceof DocumentExtractionError ? error.code : 'DOCUMENT_DEPENDENCY_MISSING', message: error instanceof DocumentExtractionError ? error.message : 'The optional PDF.js/canvas runtime could not be loaded.' } }));
