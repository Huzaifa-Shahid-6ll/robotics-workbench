import type { DocumentViewState } from '@robotics-workbench/webviews';

export const documentFixtureIds = { project: '11111111-1111-4111-8111-111111111111', document: '88888888-8888-4888-8888-888888888888', scan: '99999999-9999-4999-8999-999999999999', unindexed: '77777777-7777-4777-8777-777777777777', request: '66666666-6666-4666-8666-666666666666' };
/** Synthetic source/citations exercise presentation; they establish no component fact. */
export function documentViewFixture(): DocumentViewState {
  const i = documentFixtureIds, old = 'a'.repeat(64), current = 'b'.repeat(64), extractorVersion = 'pdfjs-fixture-v1';
  const citation = { documentId: i.document, artifactSha256: old, page: 2, printedPageLabel: '1', text: 'Synthetic range conditions: values require reviewed variant applicability.', method: 'text-layer' as const, extractorVersion, applicability: 'unresolved' as const, truncated: false, region: [0.1, 0.2, 0.9, 0.3] as [number, number, number, number] };
  return { schemaVersion: 1, trusted: true, loading: false, error: null, project: { projectId: i.project, projectRevision: 4, name: 'Document evidence fixture' },
    documents: [{ documentId: i.document, title: 'Range module background', path: 'docs/module.pdf', currentSha256: current, versions: [{ artifactSha256: current, extractorVersion, pageCount: 3, status: 'extracted', mediaType: 'application/pdf', attachedAt: '2026-11-03T08:00:00Z' }, { artifactSha256: old, extractorVersion, pageCount: 3, status: 'extracted', mediaType: 'application/pdf', attachedAt: '2026-11-02T08:00:00Z' }] },
      { documentId: i.scan, title: 'Image-only reference', path: 'docs/scan.pdf', currentSha256: 'c'.repeat(64), versions: [{ artifactSha256: 'c'.repeat(64), extractorVersion, pageCount: 1, status: 'no-text-layer', mediaType: 'application/pdf', attachedAt: '2026-11-03T08:00:00Z' }] },
      { documentId: i.unindexed, title: 'Part notes', path: 'docs/part-notes.txt', currentSha256: null, versions: [] }],
    selection: { documentId: i.document, artifactSha256: old, extractorVersion, page: 2 },
    page: { citation, pageCount: 3, rotation: 90, text: citation.text, regions: [{ text: citation.text, region: [...citation.region] }], image: null, limitations: ['Synthetic fixture. Extraction order and table structure require inspection of the exact original.'], sourceCurrent: false },
    results: [], query: '', queryTruncated: false };
}
