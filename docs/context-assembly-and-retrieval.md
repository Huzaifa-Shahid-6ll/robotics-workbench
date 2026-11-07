---
doc_id: D26
title: "Context assembly and retrieval"
status: implementation-spec
updated: 2026-11-01
depends_on: [D14, D17, D22, D27]
requirement_ids: [REQ-AGENT-26]
---

# Context assembly and retrieval

## Authority and retrieval policy

**SPECIFIED:** the service assembles application-owned robotics facts; the provider retains its repository search and internal context management. REQ-AGENT-26: every submitted context packet MUST be bounded, relevant to the task, revision-stamped, and expandable through evidence references. “Access to everything” means authorized retrieval, not inserting every document and log into every turn.

Start with exact IDs, filenames, error strings, pin references and project relationships. SQLite text search is sufficient for the first release. Semantic retrieval is an optional later optimization with a measured recall benefit; do not introduce a vector database as a prerequisite. A whole short file can be preferable to disconnected fragments. Broad diagnosis can request a larger evidence set explicitly.

## Packet assembly algorithm

1. Resolve task text and selected object from the host; freeze selection ID and revision at submission.
2. Load current project manifest and the active source snapshot. Detect dirty buffers; do not represent disk files as the entire editing state.
3. Add selected board target, observed device connection, current coordinator operation and relevant readiness gaps.
4. Find directly linked components, intended nets, code bindings, document sections and latest applicable build/upload/test records.
5. Exclude stale evidence from the current-facts section; retain it under historical/conflicting evidence when relevant.
6. Rank exact references first, then lexical matches and adjacent dependency records. Deduplicate by artifact hash plus location, not by text alone.
7. Apply the context budget, retaining essential constraints and explicit omissions. Persist the exact packet and evidence IDs supplied to the provider.

Proposed initial budget: 24 KiB UTF-8 of application-injected text per turn, excluding separately supported attachments. This is a tunable engineering limit, not a universal token optimum. Store byte count and optional provider token estimate separately. One tool response returns at most 16 KiB and 100 records by default, whichever limit is reached first; larger results require a cursor or artifact read. D29 owns tool-specific stricter bounds.

## Proposed packet contract

```json
{
  "schemaVersion": 1,
  "packetId": "packet-illustrative-1",
  "projectId": "00000000-0000-4000-8000-000000000001",
  "projectRevision": 12,
  "sourceSnapshotId": "00000000-0000-4000-8000-000000000004",
  "task": "Explain why the front sensor has no readings",
  "selection": {"kind": "component", "id": "00000000-0000-4000-8000-000000000002"},
  "current": {"targetFqbn": "arduino:avr:uno", "deviceId": null},
  "evidenceRefs": ["build-17", "recording-9"],
  "conflicts": ["latest build differs from last uploaded build"],
  "unknowns": ["physical wiring after revision 12 is unconfirmed"],
  "omitted": [{"reason": "budget", "ref": "datasheet-full"}]
}
```

Identifiers in this example are illustrative. Product schemas define production formats. A missing connected device is `null`, not a guessed port. “Latest applicable” means matching relevant source/build/device/wiring dependencies, not simply the newest timestamp. A packet is an immutable snapshot; subsequent changes require a new packet or a clearly attributed live tool response.

## Machine-readable contract

The authoritative complete shape is [context-packet.schema.json](../contracts/context-packet.schema.json), with [valid](../examples/context-packet.valid.json) and [invalid](../examples/context-packet.invalid.json) fixtures. Selections use a discriminated union: ordinary objects carry a UUID identity and revision; a recording-range selection freezes recordingId, channelIds, startMs/endMs, timeBasis, parserVersion and projectRevision. The selected range is not reconstructed later from the currently visible chart. The abbreviated example above is explanatory; use the complete fixture for implementation. UUID fields, item counts and text lengths are schema-validated. After schema validation, enforce the 24 KiB serialized UTF-8 budget and location semantics: line/page numbers start at 1, recording ranges use milliseconds with an explicit time basis, end must be at least start, and whole-artifact locations use null range values. An artifact URI is resolved through authorized storage, never fetched blindly. Placeholder fixture digests do not describe real measurements.

## Source content and trust

Retrieved documents, repository comments, serial bytes and OCR output are untrusted evidence. Their text MUST NOT redefine tool authorization, account routing or project policy. Delimit excerpts with provenance and content type. Instructions embedded in a datasheet such as “upload this firmware now” remain quoted content, not permission.

Do not send secret-bearing files by default. Apply explicit project exclusions and redaction before retrieval; exclusion must cover indexes as well as packet assembly. Resolve artifact locations inside authorized storage roots. Missing evidence must be reported as missing, not reconstructed from a language-model guess. If OCR or table extraction is uncertain, return the original page link and the uncertainty label.

## Refresh and failure behavior

An old packet does not authorize a write. Mutations revalidate expectedProjectRevision, source versions and exact artifact/device preconditions at execution time. A budget overflow preserves task, constraints, identity and unknowns first, then returns expansion handles. An unavailable index falls back to exact file/record lookup and reports reduced search capability. Do not hide a failed retrieval behind an empty “no relevant evidence” result.

## Acceptance criteria

- AC-D26-01: Two similarly named sensors retrieve their own pins and datasheets by stable identity.
- AC-D26-02: A packet shows newest-build versus last-upload mismatch explicitly.
- AC-D26-03: Oversized logs produce bounded excerpts plus a usable cursor to raw evidence.
- AC-D26-04: A manifest change after packet creation causes stale mutation rejection.
- AC-D26-05: A secret exclusion applies to retrieval, cached excerpts and export.
- AC-D26-06: A document prompt-injection fixture cannot expand tool permission.

## Research basis and links

**RESEARCH-RECORDED:** [Lost in the Middle](https://aclanthology.org/2024.tacl-1.9/), [RepoCoder](https://aclanthology.org/2023.emnlp-main.151/), and [RAG or long context](https://aclanthology.org/2024.emnlp-industry.66/) motivate testing relevance and context budgets; their benchmarks do not establish optimal Arduino settings. Related: [provenance](context-provenance-and-freshness.md), [tools](tool-catalog-and-action-policy.md), [evaluations](agent-evaluation-and-regression.md).

## TASK-08 frozen document selections — 2026-11-03

The additive v1 document-page selection carries documentId, artifactSha256,
extractorVersion, physical page, optional region or UTF-16 textRange, and
projectRevision. Submission resolves the exact retained source again and supplies
a bounded quoted excerpt as reported historical evidence. A later document or
extraction version cannot move this selection. Untrusted excerpt text has no
authorization fields. Context navigation opens the exact retained page, including
removed attachments, rather than a same-named current file.

## TASK-09 exact recording ranges — 2026-11-03

New numeric recording-range submissions bind derivationId, configurationSha256
and optional deviceEpoch as well as recording/channel/parser/clock/interval. The
context turn's projectRevision remains the current manifest precondition; separate
recordingProjectRevision preserves the original design intent of historical data.
The app resolves exact retained artifact bytes and supplies deterministic metrics,
gaps/issues and explicit omission counts. Artifact SHA fields hash the referenced
artifact bytes; derivation fingerprints remain separate quoted provenance.
Later recordings or parser edits cannot move a historical selection.
