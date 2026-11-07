---
doc_id: D28
title: "Memory and session continuity"
status: implementation-spec
updated: 2026-11-01
depends_on: [D16, D21, D26, D27]
requirement_ids: [REQ-AGENT-28]
---

# Memory and session continuity

## Authority and core policy

**SPECIFIED:** provider sessions preserve provider-specific execution history; application memory preserves shared facts, decisions and evidence. REQ-AGENT-28: resuming or switching providers MUST preserve attributable project knowledge without treating a generated summary as authoritative physical state.

Do not require a graph database, embedding service or a second model to manage memory. Files and SQLite records are sufficient for the initial implementation. Keep durable instructions short and stable; live COM-port assignments, latest sensor readings and active operations belong in queryable state, not AGENTS.md.

## Memory classes

| Class | Example | Authority and update rule |
|---|---|---|
| Project intent | Intended sensor pin or target configuration | Manifest; update with revision preconditions |
| Operational evidence | Build, upload, capture and experiment receipts | Immutable records and artifacts |
| User decisions | “Prefer explanations before complex edits” | Explicit attributed preference; user can change it |
| Derived lesson | A startup delay helped one module in one run | Linked hypothesis/judgment with applicable scope |
| Provider session reference | Codex thread or OpenCode session ID | Opaque provider identifier with version/workspace binding |

Derived lessons MUST retain input evidence references and applicability. Repeated mention is not verification. An agent cannot overwrite a measurement with a summarized value. A superseded note stays identifiable in history but is omitted from current-fact retrieval unless relevant.

## Checkpoint and handoff contract

Create an application checkpoint after a completed turn, after a user decision, before a provider switch, and before deliberate shutdown. A checkpoint failure must not corrupt the underlying task or artifact records.

```json
{
  "schemaVersion": 1,
  "checkpointId": "checkpoint-example",
  "taskId": "task-example",
  "projectId": "00000000-0000-4000-8000-000000000001",
  "projectRevision": 12,
  "sourceSnapshotId": "00000000-0000-4000-8000-000000000004",
  "goal": "Diagnose missing front range readings",
  "decisions": ["Keep current sensor library until baseline compile passes"],
  "completed": [{"summary": "Compile passed", "evidenceRefs": ["build-17"]}],
  "remaining": ["Compare actual wiring with intended D8/D9 assignment"],
  "unknowns": ["Physical wiring not confirmed"],
  "activeOperationIds": [],
  "providerSessionRef": "opaque-local-reference"
}
```

The summary must distinguish completed, attempted, pending and unknown work. Store the exact checkpoint content with generation time, producer and source references. Validate referenced IDs exist. A summary may omit detail but must not replace the source record. Keep user instructions separate from quotations found inside untrusted project documents.

## Resume procedure

First reconcile current filesystem, dirty buffers, manifest revision, coordinator leases and operation receipts. Then inspect provider availability and the saved session/workspace binding. If compatible, resume the opaque provider session and submit a brief delta describing changes since its checkpoint. If incompatible, open a new session with an application-owned handoff packet and disclose that it is a new session.

Provider switching never copies private credentials, hidden reasoning, or unsupported internal session files. It transfers goal, explicit decisions, current snapshot, pending questions, relevant evidence and current operation state. An unfinished hardware operation remains owned by the coordinator; switching provider neither repeats nor cancels it automatically.

Memory retrieval starts with project/component/build identity, then relevant text search. A note about a previous board cannot become a current observation because the new board has the same name. A stale but useful lesson can appear under historical guidance with its original device and firmware scope.

## Retention, correction and deletion

Default retention is local and explicit in D16. Users can remove a note, correct a decision, clear derived summaries, or delete an entire local session. Deleting a summary must invalidate derived indexes and cached excerpts. Deleting a referenced artifact leaves a visible missing-evidence marker where historical receipts must remain interpretable; do not fabricate replacement data.

“Clear workbench memory” does not promise deletion from external provider services or logout from installed tools. The UI states the local scope and links to provider-owned controls where applicable. Export excludes credentials and unrelated provider histories. Import creates fresh local bindings and never treats archived device connection state as live.

## Acceptance criteria

- AC-D28-01: Restart restores the goal and evidence links without repeating a completed upload.
- AC-D28-02: Codex-to-OpenCode handoff identifies stale wiring confirmation correctly.
- AC-D28-03: A corrected decision supersedes the old one while preserving its provenance.
- AC-D28-04: Missing raw evidence remains visibly missing after summary retrieval.
- AC-D28-05: Clearing local summaries does not delete firmware files or claim external-provider deletion.
- AC-D28-06: A current snapshot is fetched before resuming a mutation from an old checkpoint.

## Research basis and links

**RESEARCH-RECORDED:** [MemGPT](https://arxiv.org/html/2310.08560v2), [LongMemEval](https://arxiv.org/html/2410.10813v2), and [A-Mem](https://arxiv.org/html/2502.12110v4) inform retained evidence and selective recall. Their text-memory evaluations do not validate hardware state tracking. See [storage](storage-and-migrations.md), [context](context-assembly-and-retrieval.md), [provenance](context-provenance-and-freshness.md).
