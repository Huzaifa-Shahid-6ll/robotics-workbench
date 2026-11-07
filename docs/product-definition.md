---
doc_id: D03
title: "Product definition"
status: implementation-spec
updated: 2026-11-01
depends_on: [D02]
requirement_ids: [REQ-PROD-01, REQ-PROD-02, REQ-PROD-03, REQ-PROD-04, REQ-PROD-05, REQ-PROD-06]
---

# Product definition

## Purpose and authority

**SPECIFIED:** Robotics Workbench is a personal, local-first engineering workspace delivered as a VS Code extension. It connects ordinary Arduino source, physical-design intent, documentation, tool operations, and recorded observations so the user and an existing coding agent can work from the same identified project objects. “Robotics Workbench” is a working label, not a final product name or publisher identity.

This document owns the product promise. D04 owns release boundaries; D06 owns core requirements; D08 owns architectural decisions. This pack specifies software to be built. It does not establish that any integration, measurement, or hardware test has already passed.

## User and environment

The intended user builds Arduino and robotics projects for personal use. The target machine is Windows x64 with approximately 16 GB RAM, an i5-9500-class CPU, integrated graphics, and a 1366×768 display. Exact Windows build and available storage remain validation inputs. The first reference board is an Arduino Uno; compatible additional boards are configured through installed Arduino cores after testing.

The product MUST preserve editing and local compilation without an AI login. Board connection is required only for operations that need hardware. Optional CAD, KiCad, and document-processing dependencies MUST NOT prevent ordinary firmware work. The user may already have provider subscriptions and local CLIs; supported provider authentication is reused without assuming that every subscription grants API access.

## Product promise

REQ-PROD-01: An existing Arduino sketch can be opened, understood, edited, compiled, uploaded, and inspected without mandatory file conversion, proprietary runtime insertion, or automatic dependency upgrades.

REQ-PROD-02: Codex and OpenCode operate on the same application-owned project facts, artifact references, and selected objects. Their private histories remain provider-owned; handoff does not pretend those histories are identical.

REQ-PROD-03: Selecting a component exposes its intended connections, explicit code bindings, source documents, and applicable experiments. A plot selection identifies the recording and time interval before it is given to an agent.

REQ-PROD-04: Compilation, uploader success, last-known firmware identity, and physical test verification are distinct claims. Every claim can be traced to evidence and its applicable revision.

REQ-PROD-05: Files remain useful outside the extension. The user can reopen a sketch in Arduino IDE, a schematic in KiCad, and a CAD script in its selected Python environment.

REQ-PROD-06: The complete personal release includes linked code, agent, wiring, telemetry, schematic handoff, scripted CAD, and recovery workflows. A chat sidebar alone is an interim result.

## Primary interaction

A task starts from a goal and an explicit project selection. The application gathers bounded relevant context, the selected provider performs work, and the user reviews observable changes and validation results. Deterministic services perform tool operations. Agent prose never changes operation status on its own.

Example: “Investigate the front distance sensor.” The snapshot identifies the selected sensor, intended pins, current source snapshot, latest matching compile/upload, and a raw recording. If physical wiring was confirmed before the last pin change, the confirmation is stale. The agent may propose a source fix and a bench procedure; it cannot claim the sensor now works merely because compilation passed.

## Success and non-goals

Success means the user can complete the reference journeys in D05 with fewer manual transfers of context while retaining control of source and hardware. The release criterion is a passing evidence-backed journey suite, not a target number of features, prompts, or autonomous tool calls.

This product does not initially include multi-tenant hosting, billing, team permissions, fleet management, advanced physics simulation, a native CAD modeling engine, a PCB routing engine, or general ROS orchestration. Hardware measurements remain necessary; software alone cannot certify an assembled robot.

## Failure behavior

Missing context is surfaced as missing, not fabricated. Missing tools disable only dependent operations. A lost board connection preserves logs and marks the last operation truthfully. Conflicting user edits are reconciled before applying/reverting agent changes. If a requested feature exceeds scope, the agent records it as a separate proposal rather than silently expanding the architecture.

## Acceptance criteria

- **AC-D03-01:** Demonstrate every promise above through a linked D06 requirement and a named D48 test scenario; no promise has only marketing prose as evidence.
- **AC-D03-02:** Open an unchanged existing sketch with AI signed out and no board connected; edit and run an installed offline compiler successfully.
- **AC-D03-03:** Run the sensor-debug journey and show separate design, source, upload, and observation identities.
- **AC-D03-04:** Export and reopen standard files with the corresponding external tools without requiring the workbench service.

## Sources and related documents

**RESEARCH-RECORDED:** The prior research's chosen foundation is consistent with [VS Code capabilities](https://code.visualstudio.com/api/extension-capabilities/overview) and [Arduino CLI integration options](https://docs.arduino.cc/arduino-cli/integration-options/). Their current version compatibility is gated by D09/D10, not asserted here.

Related: [scope](scope-and-release-boundaries.md), [workflows](personal-workflows.md), [requirements](requirements-and-acceptance.md), [architecture decisions](architecture-decisions.md).
