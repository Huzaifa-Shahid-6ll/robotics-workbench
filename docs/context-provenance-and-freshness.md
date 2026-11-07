---
doc_id: D27
title: "Context provenance and freshness"
status: implementation-spec
updated: 2026-11-01
depends_on: [D14, D17, D26]
requirement_ids: [REQ-AGENT-27]
---

# Context provenance and freshness

## Authority and invariant

**SPECIFIED:** context is evidence-linked information with explicit applicability. REQ-AGENT-27: intended design, user reports, physical measurements, model inferences and verification judgments MUST remain distinguishable. A confident explanation or generated schematic cannot become proof of physical wiring.

D14 owns stable identity, D17 owns event ordering, and this document owns evidence basis and freshness rules. The context inspector presents what the application knows about provider access, not hidden model reasoning or undisclosed provider memory. Labels must be honest about that visibility boundary.

## Records and semantics

```ts
interface Claim {
  claimId: string;
  subjectId: string;
  predicate: string;
  value: unknown;
  unit?: string;
  basis: "planned" | "reported" | "measured" | "inferred";
  sourceRefs: string[];
  actorId: string;
  recordedAt: string;
  observedAt?: string;
  projectRevision: number;
  deviceId?: string;
  sourceSnapshotId?: string;
  firmwareArtifactId?: string;
  supersedesId?: string;
  conflictGroupId?: string;
}
```

A verification record separately names procedure/version, criteria, evidenceRefs, evaluator, applicable dependencies and outcome `passed | failed | inconclusive`. “Measured” is not automatically “verified”: a measured supply voltage does not establish correct signal wiring. The application MUST NOT generate numeric hardware-confidence percentages from model wording.

Each evidence reference carries artifact ID, SHA256 digest, media type and location. Locations include file line range at a source snapshot, PDF page plus optional bounding region, or recording channel/time range with its time basis. UI labels expose observation and recording time when different. Raw data and derived values remain distinguishable.

## Freshness matrix

| Change | Required invalidation |
|---|---|
| Any manifest revision change | All revision-scoped physical confirmations become inapplicable in v1; affected functional judgments also require review |
| Firmware upload changes | Functional tests tied to previous firmware remain historical |
| Device replaced despite same port | Previous device observations cannot attach to the replacement |
| Datasheet content hash changes | Extracted chunks and derived specification claims require reindex/review |
| Source buffer changes | Diagnostics/build applicability follows source snapshot, not manifest revision alone |
| Renderer reconnects | No evidence invalidation by itself; refresh observable task state |

Freshness uses explicit applicability dependencies, with a conservative v1 rule: every manifest revision change invalidates all revision-scoped physical confirmations. Finer dependency-only invalidation is a later optimization requiring its own tests. A stable component datasheet does not expire merely because an hour passed. A live connection observation cannot remain current after a disconnect. Timestamp ordering alone does not resolve contradictory claims. Preserve both claims and record a new explicit resolution referencing them.

For example, design says trigger D8 while a user reports D9. The current summary MUST show “planned D8; reported D9; unresolved.” It cannot choose the newer statement as electrical truth. A later confirmed rewiring record can resolve the conflict for a new applicability scope, while retaining the historical disagreement.

## Inspector states

The application distinguishes `available`, `pinned`, `supplied-this-turn`, `observed-retrieved`, and `stale`. These are presentation facets rather than mutually exclusive claim truth states: an item can be pinned and stale. “Supplied” means the application transmitted it; “observed-retrieved” requires a visible tool result or provider event. Neither proves the model attended to or understood the content.

Selecting an inspector item opens the exact revision/source when retained. If only a current file remains and the original content is unavailable, display that limitation instead of moving the link silently to different text. The inspector should explain why an item is stale and which action can refresh the observation.

## Writes, immutable outcomes and recovery

Mutating requests carry current preconditions. A revision mismatch returns `REVISION_CONFLICT` with safe change information, never silently rebases an electrical change. Source writes also check the host document version. The coordinator validates build digest and device identity separately for upload.

Terminal operation receipts, including outcome-unknown, are immutable. Reconciliation appends a linked receipt and evidence; it does not overwrite the original uncertainty or claim that a lost upload definitely failed. Database success is not physical-action success. After restart, materialized freshness indexes can be rebuilt from durable records and artifact dependencies.

## Acceptance criteria

- AC-D27-01: A pin change advances the manifest revision and invalidates all revision-scoped physical confirmations in v1; historical evidence remains available.
- AC-D27-02: Reusing a COM number does not reuse old device measurements automatically.
- AC-D27-03: Conflicting planned/reported claims remain visible until explicitly resolved.
- AC-D27-04: The inspector never labels merely available files as provider-retrieved.
- AC-D27-05: A reconciliation receipt preserves the original outcome-unknown receipt unchanged.
- AC-D27-06: Asking for an unmeasured voltage yields an explicit unknown and an appropriate observation step.

## Sources

**RESEARCH-RECORDED:** [W3C PROV-DM](https://www.w3.org/TR/prov-dm/) supplies provenance concepts; [RFC 9110 conditional writes](https://www.rfc-editor.org/rfc/rfc9110.html#name-if-match) informs stale-write prevention; [LongMemEval](https://arxiv.org/html/2410.10813v2) motivates temporal/update tests. These do not certify physical truth. See [domain model](domain-model-and-identifiers.md) and [run comparison](experiments-and-run-comparison.md).
