---
doc_id: D29
title: "Tool catalog and action policy"
status: implementation-spec
updated: 2026-11-04
depends_on: [D18, D19, D20, D26]
requirement_ids: [REQ-AGENT-29]
---

# Tool catalog and action policy

## Authority and conventions

**SPECIFIED:** domain tools expose deterministic robotics capabilities to both providers through one coordinator. REQ-AGENT-29: tool results MUST report real state, bounded observations and precise effects. These are proposed application tools, not built-in Codex/OpenCode methods. D18 owns the RPC envelope; vendor registration maps into this catalog.

Internal RPC methods use dotted names. MCP-visible names use underscores, for example `project_snapshot` maps to `project.snapshot`. Keep the mapping explicit in the adapter and test it. Every request includes schemaVersion, requestId, projectId, method and params; manifest mutations include expectedProjectRevision. `requestId` deduplicates receipt creation, not physical effects after an ambiguous crash.

## Initial catalog

| MCP name / RPC method | Required params beyond envelope | Effect and output |
|---|---|---|
| project_snapshot / project.snapshot | optional selection | Read bounded current snapshot, unknowns and evidence handles |
| component_inspect / component.inspect | componentId | Read definition, instance, pin aliases, code/document links |
| connections_query / connections.query | componentId or netId, cursor? | Read intended nets and scoped confirmations |
| build_compile / build.compile | sourceSnapshotId, targetId | Queue compile; return operationId, not success |
| build_diagnostics / build.diagnostics | buildId, cursor? | Read attributed diagnostics and full-log handle |
| device_status / device.status | deviceId? | Read observed connection, lease and last applicable operation |
| firmware_upload / firmware.upload | buildId, artifactId, artifactSha256, deviceId, expectedDeviceObservationId, fqbn, resumeMonitoring | Queue exact-artifact upload after preconditions and authorization |
| serial_capture / serial.capture | deviceId, durationMs, baudRate | Start bounded recording through lease coordinator |
| recording_query / recording.query | recordingId, channelIds?, range, cursor? | Read raw/derived samples with time basis and gap metadata |
| experiment_record / experiment.record | experimentId, expectedRevisionId, text, reason | Append an attributed agent observation/note; returns immutable run revision; cannot submit a judgment or rewrite evidence |
| operation_get / operation.get | operationId or original requestId | Read authoritative receipt within current project scope |
| operation_cancel / operation.cancel | operationId | Request cancellation; acknowledgement is not proof the effect stopped |

Every mutating result returns an operation reference with canonical status. Clients follow the operation receipt through existing event/query facilities defined in D18/D19. An upload request MUST resolve exact build target, device identity, current source/artifact validity and serial-port release. The manifest revision is checked separately from sourceSnapshotId and artifact digest.

## Method policy and deadlines

All catalog methods are available to authorized host clients and through the MCP mapping. Read methods (`project.snapshot`, `component.inspect`, `connections.query`, `build.diagnostics`, `device.status`, `recording.query`, `operation.get`) have a 10-second service deadline and never produce side effects. `build.compile`, `firmware.upload`, and `serial.capture` enqueue operations within a 5-second admission deadline; execution deadlines belong to the relevant adapter/job policy in D19, D31–D33 and D39. A transport timeout after admission is ambiguous: query the original requestId, never assume the operation was rejected. `operation.cancel` has a 5-second acknowledgement deadline and requires the same project/task authority as the target operation. It may return CANCEL_UNSUPPORTED. No user prompt is required merely to cancel an authorized task, but a physical action already in progress follows the adapter interruption policy. Both operation methods enforce project scope; knowing a UUID does not grant access.

The experiment outcome is `passed | failed | inconclusive` and is a scoped judgment supported by the procedure and evidence, not an operation status. Validate all references before creating the write receipt. Serial capture uses explicit durationMs and baudRate inside params; the tool adapter expands tested defaults for other framing options under D33.

## Bounds and response semantics

