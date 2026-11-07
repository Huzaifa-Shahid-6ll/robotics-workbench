---
doc_id: D32
title: "Device discovery and exact-artifact upload"
status: implementation-spec
updated: 2026-11-02
depends_on: [D19, D20, D29, D31]
requirement_ids: [REQ-HW-32-01]
---

# Device discovery and exact-artifact upload

## Purpose and authority

**SPECIFIED — REQ-HW-32-01:** All workbench serial access and uploads MUST pass through one device coordinator. D32 owns target identity, leases, handoff, and upload receipts. An upload is a physical side effect, distinct from saving source or accepting an agent edit. Arduino CLI remains responsible for platform-specific uploader/reset recipes. Board-operation evidence is tracked separately from this specification in task records.

## Identity and selection

`deviceId` is an application identity; `COM5` is a replaceable observed address; `fqbn` is a compiler target. Store these separately. Discovery observations include timestamp, available serial number, VID/PID, PnP/location identifiers, port path, and candidate board names. Metadata may be missing. A target association MUST record its evidence and confidence; a matching COM path alone cannot prove continuity across disconnects.

For one known board, retain selection and revalidate before action. When two indistinguishable boards appear or identity is ambiguous, require explicit selection and disclose the ambiguity. Do not choose the first enumerated port. Physical USB access belongs to the Windows host; a WSL/remote extension host MUST report unsupported access or communicate through a separately validated host adapter, never pretend Linux paths are Windows ports.

## Upload request and preflight

This is the flattened domain-command representation. The D18 transport envelope owns `projectId` and `expectedProjectRevision`; the remaining fields belong in `params`. All application IDs, including `artifactId`, are UUIDs.

```ts
type UploadRequest = {
  projectId: string;
  expectedProjectRevision: number;
  buildId: string;
  artifactId: string; // UUID registry handle for one file or bundle
  artifactSha256: string;
  deviceId: string;
  expectedDeviceObservationId: string;
  fqbn: string; // assertion against build record, never an override
  resumeMonitoring: boolean;
};
```

The required `artifactId` resolves the exact registry entry; `artifactSha256` verifies those bytes. The submitted `fqbn` is an assertion that MUST equal the immutable build record's FQBN, not a separate authority or target override. A mismatch fails preflight; selecting another target requires an appropriate build or explicitly compatible artifact. The coordinator MUST resolve immutable artifact bytes, recompute their hash, check target compatibility, and show the selected board/port and build identity. Default Upload uses the latest matching successful build; a source/build mismatch offers rebuild or explicit historical-artifact selection. The service rechecks identity and revision immediately before taking the lease. A compile failure cannot fall through to an older binary.

Use explicit CLI input artifact paths or a captured artifact bundle according to the tested platform adapter. The uploader MUST NOT search an unspecified temporary directory. The relevant official upload options include `--input-file` and `--input-dir`; support is gated against installed CLI help and board recipes. Multi-file targets require a bundle manifest rather than arbitrarily choosing one file. Burn-bootloader, programmer fallback, fuse changes, and erase operations MUST NOT be automatic error recovery.

## Coordinator state machine

| State | Permitted transition | Required evidence |
|---|---|---|
| `disconnected` | `available` | Fresh compatible observation and selection |
| `available` | `monitoring` or `uploading` | Exclusive lease and successful open/start |
| `monitoring` | `releasing-monitor` | Stop writes, freeze desired monitoring configuration |
| `releasing-monitor` | `uploading` | Serial handle close acknowledged |
| `uploading` | `reconnecting` | Uploader ended and receipt persisted |
| `reconnecting` | `monitoring` or `available` | Identity resolved; monitoring still desired |
| Any applicable state | `blocked` | External contention or recoverable preflight failure |
| `uploading` | `outcome-unknown` | Process/host loss leaves physical result unresolved |

Device state differs from operation status. Operation statuses are exactly `queued`, `running`, `awaiting-input`, `succeeded`, `failed`, `cancelled`, `outcome-unknown`. Queue acknowledgement is not success. Serialize uploads per device, share one serial stream among readers, and reject a second competing coordinator if cross-window sharing is unavailable. The lease cannot prevent an unrelated Arduino IDE from owning the port; report external contention without killing its process.

## Completion and recovery

Capture operation ID, build and artifact hash, target observation, resolved port, CLI/core/uploader versions, start/end time, stdout/stderr, exit code, and verification mode. Uploader success proves only the adapter's reported upload outcome. It does not prove the robot moved correctly or every byte of running firmware is independently identified. Monitoring may reset an Uno; create a new connection segment and record possible reset, not an invented confirmed boot identity.

