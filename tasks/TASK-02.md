# TASK-02 — Domain contracts and persistence

Started 2026-11-02. Status: done for the TASK-02 packet. Integration owner: root agent.

Owning documents: D14–D18; D13/D20/D27 govern file/trust/freshness boundaries,
D02/D06/D12/D48/D50 govern implementation and evidence.
Requirements: REQ-ARCH-01, REQ-ARCH-02, REQ-ARCH-03, REQ-ARCH-05,
REQ-ARCH-06, REQ-PROD-01, REQ-PROD-05.
Acceptance: AC-D16-01, AC-D16-02, AC-D16-04, AC-D18-01, AC-D18-02.
Validation gates produced by this task: VG-13 and VG-15. No prerequisite gate.

User authorized three sequential tasks with at least three sub-agents per task.
TASK-02 ownership: task02_contracts owns contracts/domain; task02_persistence owns
persistence/artifacts; task02_files owns application file/snapshot boundary.
Root owns composition, workspace/build/test configuration, evidence and integration.
Shared contract is v1 D14/D18/D19; ordinary files own source/design intent,
SQLite owns operational records and immutable bytes own retained evidence.

Expected files: packages/contracts, packages/domain, packages/application,
packages/persistence, apps/companion, scripts, workspace configuration, tasks and
verification. Existing lifecycle IPC must remain valid and board-free.

Verification planned: structural and semantic validation; stale revision/content
rejection; deduplication; cross-project denial; terminal immutability; actual SQLite
reopen, failed migration backup, artifact commit fault injection, orphan recovery,
consistent snapshot/restore and credential exclusion; host/package regression.
No hardware action, new provider turn, global install or toolchain upgrade.

Executed baseline: document/contract validation passed before implementation.
Current Node runtime is inspected before relying on the prior compatibility result.
Vendor documentation: Context7 Node 24 SQLite connection/backup API, retrieved
2026-11-02. Installed Node 24.18 behavior and types remain the executable check.

Implementation includes all three owned modules, a project-bound companion seam,
typed client queries and installed-host persistence smoke coverage. The packet's
write scope was expanded to these shared integration/configuration/evidence files;
no separate feature or hardware capability was added. Three agents plus the root
integrator implemented and reviewed the same v1 contracts.

Additional recovery evidence kills a real owned process at temporary creation,
write completion, immutable publication and registration. Synthetic upload
receipts become immutable `outcome-unknown`; no physical device participates.
Archive tests move the original directories away and restore ordinary files,
evidence, references and identity to new paths. Failed checks are retained under
verification/history and versioned evidence directories, not erased by retries.

Bounded limitations: single-project operational database exports; 64 MiB per
source file / 256 MiB per source snapshot; an arbitrary external filesystem writer
cannot participate in an atomic host/file/SQLite transaction. Detected conflicts
preserve current/proposed/previous bytes. Failed archive restore can retain named
staging directories for recovery. Secret detection rejects declared credential
fields and recognizable formats and cannot recognize every arbitrary secret.

Final verification: `npm run verify:task -- TASK-02` passed documentation/contracts,
strict TypeScript/dependency boundaries, deterministic and real-process recovery
tests, inspected VSIX packaging, and installed trusted/restricted VS Code tests.
The installed companion opened SQLite and returned the authorized project snapshot.
See [machine-readable completion](../verification/task-02.json) for commands,
timestamps, actual changed files and hashed logs. An earlier failed integration
run is retained in verification/history. VG-13 and VG-15 pass only within this
software/project-archive scope. G1 still needs TASK-03; G6 remains unvalidated.
