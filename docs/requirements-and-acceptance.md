---
doc_id: D06
title: "Requirements and acceptance"
status: implementation-spec
updated: 2026-11-01
depends_on: [D03, D04, D05]
requirement_ids: [REQ-PROD-01, REQ-ARCH-01, REQ-AGENT-01, REQ-HW-01, REQ-UX-01]
---

# Requirements and acceptance

## Purpose and authority

**SPECIFIED:** This is the authoritative catalog for core requirement IDs. Detailed documents may introduce additional uniquely namespaced requirements, but MUST NOT redefine these IDs. D48 owns executable test mapping and evidence records. Passing a specification lint check is not passing a product requirement.

A requirement is satisfied only when its behavior has passed the appropriate test against the implementation and its evidence identifies the tested build/environment. Manual hardware observations and automated fake-adapter tests are separately labeled. Not-run and blocked are valid reporting states; they are not passes.

## Core requirements

| ID | Required behavior | Primary specification | Observable acceptance |
|---|---|---|---|
| REQ-PROD-01 | Preserve ordinary Arduino projects | D15 | Existing sketch opens/builds externally without conversion |
| REQ-PROD-02 | Share application-owned facts across both providers | D22–D28 | Equivalent revision-stamped snapshot supplied to either provider |
| REQ-PROD-03 | Cross-select engineering objects | D43–D46 | Component/interval selection resolves the same stable object in agent context |
| REQ-PROD-04 | Separate design, compiler, uploader, and physical claims | D27,D39,D40 | Mismatch fixture displays each truth independently |
| REQ-PROD-05 | Preserve external file usability | D15,D36,D37 | Exported native artifacts open in independent tools |
| REQ-PROD-06 | Complete the full personal workflow | D04,D05 | All release journeys pass, including KiCad/CAD and both providers |
| REQ-ARCH-01 | Keep one authority for each data kind | D14–D17 | Reindex reconstructs derived state without changing authoritative files |
| REQ-ARCH-02 | Version and validate process/UI messages | D18 | Unknown or malformed request rejected without side effects |
| REQ-ARCH-03 | Persist truthful operation lifecycle | D19 | Crash reconciliation retains failed/unknown outcomes |
| REQ-ARCH-04 | Enforce coordinated device ownership | D19,D32 | Concurrent upload/monitor attempts do not open competing workbench handles |
| REQ-ARCH-05 | Scope credentials and local access | D20 | Logs/exports omit secrets; unauthorized local requests fail |
| REQ-ARCH-06 | Preserve user edits under external writes | D13,D15 | Dirty-buffer conflict test loses neither version |
| REQ-AGENT-01 | Integrate Codex through supported adapter | D23 | Handshake, turn, observable event, cancel/reconnect fixtures pass |
| REQ-AGENT-02 | Integrate OpenCode through supported adapter | D24 | Same capability-based contract tests pass |
| REQ-AGENT-03 | Supply bounded relevant context | D26 | Request has explicit scope and expansion handles; no unbounded log dump |
| REQ-AGENT-04 | Preserve source provenance and freshness | D27 | Stale pin/document/build evidence is labeled and retrievable |
| REQ-AGENT-05 | Retain recoverable app-owned task memory | D28 | Provider switch preserves decisions/evidence without claiming hidden history |
| REQ-AGENT-06 | Keep tool effects separate from agent assertions | D21,D29,D30 | Text claiming upload success cannot create a successful upload receipt |
| REQ-HW-01 | Record complete reproducible build identity | D31 | Local-library change invalidates prior build currency |
| REQ-HW-02 | Upload the selected exact artifact to selected target | D32 | Receipt includes matching digest, FQBN/options, target and uploader result |
| REQ-HW-03 | Preserve raw serial evidence and capture gaps | D33 | Parser/plot changes do not alter raw bytes; dropped data is explicit |
| REQ-HW-04 | Model stable components, pins and nets | D34,D35 | Pin aliases resolve consistently; duplicate-resource conflicts are detected |
| REQ-HW-05 | Preserve independent KiCad edits | D36 | Divergent native file is never overwritten automatically |
| REQ-HW-06 | Link CAD source, parameters and outputs | D37 | Stale preview remains distinguishable from latest successful generation |
| REQ-HW-07 | Cite documents and scoped experiment evidence | D38,D39 | Answer/test links exact page or recording interval and applicable revision |
| REQ-HW-08 | Require actual observations for hardware verification | D40 | Compiler/mock success never marks a physical test passed |
| REQ-UX-01 | Respect native host theme and structure | D42,D43 | Light/dark/high-contrast checks pass without inaccessible hard-coded chrome |
| REQ-UX-02 | Explain context actually available to the application | D44 | Inspector never claims to expose provider-hidden context/reasoning |
| REQ-UX-03 | Distinguish proposed versus already-applied changes | D44,D45 | Apply/Dismiss and Keep/Revert are used for correct edit states |
| REQ-UX-04 | Provide specific recovery actions | D46 | Missing tool/busy port/disk-full fixture presents valid next action |
| REQ-UX-05 | Work with keyboard and constrained display | D47 | Core journeys usable at 1366×768 and with keyboard-only navigation |
| REQ-UX-06 | Install, restore and uninstall without data loss | D49 | Packaged restore retains evidence; uninstall preserves user projects |

## Requirement interpretation

“MUST” is a release obligation within its gate. “SHOULD” admits a documented exception with justification and tests. “MAY” is optional. Product-selected behavior is marked SPECIFIED; external APIs require versioned evidence. No test substitutes a UI label for actual state.

Build identity includes source snapshot, board/FQBN/options, CLI/core/compiler/library identity, effective build parameters, and binary digest. Physical device identity is separate from a transient COM-port string. projectRevision covers manifest design intent and is not a source document version.

## Evidence and change control

Each test record MUST contain requirement IDs, acceptance criterion IDs, application revision, fixture identity, environment/tool versions, procedure, expected/observed outcome, artifacts, and result (`passed`, `failed`, `blocked`, or `not-run`). Hardware records additionally identify board, connection circumstances, and measurement procedure. A newer code change invalidates tests whose relevant behavior changed.

When a requirement changes, retain its ID if meaning remains compatible; otherwise deprecate it with a replacement link. Update task packets and tests in the same change. Never quietly weaken an acceptance criterion to match an implementation bug.

## Acceptance criteria

- **AC-D06-01:** Every core row maps to at least one D48 test and at least one implementing task before G6.
- **AC-D06-02:** A report with mocked upload success cannot satisfy REQ-HW-02's real-device release check.
- **AC-D06-03:** Evidence distinguishes blocked/not-run from passed and records tested versions.
- **AC-D06-04:** A changed requirement triggers an explicit traceability update, not duplicated conflicting prose.

## Sources and related documents

This catalog is a project contract derived from the approved product direction. **RESEARCH-RECORDED** external anchors: [VS Code API](https://code.visualstudio.com/api/references/vscode-api), [Arduino CLI compile](https://docs.arduino.cc/arduino-cli/commands-reference/arduino-cli_compile/).

Related: [workflows](personal-workflows.md), [traceability](testing-and-requirement-traceability.md), [task packets](implementation-plan-and-task-packets.md).
