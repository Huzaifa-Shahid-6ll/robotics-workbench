---
doc_id: D18
title: "Internal API and webview protocol"
status: implementation-spec
updated: 2026-11-04
depends_on: [D14, D20]
requirement_ids: [REQ-ARCH-02]
---

# Internal API and webview protocol

## Authority and boundary

**SPECIFIED:** This document defines the application's version-1 request, response, event, and method contracts. These are internal workbench interfaces, not Codex, OpenCode, Arduino, MCP, or VS Code vendor schemas. Adapters translate explicitly at each boundary. All inbound data is untrusted until runtime schema validation and authorization succeed.

Use UTF-8 JSON messages. Native host-to-companion transport is versioned local IPC; Windows named-pipe implementation and access controls require a validation spike. Webviews use the host's message mechanism. The extension proxies allowed methods rather than exposing the entire companion API to every renderer. Agent MCP tool names may differ, but their implementation calls these same use cases.

Executable structural authorities are [request](../contracts/request.schema.json), [response](../contracts/response.schema.json), [event](../contracts/event.schema.json), and [operation receipt](../contracts/operation.schema.json). Method-specific validation and authorization remain required after envelope validation.

## Envelopes

### Connection lifecycle (TASK-01 clarification, 2026-11-01)

Before any project exists, inherited parent/child Node IPC accepts only
`companion.hello` and `companion.shutdown`, validated by
[companion-control.schema.json](../contracts/companion-control.schema.json).
This separate control envelope contains schemaVersion, UUID requestId, method
and empty params. It has no projectId or projectRevision and cannot invoke any
project operation. Do not invent a project identity to check process readiness.
Responses use the standard response envelope with the method result validated by
[companion-result.schema.json](../contracts/companion-result.schema.json).
Hello returns the owned PID and observed runtime/platform/architecture; shutdown
acknowledges stopping, and completion requires observed process exit. Control
requests have a five-second deadline, the same 1 MiB limit, and maximum nesting
depth 16. Invalid requests with recoverable IDs return the existing error taxonomy;
invalid IDs are discarded. Inherited IPC is the only control transport; an
ownership-only Windows named pipe accepts no commands. No discovery endpoint,
public listener, provider connection, hardware action or project authority is
exposed by this lifecycle seam. Project envelopes below remain unchanged.

TASK-02 supplies a separate trusted project binding through the owning host's
process arguments (`--project-root` and `--data-root`). It enables only
`project.snapshot` and `operation.get` in the inherited IPC connection. The
authoritative manifest establishes project scope; payload UUIDs cannot change it.
Snapshots include the persisted epoch and sequence watermark. Receipt lookup
remains available when an already-bound manifest needs repair. Data-root paths
are canonicalized outside the project, and outbound envelopes are bounded too.
This binding is not a public discovery endpoint or hardware capability.

TASK-03 adds `device.status` and `operation.cancel` to that same binding. The
coordinator reconciles persisted interrupted work on startup without replay,
and cancellation returns the current receipt while termination is observed.
Shutdown attempts jobs, serial leases and owned processes even if one stop path
fails, preserving uncertainty instead of claiming cancellation. No renderer can
supply a shell command or bypass the coordinator through these methods.

```ts
// Proposed workbench types; not an external SDK declaration.
type Request = {
  schemaVersion: 1;
  requestId: string; // UUID; stable across transport retries of identical intent
  method: string;
  projectId: string; // UUID, validated against the connection's project scope
  expectedProjectRevision?: number;
  params: Record<string, unknown>; // method-specific schema validation required
};
type Response = {
  schemaVersion: 1;
  requestId: string;
} & ({ result: unknown } | { error: {
  code: string; message: string; retryable: boolean; details?: Record<string, unknown>;
}});
type Event = {
  schemaVersion: 1;
  eventId: string;
  sequence: number;
  projectId: string;
  projectRevision: number;
  operationId?: string;
  type: string;
  occurredAt: string; // UTC ISO 8601
  payload: Record<string, unknown>;
};
```

`result` and `error` are mutually exclusive. Errors never contain credentials, raw process environments, or unbounded stack traces. Message IDs and sequence numbers are not authorization. Invalid schemaVersion returns `UNSUPPORTED_SCHEMA` where a valid requestId can be recovered; otherwise reject the message without invoking a method.

## Minimum method registry

