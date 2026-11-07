# TASK-08 — Documents and diagnostics

Started 2026-11-03. Status: done for the scoped G5 task. Integration owner: root.
Depends on completed TASK-02. Gate G5; validation VG-12.

Owning documents: D31,D38,D43–D46; D13,D14,D16,D18,D20,D26,D27 govern
host, identity, storage, protocol, trust and evidence. D48/D50 own completion.
Requirements: REQ-HW-31-01, REQ-HW-38-01, REQ-UX-43..47, REQ-ARCH-50.
All fifty project documents are divided among the three task agents for reading.

Exclusive ownership: task08_extract owns document contract/extraction/fixtures;
task08_retrieval owns application retrieval and SQLite document persistence;
task08_view owns S11 renderer/protocol/browser checks. Root owns integration,
Arduino language-service host, companion/tool boundary, config/build/package,
native tests, task status, traceability and retained evidence. Shared IDs and
operation states remain v1. No source conversion or toolchain upgrade.

Expected files: packages/adapters/documents, packages/application/src/documents,
packages/persistence, packages/contracts/src/documents.ts, packages/webviews,
apps/extension, apps/companion, contracts/protocol schemas, bounded fixtures,
scripts, tasks and verification.

Planned checks (not yet executed): digital/rotated/printed-label/image-only PDF
anchors; immutable originals/version history/dedup and FTS5 rebuild; malformed,
encrypted, oversized and timeout failure paths; no document-triggered actions;
bounded retrieval and exact historical citation; original-page preview; multi-file
Arduino language diagnostics and dirty-buffer/staleness preservation; strict frame
validation; keyboard/theme/narrow layout; full software, VSIX and installed host.

Reference lock: D41/D42 host-native compact workspace, Cursor spacing only,
Attio metadata/dividers only, Missive PDF navigation/page prominence only.
Existing fonts/theme, 4px controls and 12px padding remain authoritative.

C: has limited free space. Task-local TEMP/TMP/npm cache and test profiles remain
under ignored artifacts on G:. No unrelated user data is deleted.

Completed 2026-11-03. Documentation/contracts, TypeScript/boundaries, full software
suite, VSIX inspection and installed trusted/restricted hosts passed. Production
browser QA passed 16 checks and 5 screenshots. Actual installed language tools
reported correct multi-file locations and unsaved-buffer updates, left all source
bytes unchanged, and closed owned processes. Native document tests preserved
user/provider edits, exact historical hashes and selected regions. See
verification/task-08.json for commands, hashes, failure history and limitations.
No physical hardware, OCR/fact promotion, Windows screen-reader or G6 release
claim is made.
