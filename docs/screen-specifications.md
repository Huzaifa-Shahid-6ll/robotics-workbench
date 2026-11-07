---
doc_id: D44
title: Screen specifications
status: implementation-spec
updated: 2026-11-01
depends_on: [D14, D27, D32, D41, D42, D43]
requirement_ids: [REQ-UX-44]
---
# Screen specifications

## Authority and common contract

**SPECIFIED:** This document defines content, actions, and states for each user surface. Screen IDs are stable test references. It describes planned behavior, not completed implementation. D41 holds exact Refero sources R01–R12. All screens inherit D42 tokens and D47 accessibility. Each custom screen receives project ID, applicable revision/artifact IDs, capabilities, data freshness, and operation status through the validated D18 protocol. A screen MUST never infer operation success from navigation, a completed spinner, or an optimistic button state.

Every screen implements loading, empty, ready, stale, unavailable, and error presentations where applicable. Loading preserves existing content if valid, labelled refreshing. Errors show the failed action, preserved data, and a specific next action. Retry view only repeats data retrieval; repeating a mutation uses D19's operation semantics. The primary action remains visible without permanently showing every inspector. User-visible terms distinguish intended wiring, observed wiring, compiled firmware, uploaded artifact, and measured behavior.

## S01 — Main workspace

Reference R01; native host layout from D43. Contents: ordinary files, active editor, Robotics tree, optional agent view, compact board/operation status. The project header exposes project identity and current readiness summary, not a full dashboard. Code retains ordinary VS Code editing, diagnostics, save, and Git behavior. Compile and Upload Artifact are distinct actions. Board absence disables upload with an explanatory action but does not block editing or offline compilation against an installed target. Dirty buffers expose Save and compile or Cancel according to D31; never silently compile different disk contents while displaying current edits. Opening an unrelated file does not switch the hardware project.

## S02 — Agent conversation

Reference R02. Header: project, provider, session, turn state. Body: user messages, responses, expandable observable tool activity, evidence links, and task change summary. Footer: persistent composer, attachment/context chips, Send or Stop agent. The task state and device/build operation state are separate rows. An agent response can be finished while compilation is running. Preserve composer draft across view reload. Provider switching creates a visible handoff, retaining the original session. Unsupported provider features are absent or labelled unavailable; do not display invented token counts. Stop agent requests interruption and retains completed edits for review. Untrusted tool output is displayed as data; it never creates executable buttons from arbitrary strings.

## S03 — Context inspector

Reference R03. Available as an agent subview or editor tab, not a forced fourth column. Groups: Pinned, Supplied this turn, Observed retrieval, Available, and Stale/unresolved. Rows show source title, source revision/hash, location, freshness, inclusion reason, excerpt/full status, and whether token usage is estimated. Pinning is a policy, not proof the provider retained a source. Click opens the original. Refresh prepares a later turn and does not mutate the historical context record. Items excluded by budget show Excluded: budget with a reason and Open source. The inspector explicitly states that provider-managed internal context may not be observable.

## S04 — Components table

Reference R04. Default columns: component name, type/model, interface, assigned pins, power domain, physical confirmation, and issues. Stable component ID is available in details/copy. Rows can filter by type, unresolved issue, or connected board. Selecting a row opens a reversible inspector; editing requires validated forms or manifest changes with expected revision. Missing datasheet facts display Unknown rather than zero or guessed limits. Removing a component previews affected nets/code bindings and requires coherent resolution. Physical confirmation is a separately recorded observation, not a checkbox toggled by saving a row.

## S05 — Wiring overview

Reference R05, electrical semantics D35. Canvas shows components, labelled logical pins, nets, and selected connection details. Header displays Intended wiring, manifest revision, and confirmation freshness. Actions: add component, connect endpoints, inspect net, fit view, undo, open connection table. A proposed connection is validated before commit; errors identify the exact endpoints and constraint. Visual edge segments may belong to one multi-endpoint net. Moving a node changes presentation only, not electrical intent. Keyboard users can add/edit connections in the table. Code bindings are explicit links, not guessed equivalence. A generated diagram is never labelled electrically verified.

## S06 — Task change review

Reference R06. A task-scoped changed-item tree opens native text diffs or typed summaries for manifest connections, generated previews, and binary artifacts. Every row identifies baseline and current version and whether edits are proposed or already written. Proposed changes use Apply proposal/Dismiss; direct CLI edits use Keep edits/Revert edits. Interleaved user changes cause a conflict view, never a wholesale file restore. Linked code/pin changes show dependency groups. Partial acceptance that creates a mismatch is visible and blocks affected readiness claims. Source revert does not restore firmware or physical wiring. Upload Artifact remains a separate explicit operation.

## S07 — Serial and operation logs

Reference R07. Header: selected device, port observation, baud, capture status, operation ID. Body: raw/text log with bounded rendering, timestamps, filters, and expandable structured details. Footer: send control only when firmware/transport supports the requested operation; otherwise raw send is a separately explicit user action. Pause display freezes scrolling but keeps capture active; Stop recording finalizes evidence. Show dropped bytes, parse failures, gaps, and disk-full state. Release-for-upload is visible and waits for coordinator acknowledgement. Disconnect preserves captured data and marks the current segment ended/partial. No Stop control implies motors stopped.

