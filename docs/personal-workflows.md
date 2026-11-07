---
doc_id: D05
title: "Personal workflows"
status: implementation-spec
updated: 2026-11-01
depends_on: [D03, D04]
requirement_ids: [REQ-PROD-01, REQ-PROD-03, REQ-PROD-04]
---

# Personal workflows

## Purpose and authority

**SPECIFIED:** These journeys define the user-visible work the complete release must support. They are acceptance scenarios, not a claim that the extension already exists. D46 owns detailed UI state transitions; this document owns task intent, evidence, and outcome. Use a small Uno project as the reference fixture, without assuming every project has the same sensor or pin map.

## J01 — Open and preserve an existing sketch

Entry: local folder with a conventional sketch and an existing Arduino environment. The user opens the folder, invokes Robotics setup, and sees detected dependencies and target options. The application reads effective paths and configuration before offering changes. It does not relocate source, upgrade cores, rewrite includes, or install a proprietary runtime.

The user selects an FQBN when required. Before baseline compilation, dirty documents are identified; the user saves the intended inputs or the operation stops with an actionable reason. The resulting record identifies source snapshot, CLI/core/library inputs, build options, artifact hash, and diagnostics. A failed baseline remains useful evidence.

Exit: project can be reopened in Arduino IDE; the optional manifest references the existing layout. Missing libraries produce exact repair guidance and no unrelated upgrade.

## J02 — Ask an agent to change firmware

Entry: imported project, selected provider, and selected code or component. The context inspector shows available, pinned, supplied, retrieved, and stale information separately. The agent receives the explicit task, selection identity, revision, relevant constraints, and bounded retrieval tools.

The provider may propose edits or write directly through its own supported workflow. The UI distinguishes unapplied proposals from already-written changes. The user can inspect native diffs. If the user edits the same file concurrently, revision/document checks prevent blind acceptance or revert. Compilation is a separate observable operation; the assistant's “done” message cannot mark it succeeded.

Exit: reviewed source and linked validation receipt. Upload remains a separate action with target and artifact identity.

## J03 — Diagnose a sensor from recorded evidence

Entry: selected component with intended wiring and a recent serial capture. The view shows whether the latest build is the last uploaded build and whether physical wiring confirmation applies to the current design. A connection diagram is not evidence that wires are connected.

The user selects a plot interval or raw log window. The application freezes recording ID, channel set, time basis, start/end range, parser version, and gaps. The agent retrieves exact source excerpts and relevant datasheet pages, then proposes an explanation and a scoped bench procedure. Observations such as voltage readings are user-entered with time, units, procedure, and revision applicability.

Exit: explanation cites evidence; any physical pass/fail judgment records the test procedure and criteria. Missing measurements remain unknown.

## J04 — Change wiring and reconcile code

Entry: a component needs a different pin or interface. The user edits the connection table/canvas. A semantic change increments projectRevision and invalidates affected confirmations and derived exports. Moving a node changes presentation only and MUST NOT alter electrical nets.

The application identifies explicit code bindings and proposes related edits; it does not silently infer every numeric literal is a pin. Conflicting peripheral aliases or unsupported voltage assumptions are surfaced with their source and certainty. The user reviews code changes, performs physical rewiring, and explicitly records new confirmation. Compilation/upload/testing then create new evidence.

Exit: current design, source, uploaded artifact, and observations are distinguishable and linked. Undoing the manifest does not claim to move physical wires or restore firmware.

## J05 — Generate a schematic or simple mechanical part

Entry: project design intent or a CAD Python script. Generation is staged with originating revision, tool version, parameters, and output hashes. KiCad validation/export and CAD preview/export use supported tool paths. The user can open outputs in the native application.

If a schematic changes externally, the workbench marks divergence and offers an explicit new export or reviewed reconciliation. It never regenerates over independently edited native work. A CAD error preserves source and the last successful artifact with a stale label rather than displaying it as newly generated.

Exit: ordinary files and traceable generation records, with the native application still usable independently.

## J06 — Recover and continue

Entry: board unplug, provider crash, service interruption, disk full, or app restart. Persisted operations are reconciled against available evidence. An upload interrupted at an uncertain point becomes outcome-unknown; it is not retried automatically. Serial capture shows gaps and incomplete termination. A second provider receives application-owned facts and unfinished work, not a fabricated copy of private provider state.

Exit: user sees what is known, what failed, and the smallest valid next action. Backup/restore retains project files and selected evidence while excluding credentials.

## Acceptance criteria

- **AC-D05-01:** J01 leaves the original sketch layout and unrelated dependencies unchanged.
- **AC-D05-02:** J02 concurrent-edit fixture preserves both versions and requires reconciliation.
- **AC-D05-03:** J03 explanation can be traced to a specific raw recording window and source revision.
- **AC-D05-04:** J04 distinguishes planned, physically confirmed, compiled, and uploaded states.
- **AC-D05-05:** J05 external edit is detected before any overwrite.
- **AC-D05-06:** J06 restart does not replay hardware mutations and does not turn incomplete observations into passes.

## Sources and related documents

**RESEARCH-RECORDED:** User-approved workflows and prior research informed these scenarios. External anchors: [Arduino sketch specification](https://docs.arduino.cc/arduino-cli/sketch-specification/), [VS Code custom editors](https://code.visualstudio.com/api/extension-guides/custom-editors). Implementations must validate installed versions.

Related: [requirements](requirements-and-acceptance.md), [journey states](journeys-states-and-recovery.md), [hardware tests](hardware-testing-and-debugging.md).
