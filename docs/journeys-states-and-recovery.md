---
doc_id: D46
title: Journeys states and recovery
status: implementation-spec
updated: 2026-11-01
depends_on: [D19, D21, D32, D43, D44]
requirement_ids: [REQ-UX-46]
---
# Journeys, states, and recovery

## Purpose and authority

**SPECIFIED:** This document owns end-to-end user-visible transitions. D19 owns job execution; D32 owns physical device coordination. UI copy MUST reflect their confirmed states. Operation statuses are exactly `queued`, `running`, `awaiting-input`, `succeeded`, `failed`, `cancelled`, and `outcome-unknown`. Presentation labels may be friendly, but must preserve meaning. State changes are observed events, not elapsed timers.

No journey requires changing ordinary Arduino firmware to use the editor. Instrumented serial formats and robot-control commands are optional capabilities. Clicking Stop agent, stopping recording, or closing a port MUST NOT imply that hardware has stopped moving.

## J01 — Open an existing sketch and establish baseline

1. User opens an existing folder or selects a sketch. Detect project/sketch structure without moving files or converting formats.
2. Display readiness: source opened, toolchain detected/missing, target selected/unselected, optional provider available/unavailable. Editing is immediately available.
3. User selects the compiler target when needed. Board/core configuration is separate from current USB connection.
4. Compile a saved source snapshot after resolving dirty buffers through the build contract. Record the baseline result and full build inputs.
5. If libraries or cores are missing, show exact missing dependencies and a deliberate install/configure action. Do not upgrade unrelated packages.
6. Create project metadata only through a visible action or documented import step. Preserve the original project outside the workbench.

Exit: an identified project with either a successful baseline build or actionable diagnostics. An upload is not required to finish onboarding. Historic walkthrough completion and live readiness remain separate.

## J02 — Ask, edit, review, compile, upload, inspect

| Step | User-visible action | Required evidence/state |
|---|---|---|
| Select task | Choose component/code and describe change | Revision-bound context and explicit project |
| Agent works | Observe activity; continue editing where safe | Observable tools, operation IDs, retained baseline |
| Review | Apply/dismiss proposals or keep/revert written changes | Correct effect state and conflict checks |
| Compile | Compile selected source state | Immutable source snapshot and build receipt |
| Target | Choose observed device and build artifact | Device identity, FQBN, artifact digest |
| Upload | Start exact-artifact operation | Port released, exclusive owner, truthful phase |
| Inspect | Open capture or run detail | Actual upload result, raw recording, applicable test criteria |

An answer saying “done” does not advance the upload state. A successful compile does not mark the board current. A successful uploader result is evidence about upload, not proof of robot behavior. Final task summary separates source changes, build result, firmware operation, unresolved wiring, and measured observations.

## J03 — Change wiring coherently

Select an endpoint or component, propose connection changes, inspect affected code bindings and tests, then commit a validated manifest revision. The table and canvas update from the same committed data. Physical confirmations tied to the old design become stale. The user can record a new observation or confirmation with provenance after actual rewiring. Code changes remain reviewable separately. Generated KiCad output records its origin revision; independent native edits create divergence requiring reviewed reconciliation. Undoing design intent never claims to move wires back.

## J04 — Record and compare an experiment

Choose a named test/procedure and applicable build/device. Start recording with explicit channels/parser/time basis. Show live capture independently of plot scrolling. Stop recording finalizes available raw evidence, gaps, and configuration. Add a judgment only against declared criteria. Compare with another run using visible differences and compatible units/time basis. Ask agent about a frozen interval; subsequent data cannot shift that interval. An interrupted recording is retained as partial, not discarded or labelled a passed test.

## J05 — Provider switch or restart

When switching providers, preserve the old session and prepare an application-owned handoff containing goal, accepted decisions, current revision, evidence links, unfinished work, and unknowns. Display what is supplied. The new provider uses its supported session mechanism. Do not claim hidden reasoning or provider-private memory migrated. On process failure, expose reconnect/resume capabilities truthfully; if unsupported, offer a new session with handoff. Authentication failure does not close source or hardware inspection views.

## Interruption matrix

| Request | Immediate label | Terminal interpretation |
|---|---|---|
| Stop agent | Stopping agent | Stops scheduling as supported; completed edits remain |
| Cancel queued upload | Cancelling queued upload | `cancelled` only if upload never started |
| Interrupt active upload | Interrupting upload | `outcome-unknown` unless adapter proves final outcome |
| Cancel build | Cancelling build | `cancelled` after process-tree termination; partial output unusable |
| Pause plot | Display paused; recording active | No capture-state transition |
| Stop capture | Finalizing recording | Saved complete/partial recording or explicit save failure |
| Close view | View closed | Operation continues or remains recoverable by ID |

## Crash and reconnect recovery

On restart, reconstruct durable records and reconcile previously active jobs. Never replay uploads or device commands automatically. Reconcile exact recorded artifact, process outcome, observed device, and retained logs. A reappearing COM port is not sufficient proof of the same physical device. If identity is ambiguous, require a focused target selection. Keep latest known facts with their timestamp and stale/unknown label.

Recovery UI offers operation-specific actions: Inspect log, Select target, Compile current source, Start new capture, Resume provider session, or Review retained edits. Read-only refresh can retry automatically with bounded backoff; mutations require their declared repetition semantics. A generic Retry button MUST NOT be attached to an uncertain hardware effect. Source revert, firmware restoration, and physical rewiring are separate named operations.

## Acceptance criteria and references

- **AC-D46-01:** Complete J01 offline with installed tools and no provider login or attached board.
- **AC-D46-02:** Execute J02 using fake adapters, then the real-board gate; report those evidence classes separately.
- **AC-D46-03:** Crash during upload; restart shows unknown outcome and does not replay it.
- **AC-D46-04:** Disconnect during capture; retain partial raw data and an explicit gap.
- **AC-D46-05:** Switch provider after a wiring edit; preserve stale physical confirmation in the handoff.
- **AC-D46-06:** Concurrent user edits survive rejected/reverted agent work.

Sources: approved [Refero patterns](design-reference-ledger.md); **RESEARCH-RECORDED** prior recovery research; [VS Code notifications](https://code.visualstudio.com/api/ux-guidelines/notifications) for host patterns. Detailed product state machines above are specified choices. Related: [jobs](jobs-and-process-supervision.md), [device workflow](device-discovery-and-upload.md), [screen specifications](screen-specifications.md).
