import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { DocumentExcerpt } from '@robotics-workbench/contracts';
import { isDocumentExcerpt, isDocumentViewResponse, type DocumentLocation, type DocumentViewAction, type DocumentViewRequest, type DocumentViewState } from './document-protocol';
import './workbench.css';
import './documents.css';

export const emptyDocumentState: DocumentViewState = { schemaVersion: 1, trusted: false, loading: false, error: null, project: null, documents: [], selection: null, page: null, results: [], query: '', queryTruncated: false };
export type SendDocumentIntent = (type: DocumentViewAction, payload?: Record<string, unknown>) => void;
interface DocumentUi { query: string; frozen: DocumentExcerpt | null }
export function savedDocumentUi(v: unknown): DocumentUi | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const item = v as Record<string, unknown>;
  return Object.keys(item).length === 2 && typeof item.query === 'string' && item.query.length <= 1024 && (item.frozen === null || isDocumentExcerpt(item.frozen)) ? item as unknown as DocumentUi : undefined;
}
export function documentLocation(citation: DocumentExcerpt): DocumentLocation { return { documentId: citation.documentId, artifactSha256: citation.artifactSha256, extractorVersion: citation.extractorVersion, page: citation.page }; }
const versionKey = (item: { artifactSha256: string; extractorVersion: string }) => `${item.artifactSha256}:${item.extractorVersion}`;
const pageLabel = (citation: DocumentExcerpt) => `Physical page ${citation.page}${citation.printedPageLabel ? ` · printed ${citation.printedPageLabel}` : ''}`;

