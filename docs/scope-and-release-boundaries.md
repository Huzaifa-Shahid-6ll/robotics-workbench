---
doc_id: D04
title: "Scope and release boundaries"
status: implementation-spec
updated: 2026-11-01
depends_on: [D03]
requirement_ids: [REQ-PROD-06]
---

# Scope and release boundaries

## Purpose and authority

**SPECIFIED:** This document prevents an early useful prototype from being mislabeled as the complete personal workbench. It owns milestone exit criteria and exclusions. D50 decomposes these milestones into tasks; it MUST NOT remove capabilities from the complete release without recording a product decision.

## Release model

There is one intended complete personal release, reached through incremental gates. Gates describe evidence, not calendar promises. Development may proceed in parallel only after relevant contracts are stable. An untested integration is not ready merely because it has a UI.

| Gate | Deliverable | Required exit evidence |
|---|---|---|
| G0 compatibility | Small packaged extension plus read-only tool doctor | Actual Windows/VS Code/runtime paths and versions recorded; installed CLI can compile the fixture; both provider handshakes assessed |
| G1 shared core | Manifest, operation records, artifact identity, device coordinator | Revision conflict tests; persistence/reconciliation tests; second-owner refusal; no automatic upload replay |
| G2 useful Arduino loop | Import, diagnostics, build, upload, serial capture, one provider | Existing sketch remains ordinary; exact artifact upload and serial release/reconnect tested on Uno |
| G3 unified agents | Both adapters, shared conversation/context/review UI, handoff | Same app-owned task facts available to either provider; interrupt/reconnect and edit-conflict tests pass |
| G4 connected design | Components, connection table, canvas, code/document links | Cross-selection works; semantic pin changes invalidate relevant confirmation; layout changes do not alter net meaning |
| G5 engineering evidence | Document retrieval, recordings/comparison, KiCad handoff, CAD preview/export | Artifacts open independently; version/source provenance retained; native edits do not get overwritten |
| G6 personal release | Packaged installation, recovery, accessibility, backup/restore | All D05 journeys and D48 release tests pass on the actual machine; limitations are explicit |

G2 is usable but incomplete. Existing provider extensions/terminals may be used during G0–G2. Their availability does not substitute for the common agent surface required by G3 and the user's accepted UI direction.

## In scope for the complete release

The extension MUST support native editor/Problems integration, ordinary Arduino projects, one explicit board target per operation, stable component/pin/net identities, local tool operations, raw serial evidence, bounded agent retrieval, and ordinary project exports. Codex and OpenCode MUST each be usable through one documented integration path; no direct raw-model agent harness is required.

The electronics feature MUST distinguish a connection plan from a validated schematic and from physical wiring. KiCad integration may use explicit generation/export, validation, preview, and external editor handoff. It MUST NOT promise lossless automatic round-trip synchronization. CAD integration may reuse CadQuery and an existing viewer; a new 3D editor is not required.

The serial/experiment feature MUST preserve raw evidence and parser/version metadata. Display downsampling is permitted; quietly deleting evidence to improve chart speed is not. The complete release includes recovery from provider failure, service restart, board disconnection, and disk-write failure.

## Out of scope and permitted seams

Advanced simulation, full PCB routing, custom compiler/toolchain, fleet control, cloud collaboration, marketplace billing, dedicated desktop IDE distribution, custom model training, general autonomous physical operation, and ROS orchestration are excluded. Interfaces may leave room for later adapters, but speculative framework code MUST NOT be implemented solely for hypothetical future requirements.

Remote SSH/WSL workspace operation is not initially supported for hardware actions. A provider compatibility workaround may use a separately tested WSL boundary, but it must preserve Windows USB ownership and explicit path mapping. It is not permission to claim general remote support.

## Dependency and scope-change rules

A task MUST name its gate and blocking contracts. Work on read-only views can proceed while hardware validation is pending; upload claims cannot. If an external tool cannot meet its contract, first investigate an adapter-level alternative. Replacing the whole IDE foundation requires a recorded architecture decision.

Scope changes record: requested outcome, reason, affected requirement IDs, migration impact, verification impact, and explicit status. “Deferred” is not synonymous with “done.” A release report lists failing or untested required capabilities separately from excluded features.

## Failure and recovery

If G0 reveals that one provider cannot run on the current OS, G1/G2 work can continue with available tooling while the blocker is preserved. G6 remains blocked until a supported, tested path exists or the user explicitly changes scope. If a tool download fails, existing project editing remains available. A missing optional CAD installation is reported as readiness, not project corruption.

## Acceptance criteria

- **AC-D04-01:** Every task in D50 maps to a gate and has a dependency/exit test.
- **AC-D04-02:** G6 checklist includes both providers, unified UI, KiCad, CAD, recovery, and independent file usability.
- **AC-D04-03:** A G2 demonstration is labeled interim and never used as evidence that G6 passed.
- **AC-D04-04:** Unsupported remote workflows fail with a clear boundary explanation before touching a device.

## Sources and related documents

**RESEARCH-RECORDED:** Prior roadmap analysis was grounded in [Arduino integration](https://docs.arduino.cc/arduino-cli/integration-options/) and [VS Code extension testing](https://code.visualstudio.com/api/working-with-extensions/testing-extension). Gate ordering and exclusions are project decisions, not vendor guarantees.

Related: [product definition](product-definition.md), [unknowns](unknowns-and-validation-spikes.md), [task packets](implementation-plan-and-task-packets.md).
