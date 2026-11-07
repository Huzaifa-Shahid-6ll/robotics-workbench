---
doc_id: D50
title: Implementation plan and task packets
status: implementation-spec
updated: 2026-11-01
depends_on: [D01, D02, D04, D08, D10, D11, D48, D49]
requirement_ids: [REQ-ARCH-50]
---

# Implementation plan and task packets

## Authority and execution model

**SPECIFIED:** This document owns implementation order and agent handoff structure. It does not override subsystem contracts. The task starts with documentation, not a runnable application. Before reporting any command as passing, the coding agent MUST establish that the command and tested implementation exist. [D10](unknowns-and-validation-spikes.md) owns unresolved integration questions; [D48](testing-and-requirement-traceability.md) owns evidence standards.

Use one integration owner and bounded implementation agents. Parallelize disjoint modules only after their interfaces stabilize. Each task runs in an isolated branch/worktree when a repository exists. Do not let separate agents redefine project IDs, operation states, provider events, or device ownership. Merge contract changes first; dependent agents then update implementations. Documentation authoring parallelism does not imply that all implementation tasks should run simultaneously.

**REQ-ARCH-50:** Implementation MUST follow dependency-ordered task packets with bounded ownership and evidence-backed completion.

## Task packet schema

Every implementation assignment MUST contain the following fields, preferably as a Markdown file with YAML frontmatter. This is a proposed format, not an existing scheduler API.

```yaml
task_id: TASK-04
title: Build and upload exact artifacts
status: blocked
depends_on: [TASK-01, TASK-02, TASK-03]
read: [D15, D19, D21, D26, D31, D32, D33, D40]
write_scope: [packages/adapters/arduino, packages/devices]
contract_inputs: [D19 operation lifecycle, D31 build identity]
outputs: [implementation, fixtures, tests, evidence]
acceptance: [AC-D31-01, AC-D32-05, AC-D32-06]
release_gate: G2
prerequisite_gates: [VG-05]
validation_gates: [VG-06, VG-14]
stop_conditions: [unresolved-device-identity, unsupported-cli-version]
```

The normative [task index](../tasks/task-index.json) supplies exact read sets, D12 write scopes, acceptance IDs, release gates, validation gates, and exclusions for all thirteen packets. Its [schema](../contracts/task-packet.schema.json) is machine-readable. Paths are implementation-repository targets; their absence from this documentation-only pack is intentional. The index owns task fields if this prose summary is shorter. Task statuses are `blocked`, `ready`, `in-progress`, `review`, and `done`; they are not operation statuses. `done` requires evidence and review, not merely generated code. Each packet includes explicit exclusions, integration instructions, source/version assumptions, failure cases, and a short handoff stating what changed and what remains unverified. TASK-00 and TASK-01 initially are ready; downstream packets are blocked only by their listed task dependencies and prerequisite gates. `prerequisite_gates` must have passing evidence before dependent effectful work starts. `validation_gates` are probes this task performs or evidence it produces before its release claim is accepted; they are not start prerequisites. A task may implement and test independently while its live validation remains pending, but its release claim remains blocked. TASK-01 has no dependency on all of TASK-00: scaffolding does not require provider login, an attached board, or completion of native-module probes. A failed compatibility probe blocks only dependent claims, and independent scaffold/fake-adapter work continues. VG-04 is conditional on selecting a WSL workaround after a native provider failure; otherwise it remains not-run and WSL support remains excluded.

## Release-gate mapping

| Release gate from D04 | Tasks |
|---|---|
| G0 compatibility | TASK-00 |
| G1 shared core | TASK-01, TASK-02, TASK-03 |
| G2 useful Arduino loop | TASK-04 |
| G3 unified agents | TASK-05, TASK-06 |
| G4 connected design | TASK-07 |
| G5 engineering evidence | TASK-08, TASK-09, TASK-10 |
| G6 personal release | TASK-11, TASK-12 |

## Ordered packets

