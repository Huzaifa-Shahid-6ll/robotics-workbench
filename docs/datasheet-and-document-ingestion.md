---
doc_id: D38
title: "Datasheet and document ingestion"
status: implementation-spec
updated: 2026-11-01
depends_on: [D16, D20, D26, D34]
requirement_ids: [REQ-HW-38-01]
---

# Datasheet and document ingestion

## Purpose and authority

**SPECIFIED — REQ-HW-38-01:** Preserve original engineering documents and return source-located excerpts to the agent. Extracted text, OCR, summaries, and inferred facts are derived data; none may replace the original source. Start with PDF.js for page/text access and SQLite FTS5 for local search. OCR and sophisticated table extraction are optional later workers, not first-run dependencies.

## Ingestion and source identity

Accept local PDF/text files or an explicitly requested URL. Source URLs may be fetched only through the configured retrieval policy; do not automatically follow embedded PDF links or download referenced binaries. Restrict redirects and network destinations according to D20. Files are untrusted input regardless of manufacturer branding. Hash original bytes with SHA256 before ingestion and retain them in immutable document storage.

Record documentId, artifact hash, filename, MIME type, byte size, attachment time, source URL when supplied, declared title/manufacturer/part family, stated revision/date, and user association. PDF metadata is a hint, not sole authority. The same hash under another filename deduplicates bytes while retaining both attachment records. Changed bytes at the same URL create a new document version; they do not overwrite historical citations.

The user may attach a chip datasheet to a module as background evidence, but the association MUST distinguish chip facts from module connector/board facts. A similarly named part or package is not automatically applicable. Component identity and source applicability require explicit review where uncertain.

## Extraction and indexing

Extract original text items with page number and available coordinates; maintain normalized search text separately. Preserve extractor name/version, original document hash, extraction time, and method (`text-layer`, `ocr`, `table-parser`, or `model-interpretation`). Text order in multi-column PDFs and table cell structure can be wrong. If extraction is empty, report “no text layer available” and offer page preview or optional OCR; do not treat the document as irrelevant.

Index pages/sections in FTS5 with exact component/part filters before ranking. Verify FTS5 exists in the packaged SQLite build. Rebuilding indexes must never delete originals, reviewed facts, or citation identities. An index key includes hash and extractor version; changed extraction creates a new derived version. Agent retrieval uses bounded results with neighboring-page/region expansion rather than injecting complete PDFs.

An application retrieval result has this contract:

```ts
type DocumentExcerpt = {
  documentId: string;
  artifactSha256: string;
  page: number;                 // one-based physical PDF page
  printedPageLabel?: string;
  region?: [number, number, number, number]; // normalized page coordinates
  textRange?: [number, number]; // UTF-16 offsets in exact extracted page text, [start,end)
  text: string;
  method: 'text-layer' | 'ocr' | 'table-parser' | 'model-interpretation';
  extractorVersion: string;
  applicability: 'confirmed' | 'candidate' | 'unresolved';
  truncated: boolean;
  expansionHandle?: string;
};
```

Region coordinates use a documented top-left normalized coordinate convention and must be mapped consistently through rotation. Printed page labels are separate from physical PDF page indexes. The same citation opens the exact UI page/region; a model must not invent page numbers from a title or snippet.

Text ranges and geometric regions are mutually exclusive. Text ranges identify the
exact retained extraction's page text, use an exclusive end, and cannot split a
Unicode surrogate pair. This supports bounded matches in long plain-text or PDF
pages without substituting the first page excerpt. Changing the extractor version
does not reinterpret an older text range.

## Candidate facts and review

Extracted numeric facts retain original text, unit, min/typical/max classification, operating conditions, footnotes, package/variant applicability, page region, and confidence/review status. Review promotes a candidate into the component-definition workflow; it does not mutate the manufacturer original. Unknown units or ambiguous glyphs block numeric normalization. Explicit tests cover µA/mA, minus signs, decimal separators, superscripts, and OCR confusion.

Tables and pinout diagrams require preserved page images for review. An agent may explain an excerpt but cannot silently discard footnotes or substitute a related variant's specification. Conflicting sources remain available with provenance and date. Replacing a datasheet marks dependent facts for review rather than automatically declaring the newer file correct for an older hardware revision.

## Errors and recovery

Malformed/encrypted/oversized PDFs, unsupported encoding, extraction timeout, missing OCR, FTS failure, and unavailable URLs produce distinct operation results. A successful original attachment can coexist with failed indexing; show both and keep source preview available where safe. Do not require uploading private documents to a model service for local indexing. If OCR/model processing sends pages externally, expose the destination and apply configured data policy.

Document instructions such as “ignore previous rules” or embedded shell commands remain source content, never user authorization. PDF previews require isolated rendering and disabled active content. Deletion removes an attachment by default; deleting shared original bytes must account for all citations and retained experiment dependencies.

## Acceptance criteria

- **AC-D38-01:** Every returned excerpt opens the matching hash/page/region, including rotated pages and printed-page offsets.
- **AC-D38-02:** Identical bytes deduplicate while changed bytes retain separate versions and historical citations.
- **AC-D38-03:** Scanned/multi-column/table fixtures expose extraction limits and do not fabricate precise facts.
- **AC-D38-04:** Variant/unit ambiguity cannot silently populate component limits.
- **AC-D38-05:** Index deletion/rebuild preserves originals and reviewed facts.
- **AC-D38-06:** Embedded instructions cannot trigger commands or external transfers.

## Sources and related documents

- [PDF.js examples](https://mozilla.github.io/pdf.js/examples/), [PDF.js public API](https://github.com/mozilla/pdf.js/blob/master/src/display/api.js), [SQLite FTS5](https://sqlite.org/fts5.html) — RESEARCH-RECORDED, 2026-10-31; versions and performance remain VALIDATION-GATE.
- [TI L293/L293D datasheet](https://www.ti.com/lit/ds/symlink/l293.pdf) — example of variant-specific applicability.
- [Context retrieval](context-assembly-and-retrieval.md), [components](components-and-parts-catalog.md), [storage](storage-and-migrations.md).

## TASK-08 implementation — 2026-11-03

Manifest document associations remain ordinary-file authority. The document adapter
uses PDF.js 6.5.438 and canvas 1.1.0 in a bounded worker. Originals and derived
extractions are SHA-addressed artifacts; SQLite migration 2 retains source versions
and a rebuildable FTS5 index. Exact historical hashes/pages/regions/text ranges
remain addressable after replacement or attachment removal. Indexing is explicit
and refuses dirty host buffers or a changed saved-source hash. A failed extraction
retains the original and a distinct error; no OCR or reviewed electrical facts are
invented. Read-only PNG page rendering shares the existing heavy-job coordinator
using document-ingest receipts whose tool is document-page-preview.

The S11 view shows isolated original-page PNGs, bounded auxiliary text, provenance,
search, immutable selections and explicit historical status. Ask prepares context;
sending remains separate. Document text cannot create a tool permission. Open
original saves a verified exact copy under a new filename rather than overwriting
source. Network retrieval, OCR and automatic numeric fact promotion remain absent.
Unsupported content/large embedded images may be omitted from previews and are
labelled; originals remain retained. Native page images and extraction checks are
software evidence, never manufacturer applicability or physical verification.

Current API references were checked through Context7 against Mozilla's PDF.js
source and the installed version types. See tasks/TASK-08.md and
verification/task-08.json for executed evidence and remaining limitations.