| Method | Required params | Result intent |
|---|---|---|
| `project.snapshot` | Optional selection, bounded inclusion options | Revision-stamped snapshot and sequence watermark |
| `component.inspect` | componentId | Definition, bindings, connections, provenance |
| `connections.query` | componentId or netId, limit/cursor | Bounded connection result |
| `build.compile` | targetId, sourceSnapshotId | operationId and current receipt |
| `build.diagnostics` | buildId, limit/cursor | Bounded diagnostic items and snapshot identity |
| `device.status` | Optional deviceId | Observed identities, leases, readiness |
| `firmware.upload` | buildId, artifactId, artifactSha256, deviceId, expectedDeviceObservationId, fqbn, resumeMonitoring | operationId; never immediate success by implication |
| `serial.capture` | deviceId, baudRate, capture options | operationId and recordingId when allocated |
| `recording.query` | recordingId, time basis/range, channels, limit | Bounded evidence window with gaps and provenance |
| `experiment.record` | Revision/artifact references, procedure, observations | operationId receipt; experimentId exposed only after durable success |
| `operation.get` | operationId or original requestId | Current authoritative receipt |
| `operation.cancel` | operationId | Cancellation request acknowledgement and current status |

Every method has a declared read/mutate/execute classification, scope, timeout, size limit, and permission policy in D29. Unknown methods fail closed. A request may not supply an arbitrary shell string. Long-running operations return receipts; clients observe progress via events or `operation.get`.

## TASK-04 enabled companion methods — 2026-11-02

**IMPLEMENTED:** These methods use the existing inherited IPC and trusted
project binding. The owning host additionally supplies an installed Arduino
executable path; the companion resolves the bundled native serial dependency
under its installed `dist/vendor` directory. Neither path is a request parameter.
The companion exposes no public hardware listener or unrestricted shell method.

| Method | Classification; input | Current result |
|---|---|---|
| `toolchain.inspect` | Read; empty params | CLI/configuration/core/library identity and enabled capabilities |
| `device.discover` | Read; empty params | Persisted observations and coordinator device snapshots |
| `device.select` | Mutate; deviceId, expectedDeviceObservationId | Explicit reported association and updated observation |
| `project.prepareBuild` | Mutate; expectedProjectRevision, targetId, documentHashes | Immutable sourceSnapshotId and manifestSha256 |
| `project.context` | Read; empty params | Application snapshot text capped at 24576 UTF-8 bytes |
| `build.compile` | Execute; expectedProjectRevision, targetId, sourceSnapshotId | Durable operation receipt; build identity after execution |
| `build.diagnostics` | Read; buildId | Snapshot-linked items and sourceCurrent applicability |
| `firmware.upload` | Execute; revision and exact artifact/device assertions above | Durable upload operation; no success from acknowledgement |
| `serial.capture` | Execute; deviceId, baudRate, durationMs | Durable operation; terminal result references retained recording |
| `recording.query` | Read; recordingId, host-receive range, limit/cursor | Exact bytesBase64 page, text preview, gaps and continuation |

`expectedProjectRevision` remains in the request envelope, including preparation,
compilation and upload. `documentHashes` contains project-relative path/SHA256
preconditions from the owning editor; it cannot substitute unsaved visible text
for a saved source snapshot. `project.snapshot` includes bounded build summaries
with operationId so a failed compile's retained diagnostics can be found even
when its operation failed without a successful result payload.

`recording.query` returns at most 4096 decoded bytes per page, at most 16 gaps and
an explicit omittedGaps count. Its cursor binds the recording and interval,
including an intra-frame byte offset, so arbitrary binary data can be expanded
exactly. The text field is a page preview; reconstruct continuous text from the
exact base64 bytes. Parsed channels and device/relative time requests are
explicitly refused in this raw-only increment. This bounded byte window does
not permit embedding entire recordings in general control messages.

The context snapshot contains application-owned current facts and explicit
unknown physical claims, with old optional records omitted when necessary to
fit 24 KiB. The native context command exposes the snapshot for inspection;
the agent command supplies it to the existing Codex terminal as literal arguments.
It does not assert access to private provider history.
Method-specific validation/deadlines live in
[the v1 contract implementation](../packages/contracts/src/project.ts), with
effects composed in [HardwareService](../apps/companion/src/hardware-service.ts).
Physical acceptance remains governed by [TASK-04 evidence](../tasks/TASK-04.md).