Cancellation after writing starts may leave a partial/unknown result. Persist intent before launching and reconcile process/lease state after restart. The original `outcome-unknown` receipt is immutable; subsequent investigation creates a linked reconciliation receipt rather than rewriting history. Never automatically replay an interrupted upload. Offer explicit retry after target identification; do not claim the prior operation succeeded from a later reconnect. Restoring a known previous artifact is a new upload, not a filesystem undo. Reopening monitoring MUST NOT replay previously sent commands.

## TASK-04 implementation scope — 2026-11-02

**IMPLEMENTED:** [HardwareService](../apps/companion/src/hardware-service.ts)
uses the shared durable job coordinator and
[DeviceCoordinator](../packages/devices/src/index.ts) for native host requests.
`device.discover` stores timestamped CLI observations and candidate board
metadata. `device.select` records an explicit user association against an exact
observation ID. A reused COM address does not establish board identity; changed
USB identity, duplicate identity or ambiguous reconnection prevents unattended
selection. Unknown upload outcomes keep the affected port reserved until
explicit reconciliation; selection alone cannot clear that state.

`firmware.upload` resolves the selected immutable artifact, verifies its bytes,
FQBN/options, current source/toolchain/library identity and current device
observation, then waits for observed monitor-handle closure before launching the
uploader. The adapter uses `--input-file` for the selected non-bootloader Uno HEX.
The enabled combination is Windows x64, Arduino CLI 1.5.1 and Arduino AVR 1.8.8,
with upload limited to `arduino:avr:uno`. No programmer fallback, bootloader
burning, configuration mutation or dependency upgrade occurs on failure.
Retained upload records link the build, target observation, artifact hash and
uploader logs. The success label is `uploader-reported-only`.

Compile does not acquire the serial lease. A requested upload may pause active
capture, records an upload gap, and resumes still-desired monitoring only after
the handoff checks. External port ownership is reported without killing another
application. An uncertain uploader termination is `outcome-unknown`, with no
automatic retry. Fake handoff tests establish software ordering; actual reset,
USB and serial-return results belong to [TASK-04 evidence](../tasks/TASK-04.md).

**OBSERVED — bounded live smoke, 2026-11-02:** On the explicitly selected dedicated
Uno at observed COM4, the coordinator uploaded artifact SHA256
`ad7580cf03dc5735ce6aaffd737065eb970268d768e24b7c3d151ffbc3ccd396` with uploader
exit code zero. Resumed capture retained probe startup/counter bytes and an
explicit upload gap. An independent native serial owner then held the same
physical port; workbench capture failed explicitly and left that owner intact.
The earlier capture-timing failure is retained as a separate run. This supports
the scoped VG-06 upload/monitor-return and VG-14 contention checks; unplug/replug
was not performed, and no wiring, sensor, actuator or G6 release pass is implied.

## Acceptance criteria

- **AC-D32-01:** Monitor-to-upload handoff waits for actual close acknowledgement, including delayed-close fixtures.
- **AC-D32-02:** Concurrent UI/agent requests cannot run two uploaders on one device; unrelated targets remain independently schedulable.
- **AC-D32-03:** A changed port or ambiguous identical board cannot cause unattended wrong-target upload.
- **AC-D32-04:** Crash after external side effect yields `outcome-unknown` and no replay on startup.
- **AC-D32-05:** Uploaded receipt links exactly to selected immutable bytes; mismatched hashes fail before physical access.
- **AC-D32-06:** Real Windows/Uno testing confirms upload and reconnect behavior; mock success alone does not satisfy this gate.

## Sources and related documents

- [Arduino upload reference](https://docs.arduino.cc/arduino-cli/commands-reference/arduino-cli_upload) and [CLI upgrade notes](https://github.com/arduino/arduino-cli/blob/master/docs/UPGRADING.md) — SOURCE-VERIFIED via Context7, 2026-11-01.
- [Upload contention](https://support.arduino.cc/hc/en-us/articles/4401874331410--Error-avrdude-when-uploading) and [Uno reset on monitoring](https://support.arduino.cc/hc/en-us/articles/4839084114460-If-your-board-runs-the-sketch-twice) — RESEARCH-RECORDED, 2026-10-31.
- [Serial and telemetry](serial-monitor-and-telemetry.md), [hardware tests](hardware-testing-and-debugging.md), [action policy](tool-catalog-and-action-policy.md).
