---
doc_id: D33
title: "Serial monitor and telemetry"
status: implementation-spec
updated: 2026-11-02
depends_on: [D16, D19, D32, D39]
requirement_ids: [REQ-HW-33-01]
---

# Serial monitor and telemetry

## Purpose and authority

**SPECIFIED — REQ-HW-33-01:** Preserve raw incoming bytes before parsing or plotting. Existing `Serial.print` sketches MUST work without a telemetry library. Structured data is optional and never silently injected into firmware. The coordinator in [D32](device-discovery-and-upload.md) owns the port; this document owns recording, parsing, clock semantics, replay, and bounded access.

## Session configuration and ownership

A monitor request identifies deviceId, selected baud, parity/data/stop bits supported by the adapter, encoding, optional parser profile, and whether to record. Initial settings are **9600 baud, 8 data bits, no parity, 1 stop bit, UTF-8 display, raw-text mode, no appended newline on send, and recording off until explicitly started**. These are visible defaults, not inferred firmware facts. Persist an explicit user choice per device/project; never silently switch it on reconnect. Validate baud as an integer from 1 to 4,000,000 (an application input bound, not a hardware-support claim); the transport must reject unsupported values. Supported framing options are adapter-advertised; initially expose only tested 8N1. Port-open failure is not a zero-valued measurement. Multiple views and agents subscribe to one coordinator stream. Closing a plot removes its subscription, not another subscriber's capture. A deliberate Stop capture action closes the recording while monitoring may continue.

Serial writes require an explicit user/project action and the configured action policy. Line ending is visible and stored. A write receipt distinguishes queued bytes, transmitted bytes where observable, and application acknowledgement only when an opt-in firmware protocol supplies one. `drain` is not proof of actuator execution. Reconnect MUST NOT replay writes.

## Recording contract

Use append-only JSONL raw segments initially. Base64 preserves arbitrary bytes. Each record carries this shape; values below are illustrative:

```json
{
  "schemaVersion": 1,
  "recordingId": "44444444-4444-4444-8444-444444444444",
  "connectionSessionId": "55555555-5555-4555-8555-555555555555",
  "sequence": 42,
  "hostElapsedNs": "1200000000",
  "hostReceivedAt": "2026-11-01T07:00:01.200Z",
  "bytesBase64": "cmFuZ2U6MTIuMwo=",
  "quality": "received"
}
```

The machine-readable [raw-record schema](../contracts/serial-record.schema.json) and [valid](../examples/serial-record.valid.json)/[invalid](../examples/serial-record.invalid.json) fixtures define this shape. Validation MUST enable UUID/date-time format checks. This schema covers received bytes only; gap events have no fabricated byte payload.

Nanosecond quantities are decimal strings, avoiding JavaScript integer precision loss. The manifest records projectId/projectRevision, deviceId, serial settings, known upload receipt/artifact hash or explicit unknown, start/end time, segment hashes, parser configuration, and retention policy. Sequence is monotonic within a connection session. Connection resets create a new segment. A connection boundary is not by itself proof of device reboot.

Record gap events for overflow, intentional upload interruption, disconnect, and disk failure. A gap carries cause, time interval if known, and lost-byte/sample count only if measured. Unknown count is `null`, never zero. Raw evidence and parsed data use separate files/indexes. Write temp metadata and recover unclosed segments after a crash by parsing complete records and quarantining an incomplete final record.

## Parsing and clocks

Supported initial modes are raw text, explicit Arduino-style labeled numeric values, explicit CSV mapping, and explicit JSON Lines mapping. Parser configuration is immutable per derived dataset and has a version/hash. Autodetection may propose a mode but MUST NOT replace the user's selection or change semantics mid-recording. Chunks are transport buffers, not messages: preserve trailing partial frames and accept multiple lines per chunk. Invalid bytes remain accessible even if text display uses replacement glyphs.

Parsed samples reference raw record sequence and byte spans, channel ID, numeric value or parse failure, unit or unknown, parser version, host receive time, and optional device time/sequence. Device clock wrap, reset, repeated timestamps, and host wall-clock adjustment require explicit handling. Use monotonic host elapsed time for local intervals. Do not label receive time as sensor acquisition time or infer zero from absent input.

