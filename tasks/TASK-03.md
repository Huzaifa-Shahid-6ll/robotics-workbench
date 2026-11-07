# TASK-03 — Process and device coordinator

Started 2026-11-02 after TASK-02 completion/checkpoint 8b57fa4.
Status: done for the software coordinator packet. Integration owner: root.

Owning documents: D19/D20/D32/D33; shared contracts D14/D18 and persistence D16.
Requirements: REQ-ARCH-03, REQ-ARCH-04, REQ-ARCH-05, REQ-AGENT-06.
Acceptance: AC-D19-01 through AC-D19-06. Validation: VG-13 and VG-14
(software/single-owner scope; real external-port/USB portions belong to TASK-04).

Three new agents: task03_devices owns packages/devices and coordinator tests;
task03_jobs owns application/jobs and process-supervision tests;
task03_faults owns test-fixtures/devices and cross-module failure tests.
Root owns companion/client integration, workspace/build wiring and evidence.
No agent changes shared statuses or hardware semantics independently.

Expected changes: packages/devices, packages/application/jobs,
packages/test-fixtures/devices, apps/companion, affected lifecycle tests,
configuration, task index and verification. No physical device open/upload yet.

Planned checks: real argument/flood/cancellation subprocesses, delayed serial-close
fake transport, monitor/upload exclusion, duplicate requests, queued target change,
lost process unknown outcome and no replay, owner refusal, shutdown cleanup,
packaged host regression. Cancellation acknowledgement must not precede observed
termination as a terminal receipt. External applications remain outside the lease.

Vendor evidence: Context7 Node 24 spawn/close semantics retrieved 2026-11-02;
Windows process-tree behavior must be observed in the task's executable tests.

Implemented: durable queued admission and exact-request deduplication; cancellation
audit shares the same request-ID namespace; heavy-job serialization; dequeue
revision/target revalidation; bounded process output and durable capped logs;
literal arguments; observed root/tree termination on Windows; shared monitoring
and actual-close handoff; unknown-outcome port reservation; explicit reconciliation;
startup no-replay; and shutdown attempts for every owned resource.

Executed: `npm run verify:task -- TASK-03` passed documentation/contracts,
strict checks/boundaries, all software/real-process tests, inspected VSIX packaging
and installed trusted/restricted host checks. Earlier incremental package mismatch
and verification-wrapper failure are retained in verification/history. Three
implementation agents also reviewed cross-module behavior; found defects have
passing regressions. [Completion evidence](../verification/task-03.json) records
actual changed files, commands, timestamps and log hashes.

Limits: fake serial fixtures establish modeled behavior, not Windows USB success.
VG-14's real external-monitor portion remains TASK-04 work. Batch wrappers are
rejected. Arbitrarily detached descendants after natural parent exit require
stronger OS containment; no sandbox claim is made. One companion owns cooperating
clients, and unrelated applications can still contend for a real port. G6 remains
unvalidated.