## Preconditions and deduplication

TASK-06 adds a version-1 bounded view state and typed intent contract in
`packages/contracts/src/views.ts`, with runtime validators at both view/host
boundaries. The renderer cannot forward arbitrary RPC, launch tools, navigate
arbitrary paths, or receive provider credentials. Each intent freezes its task,
selection and pin scope before asynchronous host work. Hidden/destroyed views
stop polling and restore authoritative records without replaying turns.

`review.save` and `review.load` retain validated, bounded source-review snapshots
as immutable content artifacts with an append-only SQLite index. Source remains
in ordinary files. `artifact.preview` returns an authorized UTF-8 preview capped
at 64 KiB; binary data is refused. Snapshot shape, text digests, project/task
identity, portable paths, and credential exclusion are checked before persistence.
Changes first observed during a task have unverified writer attribution. Revert
shows the retained diff, requires confirmation of the exact file and hashes,
then rechecks saved and editor state; interleaved user changes remain conflicted.
Keeping edits never refreshes an older source snapshot or authorizes upload.

Pin policy affects only later context packets. Retained historical evidence stays
historical, and unavailable pins are disclosed. Handoff includes bounded
application-owned goals, checks, operations and unknowns in a new session, without
claiming private provider history transferred. A window with project ownership
refuses a different project binding; background polling cannot stop or retarget
another project's work. Full multi-window sharing remains unimplemented.

TASK-05 adds schema-version-1 host methods `agent.inspect`, `agent.start`,
`agent.get`, `agent.list`, `agent.interrupt`, `agent.reconcile`, `agent.approval`,
`agent.authorizeUpload`, and `agent.handoff`. Their exact parameter schemas and
deadlines are in the contract implementation. A task is admitted durably before
turn submission; repeated task IDs must retain identical user/provider/model,
source/selection and permission inputs. Reconnection observes or reconciles,
never replays a prompt. Task records/checkpoints append immutable SQLite rows.

The stdio MCP server uses the pinned official SDK and forwards the twelve D29
names through a loopback-only, random-token bridge bound to one task. Provider
webviews receive neither server credentials nor direct provider endpoints.
Responses are checked for recognizable credentials, capped at 16 KiB, and
retain oversized results as scoped artifacts. Read annotations describe actual
read methods; they do not grant coordinator authority. Compile/capture/upload
admissions link their operation receipts to the exact originating task; reading
another receipt does not grant cancellation authority. Three identical tool
admission failures pause further effects for replanning.

Firmware tool authorization requires a trusted-host `agent.authorizeUpload`
grant matching the active task, manifest revision, full upload parameters,
device observation and exact artifact digest. It is never granted by source
acceptance, provider prose, or a tool argument. Device/build/artifact preflight
still runs through the existing coordinator. Experiment writes remain explicitly
unsupported until TASK-09 supplies procedure/evidence semantics.

Provider capability/authentication failures remain visible; no billing route is
chosen automatically. Codex is pinned to 0.160.1 and OpenCode/SDK to 1.18.32 with
their recorded schema fingerprints. Images/attachments remain unavailable until
validated for a model. Local service controls do not sandbox unrestricted shells.

Design mutations require expectedProjectRevision. Other consequential operations bind their own exact artifacts/source snapshots and check applicable project revision where intent depends on it. A requestId is recorded with normalized payload digest before execution. Repeating the same ID and same payload returns the existing receipt. Reusing an ID with different payload fails `REQUEST_ID_CONFLICT`.

Deduplication does not make hardware effects repeatable. After a lost response, query the receipt. An `outcome-unknown` upload is never automatically retried. Cancellation is a request, not proof that an external side effect stopped. A terminal receipt never changes. Reconciliation produces a new receipt linked by reconcilesOperationId, preserving the original result and events.

## Design methods

TASK-07 adds `wiring.snapshot`, `wiring.plan`, `wiring.check`, `wiring.accept` and
`wiring.observe`. Snapshot supplies the manifest, exact byte digest, catalog
choices, pins, versioned rules, report applicability and layout sidecar state.
Plan requires expectedProjectRevision and expectedManifestSha256. It writes no
source and returns a bounded preview ID, old/new intent and inverse operations.
The trusted native host retains source review, applies/saves the exact plan and
checks source and catalog again through `wiring.check`, then calls accept with
the resulting revision and byte digest. Accept independently reloads catalog,
checks saved intent and appends immutable migration history; a duplicate preview
with identical resulting bytes returns its original record. Source remains the
ordinary manifest even when history recording fails; no automatic revert occurs.

