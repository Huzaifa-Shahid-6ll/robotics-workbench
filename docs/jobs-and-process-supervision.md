---
doc_id: D19
title: "Jobs and process supervision"
status: implementation-spec
updated: 2026-11-01
depends_on: [D16, D18]
requirement_ids: [REQ-ARCH-03, REQ-ARCH-04]
---

# Jobs and process supervision

## Authority and invariant

**SPECIFIED:** This document owns operation scheduling, subprocess lifecycle, cancellation, and recovery. All execution enters the companion's operation coordinator. A webview, provider adapter, or MCP bridge MUST NOT independently spawn an uploader that bypasses device ownership. Provider shell permissions remain a separate boundary: the service cannot constrain a provider allowed to execute arbitrary external commands.

The minimal serialized operation receipt is authoritative in [operation.schema.json](../contracts/operation.schema.json): schemaVersion, operationId, requestId, projectId, kind, status, expectedProjectRevision, createdAt, tool `{name, version}`, and artifacts are required. Terminal receipts also require finishedAt; uploads require deviceId and sourceSnapshotId. Request-payload deduplication metadata, target/configuration, environment identity, and bounded diagnostics belong to related internal audit records unless explicitly present in that schema. `reconcilesOperationId`, when present, links a new receipt to an earlier ambiguous operation. Durable intent precedes any external side effect.

## Status machine

Allowed operation statuses are exactly `queued`, `running`, `awaiting-input`, `succeeded`, `failed`, `cancelled`, and `outcome-unknown`.

| Transition | Condition |
|---|---|
| queued → running | Preconditions pass and all required leases acquired |
| queued → awaiting-input | Specific unresolved target/permission/input required |
| queued → cancelled | Removed before external execution begins |
| running → awaiting-input | Supported tool interaction pauses at a known safe boundary |
| awaiting-input → running | Input accepted and preconditions revalidated |
| running → succeeded | Adapter observes documented success and required artifacts/results validate |
| running → failed | Observed definitive failure; side effects recorded |
| running → cancelled | Termination observed and outcome is known within operation semantics |
| running → outcome-unknown | Process/connection loss leaves an external effect ambiguous |

`awaiting-input` may also become cancelled. Expired preconditions may lead to failed with a specific conflict code. Terminal receipts are immutable, including outcome-unknown. Explicit reconciliation creates a NEW receipt linked through reconcilesOperationId and records evidence; it never rewrites or replays the original receipt. A successful compile does not verify behavior; an upload receipt does not verify physical wiring.

## Queues and leases

Initial resource policy permits one CPU-heavy compile, CAD, or document-ingestion job at a time on the user's six-core/16-GB machine, while independent bounded reads remain concurrent. This is a conservative SPECIFIED default, not a measured optimum. Device operations are exclusive per deviceId and transport identity. One physical port cannot be leased twice through aliases or two project windows.

A monitor-to-upload transition is `monitoring → releasing-monitor → uploading → reconnecting → monitoring/available`. Wait for actual transport closure before uploader launch. A timeout produces blocked or unknown state as appropriate; sleeping a fixed interval is not proof of release. Detect external port contention and name the observable symptom without claiming the workbench controls other programs.

Queue requests bind their input snapshot and intended target. Before starting a delayed job, revalidate any live conditions required by that operation. Do not silently substitute the newest build or newly connected device because the queued target disappeared. Hardware jobs never persist as unattended replayable work after restart.

## Subprocess launch contract

Resolve executable identity from a trusted configuration/discovery result. Launch using structured argument arrays and a controlled working directory, not a shell command assembled from model text. Windows `.cmd`/batch wrappers need a separately tested adapter path; do not invoke a shell generically to make quoting errors disappear. Environment variables are allowlisted or deliberately inherited, with secrets redacted from logs.

Capture stdout/stderr separately with bounded in-memory buffers and durable diagnostic artifacts where needed. Parse structured tool output when supported. Preserve raw evidence and parser version. Exit code alone is insufficient when the adapter requires a produced artifact or completion record. Conversely, an error-looking log line is not by itself a definitive process failure.

## Cancellation and timeout

A cancel request records intent immediately, then invokes the adapter's supported stop path. Job types declare cancellability and whether termination can leave effects unknown. Compilation can generally be stopped with partial outputs discarded; upload interruption may leave firmware outcome unknown. CAD scripts may spawn descendants, requiring tested process-tree cleanup.

Initial proposed limits: tool-discovery 15 seconds, ordinary compile 180 seconds, upload 120 seconds, CAD generation 120 seconds, with explicit configuration for known slower targets. These are watchdog defaults to validate, not guarantees. On timeout, show the operation and elapsed time, request adapter termination, and classify observed outcome honestly. Serial capture uses user-selected duration or an explicit stop action plus disk quota, not the generic compile timeout.

## Restart recovery

On startup, reconcile every nonterminal persisted operation. A queued physical job is cancelled with restart reason; an interrupted upload becomes outcome-unknown unless durable evidence proves a result. Incomplete build/CAD jobs become failed or cancelled with partial artifacts quarantined. Never rerun a command merely because a receipt lacks its final row. Provider resumption attaches to known opaque session identity only through the adapter's supported mechanism.

## Acceptance criteria

- **AC-D19-01:** Simultaneous monitor/upload requests serialize and the port is closed before upload begins.
- **AC-D19-02:** Cancel acknowledgement cannot produce a cancelled terminal state before termination is observed.
- **AC-D19-03:** Killing the owning process during upload causes unknown outcome and no automatic replay.
- **AC-D19-04:** Paths containing spaces, Unicode, and shell metacharacters reach the intended executable as literal arguments.
- **AC-D19-05:** A child that floods output cannot exhaust renderer or companion memory.
- **AC-D19-06:** Queued upload never substitutes a different build/device after preconditions change.

## Sources and gates

TASK-03's [implementation evidence](../verification/task-03.json) records the
Windows software coordinator: observed monitor-close handoff through fake serial,
real subprocess argument/flood/tree-stop checks, actual owner-process loss and
durable unknown/no-replay recovery. `operation.cancel` admission is audited before
abort and cannot reuse another operation's request ID. Shutdown attempts all owned
resource classes despite one stop-path failure. These tests do not establish real
USB/reset behavior; TASK-04 owns that bench evidence.

RESEARCH-RECORDED: [Node child processes](https://nodejs.org/api/child_process.html), [Arduino CLI integration](https://docs.arduino.cc/arduino-cli/integration-options), [VS Code task providers](https://code.visualstudio.com/api/extension-guides/task-provider). VALIDATION-GATE: process-tree termination, `.cmd` wrappers, serial release/reset behavior, and timings on the actual Windows setup. D31–D33 own tool-specific success detection.
