# TASK-04 — Arduino vertical slice

Started 2026-11-02 after TASK-03 checkpoint d7307c6. Status: done (G2 scope).
Integration owner: root. Three new agents own Arduino adapter/build identity,
native serial/raw recording, and native VS Code commands/diagnostics/context UI.
Root owns composition, source/artifact registry integration, packaging and bench
evidence. All hardware effects use TASK-03's same job/device coordinator.

Owning documents: D15/D19/D21/D26/D31/D32/D33/D40; D13/D18/D20/D27/D48
govern host, protocol, trust, freshness and evidence. Requirements: REQ-PROD-01,
REQ-PROD-04, REQ-ARCH-03, REQ-ARCH-04, REQ-ARCH-06, REQ-HW-01,
REQ-HW-02, REQ-HW-03. Acceptance: task index AC-D31-01..04,
AC-D32-01/05/06. Prerequisite VG-05 passed within TASK-00's documented scope.
Validation produced here: VG-05/06/14 with software/live hardware distinguished.

The user explicitly authorized replacement of a dedicated Uno's firmware with
the test sketch on 2026-11-02. Discover actual connection/identity before upload;
ask for identification only if discovery is ambiguous. No bootloader burning,
driver installation, core/library upgrade, global configuration change or generic
actuator commands are authorized by this packet.

Expected files: packages/adapters/arduino, packages/adapters/serial,
packages/application/context, apps/extension, apps/companion, synthetic Arduino
fixtures, schemas only for concrete versioned host preparation seams, scripts,
task records and verification. Source import preserves folder names and bytes.

Planned checks: compile/diagnostic failure, dirty/external edit conflict, exact
artifact hashing/target checks, source/library/options freshness, raw capture and
gaps, serial release/reconnect, package/native runtime load, real selected Uno
fixture upload and observed serial output, external contention, provider terminal
with a bounded context snapshot, offline/native file interoperability. Physical
actions and measurements cannot be inferred from software fixtures.

Implemented: ordinary sketch import (manifest creation only), saved-buffer/disk
preconditions, immutable source snapshots, CLI/core/compiler/library fingerprints,
mapped snapshot diagnostics, current exact-artifact upload, native serial capture,
bounded raw replay and existing Codex terminal with a 24 KiB application snapshot.
Host and agent operations share the TASK-03 coordinators. CLI 1.5.1, AVR 1.8.8,
bindings-cpp 13.0.1 and local Windows x64 Node 24.18.0 were tested. Native runtime
files and licenses are inside the inspected VSIX with exact hashes.

Integration extended the packet's module ownership to apps/companion and the
shared contracts/persistence seams: five bounded host preparation/query methods,
durable request auditing, cold-start build summaries/unknown-device reservations,
root-folder source/archive support and native package delivery. Canonical IDs,
operation states and storage authorities remain the D14/D18/D19 contracts.

Three original TASK-04 agents owned Arduino, serial and host implementation;
three recovery agents completed those same modules and independently reviewed
integration, packaging and documentation. TASK-02 and TASK-03 each used their
own three-agent teams before this task started. Root reconciled every shared seam.

Executed `npm run verify:task -- TASK-04`: all five stages passed, including
127 tests, inspected packaging and installed trusted/restricted VS Code hosts.
The installed native binary loaded exclusively from the VSIX and rejected an
owned ordinary file as a serial port without touching physical hardware.

The explicitly authorized dedicated Uno was observed on COM4, USB serial
PRIVATE_BENCH_SERIAL_WITHHELD. Its uploaded HEX SHA256 is
`ad7580cf03dc5735ce6aaffd737065eb970268d768e24b7c3d151ffbc3ccd396`.
Uploader code 0, an actual post-upload raw connection segment containing the probe
startup marker and counter reset, and independent external-port contention were
observed separately. Native Arduino IDE 2.3.10 opened the staged sketch with
unchanged source bytes. Codex CLI 0.160.1 received the actual 10,523-byte context,
returned the correct project acknowledgement, made no tool calls and exited 0.

Retained failures: the first bench capture ended before upload finished; the
corrected 60-second capture was explicitly cancelled after post-upload reception.
Duplicate release notifications in that run produced two gap markers for one
upload; final software deduplicates state notifications with a regression check.
Computer Use screenshot/input geometry failed; direct native file invocation and
window/source identity supplied the IDE opening evidence. No screenshot is claimed.
An intermediate package/install entrypoint race was resolved by the final stable
rebuild/package/install, whose byte checks passed.

Completion evidence: [verification/task-04.json](../verification/task-04.json),
with requirements, actual changed files, exact commands, log/artifact hashes and
separate software, native package, provider and real-board evidence. VG-05/06/14
pass only within their recorded scopes. G6 and D48 complete-release checks remain
TASK-11/TASK-12 obligations; this task does not claim the full personal release.

Limits: uploads are enabled only for the validated Uno recipe; profile-bearing
sketches are preserved and refused to prevent implicit dependency downloads.
Unknown uploads remain blocked for explicit investigation; no automatic replay.
Parsed channels/plots, both normalized provider adapters, custom agent UI and full
recovery journeys remain later packets. Physical unplug/replug, driver changes,
wiring, sensor/actuator behavior and two interactive-window drills were not run.
