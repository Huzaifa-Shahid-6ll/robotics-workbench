---
doc_id: D16
title: "Storage and migrations"
status: implementation-spec
updated: 2026-11-04
depends_on: [D14, D15]
requirement_ids: [REQ-ARCH-01, REQ-ARCH-03]
---

# Storage and migrations

## Authority and storage classes

**SPECIFIED:** This document owns persistence, schema migration, backup, and recovery rules. SQLite is operational storage, not the authoritative editor for design intent. The first implementation uses one companion-owned database for the user, with projectId on project-scoped records. The configurable data root is outside project repositories. Never place an active database on a network share.

| Data | Authority | Recovery |
|---|---|---|
| Source, CAD scripts, native schematics | Ordinary files and host documents | User backups/version control; preserve dirty conflicts |
| Intended components/nets | `workbench.json` | Restore authoritative manifest, then rebuild projections |
| Operations, sessions, uploads, judgments | SQLite | Valid database snapshot plus recorded recovery intent |
| Binaries, raw captures, source snapshots | Immutable artifact files | Verify SHA-256; report missing bytes explicitly |
| Search indexes/thumbnails | Derived cache | Rebuild from authority |
| Provider credentials | Provider-managed storage or approved SecretStorage | Reauthenticate; never restore from project export |

A database transaction cannot atomically include a filesystem replacement or hardware upload. Record intent before side effects and completion afterward; reconciliation owns the gap. Do not represent the whole system as event-sourced or introduce a separate broker.

## Initial tables and invariants

Required logical tables are `projects`, `operations`, `operation_events`, `sessions`, `artifacts`, `source_snapshots`, `builds`, `uploads`, `recordings`, `experiments`, `observations`, `schema_migrations`, and derived `file_index`. The schema implementation may normalize fields further but must preserve these identities and relationships. Each row with project-specific meaning has projectId. Artifact metadata includes artifactId, hash algorithm/digest, sizeBytes, relative storage locator, media type, creation timestamp, and producing operationId where applicable.

Operations persist current status and audit transition in one short transaction. Foreign keys are explicitly enabled and verified per connection. Serialize writes through the companion. Use WAL only after the actual SQLite binding and shutdown/backup behavior are tested; concurrent reads do not imply concurrent writers. Apply bounded busy timeouts and report sustained contention; never spin indefinitely.

Source snapshots contain a sorted inventory of exact input paths and digests. Build records reference that inventory and the toolchain fingerprint, not just a Git commit. Uploads reference the exact produced binary digest. Observation and experiment rows never mutate old evidence to match a newer project revision.

## Artifact commit protocol

1. Create an operation-scoped temporary artifact under the data root.
2. Write bytes, track errors and size, close successfully, and compute/verify SHA-256.
3. Move to the immutable artifact location on the same filesystem using the tested platform path.
4. Register metadata and operation relation transactionally.
5. On startup, quarantine unregistered final files and incomplete temporary files; do not fabricate their producing operation.

A content-addressed location may deduplicate identical bytes while distinct artifact records retain provenance. Database registration and rename are not universally atomic together. Recovery MUST handle crashes before and after either step. Existing immutable bytes must never be overwritten with different content.

## Migration protocol

Number migrations monotonically and store each checksum. Before an upgrade, acquire exclusive migration ownership, stop new jobs, close active captures safely, and create a valid database snapshot. Run compatible migrations transactionally where SQLite supports the requested operations; document any multi-step migration recovery. Record applied version and checksum only after success. A database from a newer unsupported schema opens in a protective unsupported state, not an attempted downgrade.

Migration failure restores normal startup only after the old snapshot or verified partial-state recovery is selected. Never delete the database to “fix” a migration. Derived indexes may be discarded separately from history. Every migration includes fixtures for the previous supported schema and a rollback/recovery test.

## Backup, export, retention

Use the SQLite backup mechanism supported by the selected binding, or a tested `VACUUM INTO` workflow. Copying only the main file while WAL is active is not a valid backup procedure. A full-project export freezes a manifest/source inventory and a database snapshot watermark; finalized artifact references at or before that watermark are included. An active capture is either finalized first or excluded with a visible note. Validate each included digest and write a checksum inventory.

Default retention preserves completed evidence until explicit deletion; caches have bounded configurable limits. Disk-full detection stops capture with a recorded gap/failure and protects already finalized artifacts. Deletion checks references, offers the stated scope, and never removes historical records merely because their cache is missing. Garbage collection cleans only unreachable finalized artifacts after a recoverable grace period.

## Acceptance criteria

- **AC-D16-01:** Crash injection at every artifact-commit step produces either a verified artifact or explicit recoverable orphan/incomplete state.
- **AC-D16-02:** A failed migration preserves the previous usable snapshot and history.
- **AC-D16-03:** Backup during normal service activity restores to a consistent documented watermark.
- **AC-D16-04:** Deleting a search index rebuilds it without erasing experiments.
- **AC-D16-05:** Disk-full capture preserves prior bytes and reports lost/incomplete data without claiming a complete recording.

## Sources and gates

TASK-02 implements this boundary through Node 24.18's built-in SQLite with DELETE
journaling, foreign keys, a bounded busy timeout and FULL synchronization. Tested
`VACUUM INTO` snapshots, failed migrations, artifact process-kill recovery and
single-project archive/restore are recorded in
[TASK-02 evidence](../verification/task-02.json). WAL is not enabled. This is core
persistence evidence, separate from future live recording/disk-full tests.

TASK-11 extends full-project archives to ordinary engineering files, portable
operational history and all finalized artifact bytes. Private source paths stay
excluded and included bytes/history are scanned for credential patterns. Exports
refuse active operations; staged publication prevents an incomplete archive from
appearing successful. Restores validate before publishing independent empty roots,
retain publication failures for inspection and append immutable relocation origin.
Source restoration never establishes current firmware, wiring or device identity.
These are implementation rules; the current [TASK-11 record](../tasks/TASK-11.md)
tracks which recovery/release checks actually passed.

TASK-12 diagnostic previews are derived immutable artifacts with dedicated
`diagnostic-preview` observations. A preview binds its artifact digest, project,
root binding, revision and manifest hash. `diagnostic-export` observations retain
the attributable published-file result; they do not alter source, device facts or
hardware operation states. Existing request admission supplies deduplication and
uncertain-result handling. The existing operational schema is reused, without a
new editable authority or database migration. Default diagnostic text excludes
private payloads, paths and raw error/log prose.

RESEARCH-RECORDED primary references: [SQLite uses](https://sqlite.org/whentouse.html), [WAL](https://sqlite.org/wal.html), [foreign keys](https://sqlite.org/foreignkeys.html), [backup API](https://sqlite.org/backup.html). VALIDATION-GATE: select and pin the SQLite binding, verify native packaging on Windows, test its backup/checkpoint behavior, and measure database recovery. No binding-specific code is asserted here.