Default read bound is 100 records or 16 KiB UTF-8, whichever occurs first. Include `truncated`, `nextCursor`, `totalKnown` when available, and a durable artifact reference. Cursors bind to a fixed query/snapshot and expire explicitly; they must not drift into later live readings. Binary content is returned as authorized artifact references, not giant base64 prompt strings.

The serial MCP tool bound is 1–60 seconds per request, enforced in both the tool schema and runtime before authorization/dispatch. TASK-11 permits explicit native-host recording requests from 1 second through 60 minutes through the same coordinator; this does not expand autonomous tool authority. Continuous native capture does not reopen on a timer rollover. Capture may stop early on disconnect, cancellation, storage failure or external contention. The receipt records actual captured duration and gaps, not the requested duration as if fulfilled.

A read result includes projectRevision, observedAt where relevant, evidenceRefs and unknowns. An empty query is a successful query with zero matches; unavailable data is an error or explicit missing-data result. Errors use D18's `{code,message,retryable,details}` shape and safe recovery guidance. Never put full subprocess environments or secrets in details.

## Permission policy

Routine reads and compile operations may run under the user's configured trusted-workspace policy. Source edits remain governed by host/provider permissions and review behavior. Installing cores/libraries, changing external configuration and deleting artifacts require their separately defined scopes; they are not hidden side effects of a read or compile.

Upload authorization binds deviceId, artifact digest and task scope. A user may authorize a specific task's uploads without repeated prompts, but a changed target or artifact outside that scope requires a fresh policy decision. Generic serial-write/actuator tools are outside the initial catalog. Capture does not authorize transmitting arbitrary commands. An Uno may reset on serial open; disclose this behavior in readiness/operation UI and validate it locally.

The coordinator enforces its own lease, revision and authorization checks. Provider shell access can bypass this catalog if unrestricted; the product MUST not describe MCP alone as a complete sandbox. Configure supported provider permissions and display any bypass limitation rather than claiming impossible enforcement.

## Recovery rules

Read-only operations may retry with bounded backoff. Compile retries require unchanged source identity and an explicit retry policy. Uploads and physical effects MUST NOT auto-replay after uncertain delivery. Preserve terminal outcome-unknown receipts and append linked reconciliation evidence. A denied action returns a visible denial, not a queued receipt that can later execute unexpectedly.

## Acceptance criteria

- AC-D29-01: Every underscore name maps to exactly one tested dotted RPC method.
- AC-D29-02: A stale revision or wrong artifact hash blocks upload before device access.
- AC-D29-03: Oversized query responses remain bounded with working expansion handles.
- AC-D29-04: Repeated requestId returns the existing receipt without repeating its effect.
- AC-D29-05: A capture request cannot write an actuator command or install a dependency.
- AC-D29-06: Unknown upload outcome remains immutable after reconciliation.

## Sources and related documents

**RESEARCH-RECORDED:** [SWE-agent](https://arxiv.org/html/2405.15793v3) motivates informative, bounded tool interfaces; [MCP specification](https://modelcontextprotocol.io/specification) supplies protocol context, not these application names. See [RPC](internal-api-and-webview-protocol.md), [processes](jobs-and-process-supervision.md), [upload](device-discovery-and-upload.md), [serial](serial-monitor-and-telemetry.md).

TASK-09 adds read-only telemetry_query/telemetry.query and
telemetry_selection/telemetry.selection with exact derivation/channel/clock/range
references. experiment.record is a 5-second admitted metadata mutation with
request-ID replay protection and expectedRevisionId, returning its retained
revision directly. Native experiment.judge is not an agent tool; D39 owns its
pass/fail/inconclusive/not-evaluated domain meanings.

TASK-12 `diagnostics.preview` and `diagnostics.export` are trusted native-host
actions, absent from the provider tool definitions and name dispatcher. A provider
tool cannot invoke them or select an export destination. This boundary does not
constrain unrestricted external shell access. Diagnostic preview/export uses
sanitized immutable local snapshots and cannot authorize a hardware operation.
