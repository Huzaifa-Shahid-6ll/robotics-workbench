---
doc_id: D10
title: "Unknowns and validation spikes"
status: implementation-spec
updated: 2026-11-01
depends_on: [D08, D09]
requirement_ids: []
---

# Unknowns and validation spikes

## Purpose and authority

**VALIDATION-GATE:** These are unresolved implementation or machine facts, not missing product intent. The agent MUST execute the smallest listed experiment before relying on each assumption. It may continue independent work while a gate is blocked. It must not silently substitute an API, device identity, or installed version.

No user answer is required to start documentation, scaffolding, fake-adapter tests, or read-only compatibility discovery. Real-machine access, account sign-in, and physical confirmation may be needed later. D50 must link blocked tasks to gate IDs.

## Gate register

| Gate | Unknown | Smallest experiment | Pass evidence / blocked work |
|---|---|---|---|
| VG-01 | Exact Windows/VS Code/runtime support | Read OS/build/arch; install tiny VSIX; start selected companion | Recorded environment and successful IPC; blocks release platform claim |
| VG-02 | Codex supported session integration on this PC | Version probe and harmless app-server session in scratch workspace | Parsed capabilities/events and cancel/reconnect trace; blocks Codex adapter release |
| VG-03 | OpenCode selected server/SDK behavior | Version probe, documented server start, harmless turn/cancel | Same contract evidence; blocks OpenCode adapter release |
| VG-04 | Native versus WSL provider boundary | Only if VG-02/03 fail natively: map one test file and invoke a read-only tool | Correct path/security/ownership behavior; blocks WSL support claim |
| VG-05 | Arduino environment and target baseline | Read effective config; compile existing sketch with selected FQBN | Tool/core/library identity and artifact captured; blocks build currency claim |
| VG-06 | Serial/USB/reset behavior | Real Uno enumerate/open/close/upload/reconnect with one owner | Port release observed, exact-artifact upload record, reset behavior noted; blocks real hardware release |
| VG-07 | Native SQLite/serial packaging | Install packaged VSIX/companion outside development environment | Bindings load and execute basic DB/serial operations; blocks distribution |
| VG-08 | External edits versus dirty buffers | Provider/fake process edits a file while VS Code has unsaved changes | Both versions preserved and explicit reconciliation; blocks auto-apply/revert |
| VG-09 | KiCad supported generation/validation subset | Generate minimal fixture, validate/export, edit externally, re-open | Native output accepted; divergence detected; blocks schematic release |
| VG-10 | CAD interpreter/viewer public seam | Generate a simple solid, preview, export, break script deliberately | Exact interpreter/output provenance, stale preview on failure; blocks CAD release |
| VG-11 | Actual performance and disk footprint | Run D07 workload suite on target PC | Baseline plus measured budgets; blocks “fits this machine” claim |
| VG-12 | Document extraction and source anchors | Import digital PDF and image-only sample with table | Correct page anchors; uncertain/missing extraction explicit; blocks document reliability claim |
| VG-13 | Crash consistency and device replay | Kill companion between intent/file/DB/external-operation steps | Reconciled states; no repeated upload; blocks recoverability claim |
| VG-14 | Cross-window owner coordination | Open two windows and an external monitor against same device | Shared owner or clear refusal; external contention handled; blocks concurrent-use claim |
| VG-15 | Backup portability and secret exclusion | Export, restore to different directory, scan manifest/log fixtures | Links resolved, artifacts hash-match, no credentials; blocks backup claim |

## Spike output contract

### Observed initial compatibility gates — TASK-00 completion

[Current compatibility evidence](../verification/task-00-completion.json) records
passing VG-01 (installed shell/IPC), VG-02 (native Codex completion/interrupt/resume),
VG-03 (native OpenCode executable/SDK completion/abort/event reconnect), VG-05
(unchanged pre-existing installed Blink example compile), and VG-07 (installed
native-library fixture: durable SQLite and safe serial negative path).
These passes apply only to the recorded Windows/host/runtime/tool versions and
explicit scopes. No personal sketch was found; no physical device was selected.
Native serial success/reset and physical observations remain not-run at VG-06.
VG-04 remains conditionally not-run because no WSL workaround was selected.