## Plot and agent access

Reuse uPlot after its installed API is validated. Render bounded batches; do not update React for each byte. Keep a bounded live ring buffer and separate retained recording. Decimation SHOULD preserve extrema and gaps and MUST disclose display resolution. Chart alignment may insert nulls; it must not overwrite raw samples or invent interpolation as measured data. Channel units and distinct axes must remain visible.

Agent query requests specify recording, channels, time basis, range, and result limit. Return deterministic count/min/max/statistics, gaps, parser provenance, and exact expansion handles. A selected interval freezes these identifiers before entering context. Replay is read-only and uses recorded timestamps; changing a parser creates a new derivation and leaves the original intact. Live versus replay is always labeled.

## TASK-04 raw-capture implementation scope — 2026-11-02

**IMPLEMENTED:** [NativeSerialTransport](../packages/adapters/serial/src/native.ts)
loads the extension-owned `@serialport/bindings-cpp` 13.0.1 runtime in local Node,
separate from Electron. This path exposes receive/close operations, with no serial
write API. The shared coordinator owns a single native stream and subscription
lifecycle. The native host explicitly requests a 1–60 second capture and a baud
from the application bound, using 8N1; a valid numeric baud is not a guarantee
that a particular adapter supports it.

[RawRecorder](../packages/adapters/serial/src/recorder.ts) preserves JSONL
base64 bytes, session/sequence identity, monotonic host receive time, UTC receive
time and the known upload receipt/hash or explicit unknown. Raw retention is
bounded to 64 MiB segments, an 8 MiB acquisition bound and 1 GiB of incoming raw
bytes per recording; JSON/base64 storage has additional framing overhead.
Boundary and failure metadata retain upload/disconnect/reconnect/overflow/storage
gaps with null loss counts when unmeasured. Recovery preserves the original file,
copies its valid prefix and quarantines an incomplete tail. It does not replay
serial commands or turn an interrupted capture into a success.

The v1 `recording.query` implementation supports raw `host-receive` intervals
only, with no parsed channels. Each page returns at most 4096 exact decoded bytes
as `bytesBase64`, a convenient `text` preview, parser version, recording ID and a
continuation cursor bound to that recording and interval. A raw frame may span
pages; decode base64 across pages when reconstructing continuous UTF-8. Text
replacement glyphs are display behavior, not changes to retained bytes. Gap
responses include at most 16 entries and an explicit `omittedGaps` count. The host
caps its aggregate output preview at 64 KiB and exposes continuation information.

TASK-04 did not supply numeric parsers, plots, channel statistics or device-clock
interpretation; TASK-09 adds the scoped implementation described below. Raw capture tests and installed-native load tests are
software evidence; they do not prove live board output. The separate dedicated
Uno smoke run observed resumed startup/counter bytes after the exact upload and
retained the upload interruption as a gap. The earlier harness timing failure
remains recorded. No unplug/replug or sensor/actuator test was performed. Exact
serial artifacts, observations and remaining checks belong to
[TASK-04](../tasks/TASK-04.md).

## Errors and acceptance criteria

**SPECIFIED initial limits:** honor D07's 10,000 rendered-row ceiling and 32 KiB context response ceiling. Additionally cap one displayed line at 64 KiB decoded text, one parser frame at 1 MiB raw bytes, the acquisition queue at 8 MiB, UI update cadence at 20 Hz, raw segment files at 64 MiB, and a recording at 1 GiB by default. Oversized frames emit a parse-limit event and preserve raw bytes; a line preview truncates with an expansion handle. Rotate segments without loss. Reaching the recording cap finalizes capture and reports the limit while monitoring may continue. These configurable engineering limits require benchmark review, not silent expansion. A queue overflow emits a gap with known lost bytes and stops recording if sustained; do not claim a lossless capture. Disk cap behavior MUST stop recording with an explicit error rather than delete user evidence silently. A saturated UI should drop display frames before acquisition data. If acquisition loss is unavoidable, emit a gap receipt.

