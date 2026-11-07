---
doc_id: D40
title: "Hardware testing and debugging"
status: implementation-spec
updated: 2026-11-01
depends_on: [D30, D31, D32, D33, D35, D39]
requirement_ids: [REQ-HW-40-01]
---

# Hardware testing and debugging

## Purpose and authority

**SPECIFIED — REQ-HW-40-01:** Verify deterministic service behavior with fake adapters and recorded evidence, then verify actual USB/upload/reset behavior on the user's Windows/Uno setup. Neither mock tests nor a successful compile certify physical wiring, electrical suitability, or robot behavior. This document defines the hardware test obligations; [D48](testing-and-requirement-traceability.md) owns overall test organization and requirement mapping.

No board is connected in this authoring environment. Every physical acceptance item below is a pending VALIDATION-GATE, not a claimed result. Use a deliberately selected test board and preserve existing source/environment and known artifacts before uploading fixtures. Do not promise recovery of arbitrary firmware already present on a board without its source/binary.

## Test layers and boundaries

| Layer | Controlled inputs | What it establishes |
|---|---|---|
| Domain unit | Manifest, aliases, revisions, clocks | Rules and invalidation behavior |
| Adapter contract | Fake CLI process and serial transport | Arguments, parsing, errors, cleanup |
| Workflow integration | Deterministic fault schedule | Device leases, recovery, artifact selection |
| Editor integration | Real VS Code test host | Commands, dirty-buffer handling, review UI |
| Tool compatibility | Pinned real CLI/CAD/KiCad fixtures | Adapter assumptions against installed tools |
| Physical bench | Actual board, cable, driver, instruments | Observed USB/upload/reset and defined hardware response |

Fake adapters implement only declared interfaces and must not become a speculative Arduino simulator. SerialPort mocks can supply chunks, record writes, and exercise read boundaries, but do not reproduce bootloader timing or Windows driver behavior. Test doubles inject clock, process exit, close acknowledgement, disk error, and disconnect events deterministically. Save the event schedule and expected state trace.

## Required deterministic fault cases

Test upload requested during monitoring with delayed serial close; two simultaneous upload requests; compiler failure; source/board-option/library changes after compile; malformed CLI JSON; externally occupied port; COM reassignment; indistinguishable board identities; missing artifact; wrong artifact hash; process crash after side effect; UI reconnect; disk-full recording; partial raw record; split/coalesced serial frames; clock reset; and provider claims without evidence.

Assertions MUST include absence of forbidden effects: no upload after failed compile, no second writer, no automatic retry after unknown outcome, no stale binary substitution, no command replay, and no overwriting unrelated user edits. A fake success receipt tests receipt handling, not hardware success. Run smaller adapter contract tests against pinned real tools to prevent fixtures from drifting from real output.

## Real Windows/Uno smoke procedure

1. Record OS build, USB interface/driver identifiers when available, CLI/core/uploader versions, board identity evidence, cable/port, and test operator.
2. Import a known ordinary sketch; save its original hashes and establish baseline compile without conversion or dependency upgrade.
3. Select the intended test board explicitly. Compile a small fixture with a known startup message and periodic counter; record artifact hash.
4. Upload that exact artifact and capture the uploader receipt. Open monitoring and record connection boundaries and observed startup output.
5. Repeat monitor → compile → upload → monitor while checking one physical port owner and retained gaps.
6. Close/reopen the extension, unplug/replug the board, and test external-port contention using a deliberately opened monitor. Verify targeted recovery messages and no wrong-target action.
7. Reopen the unchanged project in Arduino IDE and verify ordinary workflow interoperability.
8. Export test evidence and mark each criterion pass/fail/inconclusive with its scope.

Do not deliberately interrupt real flashing merely to duplicate every mock failure. Add physical fault cases only where needed to characterize the actual board/uploader. Opening a serial monitor can reset Uno; record this behavior and do not conceal it by silently patching firmware.

## Sensor and actuator investigations

Define physical setup and criteria before testing a sensor. For an ultrasonic distance procedure, record reference distances, measuring method/uncertainty, target orientation/material, environment, sample count, acceptable error, and invalid-reading treatment. Device identity and electrical facts must be reviewed before interpreting results. A received zero or timeout is not proof of zero distance.

For actuator tests, document intended motion, prepared test setup, operator stop method, power arrangement, and expected observation. Sending a motor command is not evidence of motion. Do not let a general-purpose agent repeat unknown actuator commands to “see what happens.” It may propose a bounded diagnostic step under the configured action policy; the physical test requires a prepared operator and explicit procedure. This is a product behavior requirement, not a claim that software can guarantee physical safety.

## Debugging evidence contract

Each investigation records hypothesis, affected IDs/revisions, supporting and contradicting evidence, next discriminating test, and outcome. Separate compilation, uploading, runtime output, electrical measurement, and physical behavior. “No serial data” may reflect wrong baud, reset timing, blocked port, firmware behavior, or wiring; the agent must not immediately assert sensor failure.

Retain logs with sensitive values redacted, raw evidence references, exact versions, procedure version, expected/observed results, and limitations. A failed test is useful evidence and must not be overwritten by a later pass. Re-running after a fix creates a new run linked to the earlier one.

## Acceptance criteria

- **AC-D40-01:** Deterministic fault suite proves forbidden effects never occur in modeled traces.
- **AC-D40-02:** Real-machine smoke record confirms exact-artifact upload, serial handoff, reconnect, and Arduino compatibility.
- **AC-D40-03:** Test reports distinguish mocked, tool-tested, user-observed, and instrument-measured evidence.
- **AC-D40-04:** Functional pass requires procedure criteria and applicable revision; agent text alone is insufficient.
- **AC-D40-05:** Incomplete/unknown outcomes retain evidence and block unsupported release claims.

## Sources and related documents

- [SerialPort testing](https://serialport.io/docs/guide-testing/), [mock binding](https://serialport.io/docs/api-binding-mock/), [VS Code extension testing](https://code.visualstudio.com/api/working-with-extensions/testing-extension) — RESEARCH-RECORDED, 2026-10-31.
- [Arduino repeated sketch start](https://support.arduino.cc/hc/en-us/articles/4839084114460-If-your-board-runs-the-sketch-twice), [upload troubleshooting](https://support.arduino.cc/hc/en-us/articles/4401874331410--Error-avrdude-when-uploading) — RESEARCH-RECORDED.
- [Device coordinator](device-discovery-and-upload.md), [experiments](experiments-and-run-comparison.md), [agent evaluation](agent-evaluation-and-regression.md).