Wiring frame version1 actions are closed and project-scoped. The frame cannot
send arbitrary RPC, filesystem paths, inverse-only restoration operations or
observation evidence directly. Report evidence is collected in native dialogs
and recorded as `reported`, never upgraded to `measured`. Selection and Ask bind
stable IDs/revision; Ask never submits a provider turn. Renderer scripts use a
nonce CSP and local bundles only, with no network access. React Flow uses inline
style attributes for bounded geometry; it does not receive command URIs.

## Error taxonomy

Required codes: `INVALID_REQUEST`, `UNSUPPORTED_SCHEMA`, `UNKNOWN_METHOD`, `UNAUTHORIZED_SCOPE`, `WORKSPACE_UNTRUSTED`, `REVISION_CONFLICT`, `REQUEST_ID_CONFLICT`, `NOT_FOUND`, `TOOL_UNAVAILABLE`, `UNSUPPORTED_ENVIRONMENT`, `DEVICE_BUSY`, `TARGET_AMBIGUOUS`, `ARTIFACT_MISMATCH`, `TIMEOUT`, `CANCEL_UNSUPPORTED`, `OUTCOME_UNKNOWN`, and `INTERNAL_ERROR`. Adapters may add namespaced detail codes without replacing the stable category.

`retryable` means a retry may be appropriate after stated conditions; it never instructs blind replay of a physical action. Details may include current revision, missing tool, or owner operationId. Human messages describe a recovery action without claiming it has happened.

## Limits and rendering safety

Initial SPECIFIED envelope limit is 1 MiB per control message; larger artifacts use opaque handles and bounded read windows. Default query page limit is 100 records, maximum 500 unless a method-specific smaller cap applies. Reject excessive nesting and malformed strings using validator limits. Do not put base64 recordings or entire datasheets in ordinary event payloads. These are initial budgets, measured and adjusted under D07.

The extension validates renderer origin/view ownership and allowed method scope. Content Security Policy and local-resource roots constrain rendering but do not replace method authorization. Escape displayed error/model/serial text. Untrusted SVG previews must be sanitized or rendered through a non-script execution path.

## Acceptance criteria

- **AC-D18-01:** Schema tests reject messages with both result and error, invalid IDs, unknown methods, or oversized payloads.
- **AC-D18-02:** Duplicate identical upload request returns one operation; changed payload with same ID is rejected.
- **AC-D18-03:** A renderer scoped to project A cannot query or mutate project B.
- **AC-D18-04:** Lost response followed by `operation.get` resolves the existing receipt without resubmission.
- **AC-D18-05:** Tool output containing script markup renders inertly.

## Sources