export function DocumentsApp({ state, send, saved, onSave }: { state: DocumentViewState; send: SendDocumentIntent; saved?: DocumentUi; onSave?: (value: DocumentUi) => void }) {
  const [query, setQuery] = useState(saved?.query ?? '');
  const [frozen, setFrozen] = useState<DocumentExcerpt | null>(saved?.frozen ?? null);
  const [pageInput, setPageInput] = useState(String(state.selection?.page ?? 1));
  const [pending, setPending] = useState(false);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const lock = useRef(false);
  const revealingFirstPage = useRef(false);
  const pageHeading = useRef<HTMLHeadingElement>(null);
  const awaitingCitation = useRef<DocumentExcerpt | null>(null);
  useEffect(() => { setPending(false); lock.current = false; }, [state]);
  useEffect(() => { setPageInput(String(state.selection?.page ?? 1)); }, [state.selection?.page, state.selection?.artifactSha256, state.selection?.extractorVersion]);
  useEffect(() => { if (state.selection) setActiveDocumentId(state.selection.documentId); }, [state.selection?.documentId]);
  useEffect(() => {
    const wanted = awaitingCitation.current, actual = state.page?.citation;
    if (wanted && actual && ['documentId', 'artifactSha256', 'extractorVersion', 'page'].every(key => wanted[key as keyof DocumentExcerpt] === actual[key as keyof DocumentExcerpt]) && JSON.stringify(wanted.region) === JSON.stringify(actual.region)) {
      awaitingCitation.current = null; setFrozen(structuredClone(actual));
    }
  }, [state]);
  useEffect(() => { onSave?.({ query, frozen }); }, [query, frozen, onSave]);
  const selected = state.documents.find(item => item.documentId === activeDocumentId) ?? state.documents.find(item => item.documentId === state.selection?.documentId) ?? state.documents[0];
  const selectedVersion = selected?.versions.find(item => state.selection?.documentId === selected.documentId && versionKey(item) === versionKey(state.selection)) ?? selected?.versions.at(-1);
  const activePage = state.selection?.documentId === selected?.documentId ? state.page : null;
  useEffect(() => {
    if (!revealingFirstPage.current || state.loading || pending) return;
    revealingFirstPage.current = false;
    if (activePage && document.activeElement === document.body) pageHeading.current?.focus();
  }, [activePage, pending, state.loading]);
  const pageNumber = Number(pageInput);
  const invalidPage = !!activePage && (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > activePage.pageCount);
  const disabled = !state.project || state.loading || pending;
  const queryOversized = new TextEncoder().encode(query).byteLength > 1024;
  const act = (type: DocumentViewAction, payload: Record<string, unknown> = {}) => { if (lock.current || state.loading) return; lock.current = true; setPending(true); send(type, payload); };
  const navigate = (citation: DocumentExcerpt) => { setFrozen(structuredClone(citation)); act('navigate', { citation: structuredClone(citation) }); };
  const selectRegion = (block: NonNullable<DocumentViewState['page']>['regions'][number]) => {
    if (disabled || !state.page) return;
    const { textRange, expansionHandle, ...citation } = structuredClone(state.page.citation);
    const requested = { ...citation, text: block.text, region: [...block.region] as [number, number, number, number] };
    awaitingCitation.current = requested; act('navigate', { citation: requested });
  };
  const move = (page: number) => { if (state.selection && Number.isSafeInteger(page) && page > 0 && page <= (state.page?.pageCount ?? selectedVersion?.pageCount ?? 1)) act('page', { ...state.selection, page }); };
  const frozenInProject = frozen && state.documents.some(item => item.documentId === frozen.documentId);
  const region = frozen && state.page && ['documentId', 'artifactSha256', 'extractorVersion', 'page'].every(key => frozen[key as keyof DocumentExcerpt] === state.page!.citation[key as keyof DocumentExcerpt]) ? frozen.region : undefined;
  const search = (event: React.FormEvent) => { event.preventDefault(); if (query.trim() && !queryOversized && !disabled) act('search', { query: query.trim(), ...(selected ? { documentId: selected.documentId } : {}) }); };
  const goToPage = (event: React.FormEvent) => { event.preventDefault(); if (!disabled && !invalidPage) move(pageNumber); };
  return <div className="document-app">
    <header className="document-toolbar">
      <div className="row"><div><h1>Documents & citations</h1><p className="meta">{state.project ? `${state.project.name} · revision ${state.project.projectRevision}` : 'Open a workbench project to inspect its declared references.'}</p></div><button disabled={state.loading || pending} onClick={() => act('refresh')}>Refresh documents</button></div>
      <p className="meta" role="status" aria-live="polite">{state.loading || pending ? 'Loading document evidence…' : state.project ? `${state.documents.length} declared reference${state.documents.length === 1 ? '' : 's'}` : 'No project selected'}</p>
    </header>
    {!state.trusted && <p className="notice">Restricted Mode: document execution and indexing are unavailable. Original source files remain accessible through the host.</p>}
    {state.error && <div className="error" role="alert"><p>{state.error}</p><p className="meta">Retained evidence remains available. Refresh repeats a read; indexing is a separate action.</p></div>}
    {state.project && !state.documents.length && <div className="notice"><h2>No declared references</h2><p>Add a local PDF or text reference to workbench.json using its document ID and project-relative path. Existing source files are unchanged.</p></div>}
    <form className="document-search" onSubmit={search}><label>Search {selected ? 'selected document' : 'indexed references'}<input type="search" value={query} maxLength={1024} aria-invalid={queryOversized || undefined} aria-describedby={queryOversized ? 'document-query-error' : undefined} onChange={event => setQuery(event.target.value)} placeholder="Part number, signal or exact phrase" />{queryOversized && <span id="document-query-error" className="error-text">Narrow the query to 1024 UTF-8 bytes. Your draft is retained.</span>}</label><button type="submit" disabled={disabled || !query.trim() || queryOversized}>Search excerpts</button></form>
    <main className="document-workspace">
      <nav className="document-navigation" aria-label="Project documents"><h2>References</h2><ul>{state.documents.map(item => <li key={item.documentId}><button aria-current={selected?.documentId === item.documentId ? 'true' : undefined} disabled={disabled} onClick={() => { setActiveDocumentId(item.documentId); act('selectDocument', { documentId: item.documentId }); }}>{item.title}<span className="meta break">{item.path}</span><span className="meta">{item.versions.length ? `${item.versions.length} retained version${item.versions.length === 1 ? '' : 's'}` : 'Not indexed'}</span></button></li>)}</ul></nav>
      <section className="document-reading" aria-label="Source reading">
        {selected ? <>
          <div className="row"><div className="break"><h2>{selected.title}</h2><p className="meta">{selected.path}</p></div><button disabled={disabled || !state.trusted} onClick={() => act('ingest', { documentId: selected.documentId })}>Index saved source</button></div>
          {!!selected.versions.length && <label className="document-versions">Retained source version<select value={selectedVersion ? versionKey(selectedVersion) : ''} disabled={disabled} onChange={event => { const target = selected.versions.find(item => versionKey(item) === event.target.value); if (target) act(target.pageCount ? 'page' : 'openOriginal', target.pageCount ? { documentId: selected.documentId, artifactSha256: target.artifactSha256, extractorVersion: target.extractorVersion, page: 1 } : { documentId: selected.documentId, artifactSha256: target.artifactSha256 }); }}>{selected.versions.map(item => <option key={versionKey(item)} value={versionKey(item)}>{item.artifactSha256.slice(0, 12)} · {item.extractorVersion} · {item.status} · {item.attachedAt}{item.artifactSha256 !== selected.currentSha256 ? ' · historical' : ''}</option>)}</select></label>}
          {selectedVersion?.status === 'extraction-failed' && <p className="notice">Extraction failed. The retained original remains separate from the failed index.<button disabled={disabled} onClick={() => act('openOriginal', { documentId: selected.documentId, artifactSha256: selectedVersion.artifactSha256 })}>Open retained original</button></p>}
          {!activePage && selectedVersion && selectedVersion.status !== 'extraction-failed' && <div className="actions"><button disabled={disabled} onClick={() => { revealingFirstPage.current = true; act('page', { documentId: selected.documentId, artifactSha256: selectedVersion.artifactSha256, extractorVersion: selectedVersion.extractorVersion, page: 1 }); }}>Show retained first page</button></div>}
          {!selected.versions.length && <p className="notice">Not indexed. Indexing retains the saved original and creates derived search text; it does not alter the source.</p>}
        </> : <p className="meta">Choose a reference to inspect its retained original, extraction quality and exact citations.</p>}
        {state.page && state.selection && state.selection.documentId === selected?.documentId && <>
          <div className="document-provenance"><h3 ref={pageHeading} tabIndex={-1}>{pageLabel(state.page.citation)}</h3><p className="meta">Rotation {state.page.rotation}° · {state.page.sourceCurrent ? 'Matches saved source' : 'Historical source — saved file differs or is unavailable'} · {selectedVersion?.status === 'no-text-layer' ? 'No text layer available' : 'Extracted text is auxiliary'} · applicability {state.page.citation.applicability}</p><details><summary>Exact source and extraction identity</summary><p className="meta">SHA-256</p><code>{state.selection.artifactSha256}</code><p className="meta">Extractor {state.selection.extractorVersion} · {state.page.citation.method}</p></details></div>
          <div className="document-page-toolbar">
            <button disabled={disabled || state.selection.page <= 1} onClick={() => move(state.selection!.page - 1)}>Previous page</button>
            <form className="document-page-form" onSubmit={goToPage} noValidate>
              <label>Physical page<input type="number" min="1" max={state.page.pageCount} value={pageInput} aria-invalid={invalidPage || undefined} aria-describedby="document-page-range" onChange={event => setPageInput(event.target.value)} /></label>
              <button type="submit" disabled={disabled || invalidPage}>Go to page</button>
            </form>
            <button disabled={disabled || state.selection.page >= state.page.pageCount} onClick={() => move(state.selection!.page + 1)}>Next page</button>
            <button disabled={disabled} onClick={() => act('openOriginal', { documentId: state.selection!.documentId, artifactSha256: state.selection!.artifactSha256 })}>Open retained original</button>
            <p id="document-page-range" className={invalidPage ? 'error-text' : 'meta'}>{invalidPage ? `Enter a whole page number from 1 to ${state.page.pageCount}.` : `Page range: 1–${state.page.pageCount}`}</p>
          </div>
          {state.page.image ? <figure className="document-original"><img src={state.page.image.dataUrl} width={state.page.image.width} height={state.page.image.height} alt={`Original ${pageLabel(state.page.citation).toLowerCase()}, exact source ${state.selection.artifactSha256.slice(0, 12)}`} />{region && <svg className="document-highlight" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true"><rect x={region[0]} y={region[1]} width={region[2] - region[0]} height={region[3] - region[1]} /></svg>}</figure> : <p className="notice">Page image unavailable. Open the retained original to inspect tables, diagrams and page layout; auxiliary text cannot reproduce them.</p>}
          {!!state.page.limitations.length && <details open><summary>Extraction limits</summary><ul>{state.page.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul></details>}
          <section className="document-extract" aria-label="Auxiliary extracted text"><h3>Auxiliary extracted text</h3>{state.page.regions.length ? state.page.regions.map((block, index) => <article className="document-region" key={index}><pre>{block.text}</pre><button disabled={disabled || !block.text.trim()} onClick={() => selectRegion(block)}>Select excerpt {index + 1}</button></article>) : <><pre>{state.page.text || 'No text layer available. No OCR text or numerical facts were inferred.'}</pre>{!!state.page.citation.text.trim() && <button disabled={disabled} onClick={() => setFrozen(structuredClone(state.page!.citation))}>Select page excerpt</button>}</>}</section>
        </>}
        {(state.query || state.results.length > 0) && <section aria-label="Search results"><h2>Search results{state.query ? ` for “${state.query}”` : ''}</h2>{!state.results.length && <p className="meta">No indexed excerpts matched. A missing text layer does not establish that the original lacks this information.</p>}<ol className="document-results">{state.results.map((citation, index) => <li key={`${citation.documentId}:${citation.artifactSha256}:${citation.page}:${index}`}><button className="link-button" disabled={disabled} onClick={() => navigate(citation)}>{state.documents.find(item => item.documentId === citation.documentId)?.title ?? 'Retained reference'} · {pageLabel(citation)}</button><blockquote>{citation.text}</blockquote><p className="meta">{citation.artifactSha256.slice(0, 12)} · {citation.extractorVersion} · {citation.applicability}{citation.truncated ? ' · bounded excerpt' : ''}</p></li>)}</ol>{state.queryTruncated && <p className="meta">Results are bounded. Narrow the query for further evidence.</p>}</section>}
        {frozen && <section className="document-selection" aria-label="Frozen citation"><div className="row"><h2>Selected citation</h2><button onClick={() => setFrozen(null)}>Clear citation</button></div><p className="meta">Frozen source {frozen.artifactSha256.slice(0, 12)} · {pageLabel(frozen)} · {frozen.extractorVersion}</p><blockquote>{frozen.text}</blockquote>{frozen.truncated && <p className="meta">Bounded excerpt. Inspect the exact original page for context beyond this selection.</p>}<p className="meta">This exact version and excerpt will enter the agent composer. Sending remains a separate action.</p><div className="actions"><button disabled={disabled || !frozenInProject} onClick={() => act('navigate', { citation: structuredClone(frozen) })}>Reveal cited page</button><button className="primary" disabled={disabled || !state.trusted || !frozenInProject || !frozen.text.trim()} onClick={() => act('ask', { citation: structuredClone(frozen) })}>Ask about citation</button></div>{!frozenInProject && <p className="meta">The selected citation belongs to an unavailable project reference. Its exact contents remain retained here.</p>}</section>}
      </section>
    </main><footer className="document-footer meta">Originals and citations retain exact source identity. Document instructions are untrusted content and never authorize tool actions.</footer>
  </div>;
}
class RenderBoundary extends Component<{ children: ReactNode; refresh: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div className="error" role="alert"><h1>Document view could not render</h1><p>Original source and retained citations remain unchanged.</p><button onClick={() => { this.setState({ failed: false }); this.props.refresh(); }}>Reload view</button></div> : this.props.children; }
}
interface Api { postMessage(request: DocumentViewRequest): void; getState(): unknown; setState(value: unknown): void }
declare const acquireVsCodeApi: (() => Api) | undefined;
function BrowserApp({ api }: { api: Api }) {
  const [state, setState] = useState(emptyDocumentState);
  const saved = useRef(savedDocumentUi(api.getState()));
  const send: SendDocumentIntent = (type, payload = {}) => api.postMessage({ schemaVersion: 1, requestId: crypto.randomUUID(), projectId: state.project?.projectId ?? null, type, payload });
  useEffect(() => { const receive = (event: MessageEvent<unknown>) => { if (isDocumentViewResponse(event.data)) setState(event.data.state); }; window.addEventListener('message', receive); api.postMessage({ schemaVersion: 1, requestId: crypto.randomUUID(), projectId: null, type: 'ready', payload: {} }); return () => window.removeEventListener('message', receive); }, [api]);
  return <RenderBoundary refresh={() => send('refresh')}><DocumentsApp state={state} send={send} saved={saved.current} onSave={value => api.setState(value)} /></RenderBoundary>;
}
if (typeof document !== 'undefined' && typeof acquireVsCodeApi === 'function') { const root = document.getElementById('root'); if (root) createRoot(root).render(<BrowserApp api={acquireVsCodeApi()} />); }