The failed OpenCode OAuth refresh was preserved and resolved by the user's normal
provider sign-in, without extracting credentials or changing account routes.
The initial Codex interrupt-before-start race was preserved and corrected by
waiting for the attributable turn/started event before requesting cancellation.
Neither request acknowledgement nor model prose was treated as success.
TASK-05 still requires full adapter/approval regression tests. TASK-04's real
hardware work still requires VG-06/VG-14 observations; TASK-11/TASK-12 retain their
recovery, distribution and complete-release checks. TASK-00 is compatibility
evidence, not a claim that these later implementations exist.

### TASK-04 observed Arduino slice

[TASK-04 evidence](../verification/task-04.json) adds a dedicated Uno on Windows:
exact stored HEX upload through the coordinator, actual monitor release/reopen,
post-upload startup/counter bytes, raw segment hashes and an independent external
serial owner refused by capture. VG-06 passes for this CLI/core/board combination;
VG-14 combines the real competing-companion refusal test with the physical
external-owner test. Two interactive windows, physical unplug/replug, driver
changes and wiring/sensor/actuator behavior were not exercised. The first bench
capture timed out before upload finished; both that failure and the corrected
longer capture are retained. TASK-11/TASK-12 still own complete recovery/release.

Each completed experiment produces a short record with `gateId`, hypothesis, application/tool versions, environment, commands or test procedure, observed result, evidence paths/hashes, limitations, and disposition. Disposition is `passed`, `failed`, `blocked`, or `not-run`. An internet documentation citation can verify an API shape but cannot pass a Windows USB experiment.

A passing gate applies only to the tested combination. A major provider protocol, OS, native binding, or toolchain change may reopen it. Avoid blanket “verified” labels without scope. Capture failure evidence as carefully as success evidence because it determines the next adapter decision.

## Decision procedure

TASK-02's [completion evidence](../verification/task-02.json) adds scoped passing
VG-13 evidence for actual process loss at all artifact-commit boundaries and
synthetic operation reconciliation without replay, and VG-15 evidence for
single-project ordinary-file/evidence export and restore to new directories,
checksum verification and planted-secret rejection. This does not establish real
USB/upload behavior or the later integrated recovery journeys.

1. Read the owning contract and relevant primary documentation.
2. Define the minimal safe fixture and observable pass/fail criterion.
3. Run in an isolated workspace with no unrelated file or hardware effects.
4. Compare observations to the contract, retaining raw output with secrets removed.
5. If failed, test a bounded adapter alternative; do not rewrite product scope.
6. Update compatibility metadata and affected task packets.

The provider spikes must not extract private credentials. Hardware spikes require a known target and an explicit procedure; unrequested bootloader burning is not recovery. Tests that can affect motors or other actuators use a safe bench setup and cannot infer permission from a downloaded document or serial message.

## User decisions deferred until relevant

| Question | Default for independent work | When actual input is required |
|---|---|---|
| Final extension name/publisher | Working identifier robotics-workbench | Before public naming or permanent distribution identity |
| Data directory | Configurable setting, no hard-coded drive assumption | First installation choosing writable storage |
| Provider/model/account | Adapter selection and readiness UI | Login or choosing among actual available accounts/models |
| Board identity and wiring | Uno test fixture in specs only | Before real upload or physical confirmation |
| Missing hardware observations | Record unknown | When a test procedure requires the user's measurement |

These defaults authorize specification work, not fabricated machine observations.

## Acceptance criteria

- **AC-D10-01:** Every unverified external integration has a gate with evidence and a blocked-task mapping.
- **AC-D10-02:** A failed gate produces a bounded alternative or explicit blocker rather than invented successful output.
- **AC-D10-03:** No physical gate is marked passed from fake-adapter results.
- **AC-D10-04:** Machine-specific questions are asked only when they block the next dependent action; independent work continues.

## Sources and related documents

**RESEARCH-RECORDED:** Prior adversarial review identified native ABI, external edit, serial contention, and artifact identity risks. Primary anchors: [VS Code remote/host boundaries](https://code.visualstudio.com/api/advanced-topics/remote-extensions), [SQLite atomic commit](https://sqlite.org/atomiccommit.html), [Arduino compile](https://docs.arduino.cc/arduino-cli/commands-reference/arduino-cli_compile/).

Related: [dependencies](dependencies-and-compatibility.md), [budgets](quality-and-performance-budgets.md), [implementation tasks](implementation-plan-and-task-packets.md).
