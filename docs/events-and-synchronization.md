---
doc_id: D17
title: "Events and synchronization"
status: implementation-spec
updated: 2026-11-01
depends_on: [D14, D16, D18]
requirement_ids: [REQ-ARCH-01, REQ-ARCH-02]
---

# Events and synchronization

## Authority

**SPECIFIED:** This document owns event semantics, freshness, and synchronization across host documents, companion, views, and agent context. It does not make events a second authority. Current state is read from its owner; events tell consumers what changed. Envelope shape is defined in [D18](internal-api-and-webview-protocol.md).

Use a persisted companion event sequence monotonically increasing within one database lifetime. `eventId` is a UUID and `sequence` is an integer. A restored/recreated database creates a new connection epoch communicated during handshake so consumers never compare sequence numbers from unrelated histories. Events may be delivered more than once; consumers must deduplicate. Do not promise exactly-once network delivery.

## Event classes

| Type | Owner and payload intent | Consumer action |
|---|---|---|
| `project.changed` | Accepted revision and semantic change summary | Invalidate dependent context and fetch affected objects |
| `source.changed` | Host/file observation with paths and buffer/snapshot identity | Mark build diagnostics and upload applicability stale as needed |
| `operation.changed` | Persisted operation receipt/status | Update one operation; never infer success from queue acceptance |
| `device.changed` | Observed coordinator/device state | Update readiness and disable invalid actions |
| `recording.updated` | Bounded capture counters/artifact progress | Refresh plots through bounded windows |
| `context.invalidated` | Context bundle IDs and reason | Mark supplied snapshot stale; preserve historical record |
| `selection.changed` | User selection and view origin | Cross-select related information; no physical mutation |

High-volume serial bytes are not broadcast as one event per byte. Persist raw data through capture storage and publish bounded progress/channel windows. Rendering may coalesce progress updates; durable operation transitions may not be dropped from history. A slow view must not backpressure physical capture indefinitely.

## Revisions and preconditions

`projectRevision` refers only to accepted manifest/design meaning. Source edit freshness is represented separately using document versions/content hashes and sourceSnapshotId. A graph drag in layout metadata does not imply rewiring. An uploaded binary remains associated with its original source snapshot after later edits.

Every design mutation includes expectedProjectRevision and an authoritative content precondition where direct external edits could bypass revision increments. A mismatch returns `REVISION_CONFLICT`, with current revision and refresh guidance. Do not merge electrical net changes automatically based on last-writer-wins. A retry uses a newly reviewed request rather than reusing stale intent under a different revision.

Watchers are hints. Before build, upload, manifest mutation, export, or evidence judgment, reread/revalidate the required authority. Filesystem events can coalesce or disappear. If a file changes while it is being hashed, restart snapshot creation or fail with an unstable-source error; never assemble an inventory from inconsistent reads and label it immutable.

## Snapshot and subscription handshake

1. Consumer opens an authenticated connection and sends its last known epoch/sequence if any.
2. Companion returns current capabilities and an epoch.
3. Consumer requests a project snapshot with `snapshotSequence` watermark.
4. Consumer subscribes/replays events after that watermark. Companion buffers or replays retained events so none are lost between read and subscribe.
5. If history is unavailable or epoch differs, consumer discards derived state and requests a full snapshot.
6. Duplicate eventId is ignored; a sequence gap triggers replay or full refresh.

For the first implementation, a combined subscribe-and-snapshot method is acceptable and simpler than independently timed calls. Its contract must guarantee an explicit watermark and buffering. Browser/host reconnection must not resubmit old mutations merely because their original response was lost; query by requestId/operationId.

## Cross-selection

Selection is transient UI state, not persistent physical truth. A selection contains object kind, stable ID, projectId, applicable revision, originViewId, and optional plot interval with recording/time basis. A view ignores its own echoed selection and resolves referenced objects against current state. Missing objects show “selection no longer exists” rather than selecting a same-named replacement.

When the user asks “explain this,” freeze the selected object's identity and revision into the turn context. Later selections do not silently change the referent of an in-flight turn. Context inspector categories must distinguish available, pinned, supplied-this-turn, observed retrieval, and stale; application events cannot expose all provider-internal context.

## Failure behavior

Companion disconnect shows stale/read-only derived views. It does not erase the last known state or pretend it is live. Invalid manifest retains a visibly stale projection with edits disabled. Event queue overflow triggers a resync marker and bounded recovery, not unlimited memory growth. Client clocks are not used to order authoritative operations; sequence and receipt relationships govern ordering.

## Acceptance criteria

- **AC-D17-01:** Duplicated and reordered delivery cannot create duplicate operations or regress a terminal receipt.
- **AC-D17-02:** A lost sequence produces replay or snapshot refresh, with no silent view divergence.
- **AC-D17-03:** A manifest edit during an agent turn marks the relevant supplied context stale.
- **AC-D17-04:** A selection change during a turn preserves the original turn referent.
- **AC-D17-05:** Missed filesystem watcher events are detected by preflight revalidation before compile/upload.

## Sources and related documents

These event semantics are SPECIFIED app contracts informed by the project-state research. RESEARCH-RECORDED: [VS Code document APIs](https://code.visualstudio.com/api/references/vscode-api), [custom editor synchronization](https://code.visualstudio.com/api/extension-guides/custom-editors), [SQLite transactions](https://sqlite.org/lang_transaction.html). Read D26–D28 for agent context semantics and D33 for telemetry throughput limits.