## S08 — Run detail and plots

Reference R08. Header: run ID, recorded time, board identity, build artifact, project revision, and capture completion. Main area: named channels with units, time basis, legend, and optional notes. Configuration and raw evidence are expandable alongside plots. Range selection records recording ID, channel IDs, time basis, start/end, parser version, and revision before Ask agent. Display downsampling is disclosed; export/query can retrieve underlying data. Unsupported units or missing timestamps appear as explicit uncertainty. Historical runs stay readable when the device is absent. A run's pass/fail judgment cites its criteria and measured evidence.

## S09 — Run comparison

Reference R09. Left selection list with filters; main plots and parameter difference table. Require compatible measurement types or an explicit transformation. Default alignment is recording elapsed time; absolute/device time alignment must be selected and documented. Missing samples are gaps, not zeros. Series styling remains stable across chart interactions. Compare current source to historical firmware through visible identity fields; do not label a run current merely because its name matches. Provide table export and inspect-one-run actions. More than six series encourages isolation instead of ambiguous color reuse.

## S10 — Scripted CAD preview

Reference R10. Code remains in a native editor; preview opens beside it or in a separate tab. Preview contains artifact identity, source snapshot, generation status, orbit/pan/zoom, reset view, optional hierarchy, declared units, and export. Only supported properties are editable; do not imply a complete modeling suite. Regenerate executes the explicit CAD job and uses D37 isolation policy. On failure retain the previous preview labelled Outdated, with its actual source revision. Export operates on a selected existing artifact, not an ungenerated live script. If the viewer is unavailable, offer source/artifact paths and external viewer handoff.

## S11 — Datasheet/document viewer

Reference R11. Document navigation, source page, selected excerpt, and optional assistant. Header: file name, version/hash, page, extraction quality. Citation click resolves the original page and highlights the bounded location where available. Extracted text is auxiliary and may be incomplete; tables/images remain inspectable. Ask about selection freezes the citation and excerpt. Missing/OCR-unreadable text shows a limitation instead of fabricated content. Replacing a PDF creates a new version; old answers continue referencing the historical source. Remote links are opened deliberately and never substitute a different document silently.

## S12 — Tools and providers

Reference R12. Rows: Arduino CLI, installed target/core readiness, Codex, OpenCode, optional KiCad, Python/CAD environment, viewer/document capabilities. Each row contains detected path/version, status, last check, and Configure/Test action. Secrets never appear in rows, logs, or copied diagnostics. Authentication uses provider-supported flows. A connection test distinguishes executable found, process started, authenticated, and task capability verified. Optional tools do not block core editing. Installing/upgrading is a specific action with its scope visible, not an automatic side effect of opening this screen.

## Supporting surfaces

| ID | Surface | Required content and behavior |
|---|---|---|
| S13 | First-run walkthrough | Open existing sketch; detect tools; choose target when needed; optional agent setup. Resumable; no forced conversion or AI login. |
| S14 | Board/port picker | FQBN/board profile separate from observed port and device identity. Ambiguous identity requires explicit selection; refresh does not silently choose. |
| S15 | Upload operation detail | Exact artifact digest, build inputs summary, target, phase, logs, and cancellation consequences. Unknown outcome never becomes successful by timeout. |
| S16 | KiCad preview/handoff | Source file, origin revision, validation result, divergence status, Open in KiCad, explicit export/regenerate. Never overwrite independent edits. |
| S17 | Recovery center | Interrupted operations, retained artifacts, current observations, and operation-specific reconcile actions. No Replay all. |
| S18 | Conflict resolution | Base/current/proposed identities, affected fields, preserve-both/export options, and reviewed resolution. No destructive default. |

## Acceptance criteria and evidence

- **AC-D44-01:** Implement fixtures for every S01–S18 ready state and every applicable empty/loading/error/stale state. Capture screenshots with fixture IDs.
- **AC-D44-02:** A board disconnect leaves editor, agent transcript, and existing recordings usable; upload becomes unavailable with truthful reason.
- **AC-D44-03:** A task containing a code edit, wiring proposal, and uploaded artifact exposes three distinct review/effect states.
- **AC-D44-04:** A historical plot interval sent to an agent preserves its exact immutable selection after later recordings arrive.
- **AC-D44-05:** At 1366×768 all primary actions remain reachable using one content surface plus optional agent; no mandatory four-column layout.
- **AC-D44-06:** Source/provider/hardware errors cannot generate success badges merely through frontend state reset.

Sources: the twelve [approved Refero references](design-reference-ledger.md), [official VS Code UX](https://code.visualstudio.com/api/ux-guidelines/overview), [webview guidance](https://code.visualstudio.com/api/extension-guides/webview), accessed 2026-11-01. Related: [D45](component-and-interaction-contracts.md), [D46](journeys-states-and-recovery.md), [D47](accessibility-responsive-layout-and-motion.md). Actual render and hardware checks remain **VALIDATION-GATE**.