- **AC-D33-01:** Arbitrary chunk splits/coalescing produce identical parsed samples and retain identical raw bytes.
- **AC-D33-02:** Invalid UTF-8, binary data, and incomplete final lines remain inspectable without false numeric samples.
- **AC-D33-03:** Reconnect, upload interruption, clock reset, and overflow remain visible in replay and agent summaries.
- **AC-D33-04:** Replay performs zero serial writes and reproduces derived values for the same parser version.
- **AC-D33-05:** Disk-full and crash fixtures preserve earlier complete records and label incomplete capture truthfully.
- **AC-D33-06:** Multiple subscribers produce one physical serial open and one coherent recording timeline.

## Sources and related documents

- [SerialPort stream API](https://serialport.io/docs/api-stream/), [Readline parser](https://serialport.io/docs/api-parser-readline/), [uPlot data requirements](https://github.com/leeoniya/uPlot/blob/master/docs/README.md) — RESEARCH-RECORDED, 2026-10-31; installed versions remain VALIDATION-GATE.
- [Arduino Serial Plotter documentation](https://github.com/arduino/docs-content/blob/main/content/software/ide-v2/tutorials/ide-v2-serial-plotter/ide-v2-serial-plotter.md) — RESEARCH-RECORDED.
- [Experiment comparison](experiments-and-run-comparison.md), [storage](storage-and-migrations.md), [context provenance](context-provenance-and-freshness.md).

## TASK-09 implementation — 2026-11-03

Explicit immutable parser profiles live in telemetry/parsers.json. The v1 engine
supports raw text, labelled numeric lines, single-line CSV mapping and JSON Lines
mapping. Multiline quoted CSV is rejected with retained raw evidence. Profile IDs
are UUIDs; configuration hashes and parser version bind each derivation. Derived
UUIDs and complete source fingerprints remain separate from raw segment hashes.

Chunks preserve partial frames, binary/UTF-8 failures, original byte spans and
connection sessions. Device time requires a declared clock source and epoch.
Modulus-based wrap detection retains reset uncertainty. Host receive time is not
sensor acquisition time. Statistics use every selected finite sample, with no
zero-fill or interpolation; display decimation preserves extrema and gap breaks.

Final derivation runs in a supervised worker under the existing heavy-job queue,
with 32 MiB raw-JSON input, 64 MiB output and a 30-second deadline. Raw recording
retention limits are unchanged. Failed/interrupted final segments may supply
only their complete LF-terminated prefix, with full original segment hash and an
explicit unknown-tail issue. Completed/corrupt evidence cannot use that exception.

A capture observer runs after preserved writes. Its display failures never stop
raw acquisition. Live views keep a bounded 1 MiB byte ring, latest 2,000 samples
and 100 markers; omissions are disclosed. Pausing/closing display does not stop
capture. A provisional live window cannot become frozen agent evidence. The
finalized derivation, exact channels/clock/interval and original design revision
are frozen before Ask; sending remains separate. Historical parser definitions
remain inspectable after current-source changes, without silently re-parsing.

S08/S09 use uPlot 1.6.32, native theme tokens and an accessible paged table.
Comparison axes use each channel's own unit and a distinct run/channel style.
Interval export contains full-resolution samples only for the exact selected
channels, clock epoch and inclusive time range. Original derivation and raw
hashes are provenance references, not claims that the subset is a new derivation.
Device-clock exports retain all disclosed gaps/issues when no mapping to host
time exists; that uncertainty is explicit.
Historical raw queries/replay never write to a port. See TASK-09 and its completion
record for executed software/native/browser and retained-real-capture replay
evidence; no plot alone verifies physical behavior.

## TASK-11 native continuous recording boundary

Trusted native capture accepts an explicit duration from one second to one hour.
The MCP tool remains capped at 60 seconds in its schema and runtime policy.
Longer native sessions retain the same raw byte/segment/acquisition limits and
device coordinator. A test admits a ten-minute duration, immediately cancels after
injected bytes, and observes closure without waiting ten minutes. It is software
evidence, not a claim of a ten-minute physical recording.

An observed disconnect ends capture promptly with failed/partial evidence and an
explicit gap. Waiting for user USB participation uses one continuous capture;
the application does not repeatedly close/reopen the device on a one-minute
timer. A later capture requires a new explicit action.