SOURCE-VERIFIED 2026-11-01 through Context7: [VS Code webview messaging and security](https://code.visualstudio.com/api/extension-guides/webview). RESEARCH-RECORDED: [MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports). Internal envelope and method names are project choices; external protocol compatibility is owned by D22–D24 and D29.

## TASK-08 document protocol additions — 2026-11-03

The v1 request envelope now admits document.list/query/excerpt/expand/page/original
(read), document.ingest (execute) and document.rebuild (mutate). Ingest requires
expectedProjectRevision, declared documentId and expectedSha256; it returns a
coordinator receipt, never a success inferred from enqueue. Identical request IDs
return their original receipt even after the source/revision changes; changed
intent conflicts. The host-only ingest boundary does not accept arbitrary paths,
URLs or extraction commands. Agent tools expose only bounded query/excerpt/expand.

Citations require documentId, artifactSha256, extractorVersion and physical page,
with either a normalized region or exact UTF-16 page textRange when applicable.
Source lookup never substitutes the latest document. The S11 frame sends typed
intents with project/request IDs; the native host validates both intents and state.
PNG data is isolated under a no-network/no-frame CSP.

## TASK-09 telemetry and experiment protocol — 2026-11-03

The v1 envelope adds telemetry.snapshot/inspect/live/query/selection/exportSelection
(read), telemetry.derive (queued heavy execution) and telemetry.stopCapture
(mutation through the same capture cancellation coordinator). Experiment native
methods create/transition/attach/note/segment/judge use current manifest revision
and immutable expectedRevisionId preconditions; compare/export are read-only.
Durable request results prevent metadata replays; uncertain interrupted admission
is reconciled rather than repeated. Stop capture does not imply motors stopped.

The frame supplies scoped IDs/intents, never storage paths, actor identities or
executable commands. Agent catalog telemetry queries are read-only; its existing
experiment.record method is now attributed note-only and cannot submit a pass.
Judgment is a separate trusted-host route. Control of unrestricted external shell
access remains outside this facade.

## TASK-10 native engineering protocol — 2026-11-03

The v1 request envelope adds kicad.snapshot/preview and cad.snapshot/export/viewer
reads; kicad.generate/validate and cad.generate return queued coordinator receipts.
KiCad native export is a revision-checked mutation that creates a new directory.
Every engineering mutation/execution requires expectedProjectRevision. Generation
also checks exact source/manifest hashes or CAD input fingerprint. Duplicate request
IDs identify the original durable intent; changed payloads conflict. A queue receipt
is not a validated schematic or model. KiCad ERC verdict remains separate from
process status, including completed checks reporting violations.

Engineering webviews send strict typed intents; native host mediates file pickers,
dirty-buffer checks, review and exact-byte export. Source/provider changes during
dialogs are rechecked before writing. Optional feature failures are isolated, so
invalid CAD inputs do not discard schematic evidence. SVG previews are isolated
images with no active content or network access; model display uses an explicit
existing-viewer handoff. No Python or native GUI command comes from a frame.

## TASK-11 recovery protocol — 2026-11-04

The v1 envelope adds recovery.inspect (read, epoch/watermark-bound pages capped at
100 summaries and 12 KiB), project.export/project.restore (trusted-host mutations,
120-second deadlines) and device.reconcile (trusted-host mutation). These methods
are absent from provider tools and renderer allowlists. Archive paths come from
explicit native-host selection; source saves preserve conflicting editor/provider
versions. Export requires current projectRevision, exact manifest digest and
observed saved-document hashes. Restore publishes only into independent empty
project/data directories and never selects a device or replays an operation.

Device reconciliation requires a particular unknown upload, current identified
device observation, an explicit operator note and confirmation that the external
uploader has terminated. The coordinator also refuses active owned jobs,
processes and serial handles. It appends acknowledgement; the original upload
remains outcome-unknown and firmware remains unknown. A later upload is a separate
explicit action with a fresh target/artifact preflight.

review.relocation is a bounded read of retained archive-origin proof and the exact
historical review-artifact identity. Rebinding requires explicit native confirmation,
unchanged retained file hashes and clean matching editor buffers, rechecked after
the dialog. A new review snapshot is appended; source and prior evidence survive.

## TASK-11 continuous native capture

The trusted native `serial.capture` request accepts `durationMs` from 1,000
through 3,600,000 (one second through one hour). This permits an explicit
continuous recording while a physical recovery step is pending. The same
coordinator, byte caps, disconnect handling and Stop/cancel semantics apply.
Admitting a duration does not guarantee that period will be captured. Timer
rollover never automatically reopens the port.

The MCP `serial_capture` input schema and runtime admission retain a separate
1,000–60,000 ms limit. Longer duration is native-host capability, not expanded
agent authority. Both bounds are tested independently before dispatch.

## TASK-12 diagnostic export

The v1 envelope adds host-only `diagnostics.preview` (read, 10-second deadline,
empty params) and `diagnostics.export` (mutation, 10-second deadline, required
expectedProjectRevision). Preview returns schemaVersion, previewId, projectId,
projectRevision, createdAt, bundleSha256, byteLength and exact JSON text, bounded
to 64 KiB. It retains a sanitized immutable artifact and dedicated operational
preview record, bound to the project root, saved manifest and revision.

Export accepts only previewId, expectedBundleSha256 and an absolute local
destination. It verifies the dedicated preview provenance and exact reviewed
bytes; arbitrary artifact export is refused. It publishes a new JSON file outside
project and operational-data roots, preserving existing files. A lost/incomplete
export result is inspected rather than replayed. Historical tool versions remain
explicitly distinct from current readiness. No private-content opt-in parameter
exists. The native command opens a read-only preview; its nonmodal Save action
leaves the preview readable before the file picker. These methods are absent
from the provider tool catalog.