| ID | Prerequisites; read set | Outputs and bounded scope | Exit evidence |
|---|---|---|---|
| TASK-00 Baseline and compatibility | None; D01–D10, D23–D25, D31, D49 | Inventory actual OS/editor/tools; small VSIX; minimal provider probes; record exact tested versions | Both supported provider paths identified; existing sketch baseline compiled; runtime/native-module strategy chosen or narrow blocker recorded |
| TASK-01 Repository and host shell | No task dependency; share findings with TASK-00; D11–D13, D20, D43, D49 | Extension/service/webview build skeleton; command registration; disposal; isolated test host | Packaged activation/deactivation works; no leaked process; untrusted workspace cannot trigger mutations |
| TASK-02 Domain contracts and persistence | TASK-01; D14–D18 | Manifest schema, stable IDs, snapshots, SQLite operational records, artifact store, message validation | Schema/fixture tests; stale mutation rejection; crash between file write/database update reconciles truthfully |
| TASK-03 Process and device coordinator | TASK-02; D19–D20, D32–D33 | Jobs, leases, process cancellation, fake device transport, single-owner enforcement | Monitor/upload exclusivity; second owner refused; interrupted external effects become `outcome-unknown` |
| TASK-04 Arduino vertical slice | TASK-03; D15, D31–D33, D40 | Existing sketch import, diagnostics, compile, exact-artifact upload, raw serial recording, plus one existing provider IDE/terminal surface supplied a bounded application snapshot | Real Uno receives identified artifact; monitor returns; failed compile never uploads stale binary |
| TASK-05 Agent adapters and domain tools | TASK-02, TASK-04; D21–D30 | Codex adapter, OpenCode adapter, robotics tools, bounded context and task handoff | Each provider completes the same recorded debugging task; duplicate events cannot duplicate mutations; unsupported capabilities visible |
| TASK-06 Unified agent/context/review UI | TASK-05; D26–D28, D41–D47 | Shared panel, context inspector, native diff integration, cancellation/reconnect | Dirty-buffer conflicts preserve both versions; context shows provenance/staleness; source acceptance does not upload |
| TASK-07 Components and wiring | TASK-02; D34–D35, D41–D47 | Component catalog, connections table, code bindings, then canvas and cross-selection | Pin conflict tests; changing nets invalidates relevant confirmation; layout-only movement does not change circuit intent |
| TASK-08 Documents and diagnostics | TASK-02; D31, D38, D43–D46 | Arduino language-service integration, source-linked PDF/text retrieval, citation navigation | Multi-file sketch diagnostics correct; retrieved content has page/version; malicious document instructions cannot authorize actions |
| TASK-09 Telemetry and experiments | TASK-04; D33, D39–D40, D44–D47 | Versioned parsers, plots, interval selection, runs and comparison | Raw evidence retained; gaps visible; selected interval sent as exact recording/channel/time references |
| TASK-10 KiCad and CAD handoff | TASK-02, TASK-07; D36–D37, D44–D46 | Version-gated schematic output/check/preview; Python CAD generation and existing viewer handoff | Native files open independently; external KiCad edits preserved; model/export tied to script and parameter digest |
| TASK-11 Recovery and complete journeys | TASK-06–TASK-10; D05–D07, D40, D46, D48 | Failure drills, backup/restore, cross-view integration, performance and accessibility fixes | All complete personal workflows pass in one persistent project; simulated versus real evidence distinguished |
| TASK-12 Personal release | TASK-11; D09, D48–D49 | Inspected VSIX, version matrix, checksums, release evidence, installation/troubleshooting instructions | Clean-profile install on actual PC; update/rollback drill; no mandatory requirement remains only mocked |

At G2, the single-provider experience may use its existing supported IDE/terminal UI; TASK-04 exposes the bounded application snapshot needed for that path. TASK-05 replaces this interim seam with both normalized adapters, and TASK-06 completes the shared panel.

TASK-00's minimal provider probes verify protocol/auth feasibility without implementing the full unified panel. Its baseline upload, when performed, is an explicitly observed compatibility experiment using the unchanged toolchain; it does not substitute for the coordinator-controlled path in TASK-04. If user hardware or accounts are unavailable, leave that gate blocked and continue independent tasks rather than fabricate results.

## Parallelism and shared ownership

After TASK-02, wiring and document work may proceed alongside the device path. After TASK-04, telemetry work can proceed alongside agent UI. KiCad and CAD may be implemented independently behind their artifact contracts. No parallel task may mutate a shared physical device. A project-wide contract change requires the integration owner to identify affected tasks, update schemas and fixtures, and rerun affected tests before merging consumers.

Start with native host features and simple tables, then add visual affordances. Raw serial evidence precedes plots; connection records precede node-canvas polish; native CAD/EDA handoff precedes a specialized editor. These sequences reduce rework without removing features from the complete scope. Temporary existing-provider UI may support early experiments; the selected shared panel remains a complete-release requirement.

## Agent completion and review

A handoff MUST state task ID, changed paths, implemented contract versions, commands actually run, exit codes, evidence locations, known limitations, and proposed follow-up tasks. The reviewer checks acceptance assertions rather than trusting the author's summary. Missing provider access, hardware, dependencies, or a usable API is a blocker with a smallest next experiment—not a reason to invent a mock implementation and label it complete.

If a task discovers a conflict between specifications, stop only the dependent work, preserve a minimal reproducer, and send the conflicting document IDs to the integration owner. Independent tests and documentation may continue. Do not silently choose whichever contract is easier to implement. User input is reserved for genuine preference/scope decisions or unavailable physical facts; routine coding decisions follow [AGENTS.md](../AGENTS.md).

## Acceptance criteria

- **AC-D50-01:** Every task has a bounded read set, ownership, dependencies, outputs and observable exit evidence.
- **AC-D50-02:** A task cannot perform work that depends on an unresolved prerequisite gate; a probe task can start to resolve its own validation gates, and scaffolding remains possible without accounts or hardware.
- **AC-D50-03:** The first useful Arduino slice is explicitly distinct from the complete personal release.
- **AC-D50-04:** Final evidence covers both providers, common panel, wiring, recordings, KiCad, CAD, recovery and packaged installation.
- **AC-D50-05:** Task handoffs distinguish implemented, tested, simulated, physically observed and blocked work.

## Sources and related documents

- RESEARCH-RECORDED: Prior research tracks 48–49, 2026-10-31, dependency ordering and critical integration risks.
- SOURCE-VERIFIED supporting delivery methods: [VS Code testing](https://code.visualstudio.com/api/working-with-extensions/testing-extension) and [private packaging](https://code.visualstudio.com/api/working-with-extensions/publishing-extension), retrieved through Context7 2026-11-01.
- [D04 release scope](scope-and-release-boundaries.md); [D10 unknowns](unknowns-and-validation-spikes.md); [D48 evidence](testing-and-requirement-traceability.md); [D49 release](packaging-release-and-maintenance.md).
