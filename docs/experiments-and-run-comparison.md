---
doc_id: D39
title: "Experiments and run comparison"
status: implementation-spec
updated: 2026-11-01
depends_on: [D14, D16, D27, D33, D40]
requirement_ids: [REQ-HW-39-01]
---

# Experiments and run comparison

## Purpose and authority

**SPECIFIED — REQ-HW-39-01:** An experiment is an evidence-linked procedure executed against a known or explicitly uncertain project/device state. Store enough provenance to explain what was tested and compare runs honestly. The experiment view borrows the approved Weights & Biases layout pattern, but this is a local workbench data model, not a dependency on that service.

A successful upload, available plot, or confident agent explanation is not a passing experiment. D39 owns run records, result judgments, reproducibility, and comparisons. D33 owns raw capture and clock semantics; D40 owns physical test procedures and release evidence.

## Procedure and run identity

A versioned procedure defines purpose, required setup, controlled inputs, instruments, steps, expected outputs, tolerances, stop conditions, and decision rules before a run. It may include manual steps and observations. A run is persisted as an experiment record with stable experimentId and references one procedure version, projectId/projectRevision, sourceSnapshotId, build/artifact/upload receipts when known, device identity observation, connection sessions, recordings, parameter values/units, and environment notes.

Example application fragment:

```json
{
  "experimentId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "procedureId": "ffffffff-ffff-4fff-8fff-ffffffffffff",
  "procedureVersion": 1,
  "projectId": "11111111-1111-4111-8111-111111111111",
  "projectRevision": 12,
  "buildId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "uploadOperationId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  "deviceId": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  "recordingIds": ["44444444-4444-4444-8444-444444444444"],
  "referenceMeasurement": {"value": 200, "unit": "mm", "method": "manual-ruler"},
  "outcome": "not-evaluated",
  "limitations": ["Actual sensor module identity unresolved"]
}
```

These values illustrate schema only; they are not observed measurements. A missing build/upload association is explicit `null` with a reason, never filled from the most recent unrelated upload. Measurements are observations with method and uncertainty; test judgments additionally specify criteria, evaluator, applicable revision, and evidence.

## Lifecycle and immutability

Run lifecycle is `draft`, `ready`, `running`, `completed`, `aborted`, or `interrupted`. This is domain lifecycle, separate from the canonical operation-status enum. Judgment outcome is `pass`, `fail`, `inconclusive`, or `not-evaluated`. A completed acquisition may be inconclusive because reference data or units are missing. An interrupted run retains partial evidence and can be analyzed, but does not silently resume under the same conditions.

Freeze the procedure/version and declared configuration when starting. If parameters or wiring change during a run, create an explicit segment/change event and normally mark the run non-comparable for whole-run metrics. Preserve raw evidence immutably. Notes may be appended; corrections create revisions with author/time/reason rather than rewriting original observations. Regenerating parsed channels or statistics creates a new derivation with code/parser version and references.

## Deterministic metrics and comparisons

Compute statistics in deterministic code, never by asking a language model to estimate a plotted line. Each metric definition specifies inputs, units, time window, missing-data handling, filters, formula version, and uncertainty where applicable. For example, range error requires a compatible reference measurement; no reference means no accuracy metric. PID overshoot/settling metrics require explicit target, sign convention, sampling adequacy, thresholds, and window, not generic chart labels.

Before overlay, compare channel meanings, units, time basis, parser versions, procedure versions, and relevant hardware/firmware differences. Permit exploratory overlays with visible incompatibility warnings, but block a formal “improved” conclusion when a required comparison condition fails. Conversion between compatible units is explicit and preserves originals. Never align different device clocks without a stated mapping. Host receive time and sensor acquisition time remain distinct.

Selections freeze recording IDs, channel IDs, derivation versions, clock basis, and interval boundaries. The agent receives these exact references plus deterministic summaries and gaps. It may propose interpretations and follow-up tests; it cannot mark a run verified without evidence satisfying the procedure. Compare hypotheses separately from observed outcomes.

## Storage, export, and recovery

Run metadata lives in SQLite operational records with exportable JSON manifests; large raw/derived artifacts remain hashed files. Export includes procedure, parameters, source/build identities, relevant records, metric definitions/results, and unresolved dependencies. Credentials and unrelated private files are excluded. Reopening an export must show the same evidence even without a connected board or agent account.

On application crash, reconcile active recordings and mark unfinished runs `interrupted`. Do not restart a motor action, upload, or capture automatically just to finish a test. Missing/corrupt artifacts produce an incomplete-evidence status, not silent omission. Deleting a recording referenced by retained runs requires explicit dependency-aware handling; a cache cleanup cannot delete experiment evidence.

## Acceptance criteria

- **AC-D39-01:** Every result links to exact procedure, revision, device observation, and retained evidence or explicit unknowns.
- **AC-D39-02:** The same deterministic metric/version over identical data produces the same result.
- **AC-D39-03:** Unit/time/procedure incompatibilities remain visible and prevent unsupported improvement claims.
- **AC-D39-04:** Crash preserves partial evidence and marks the run interrupted without replaying physical actions.
- **AC-D39-05:** Export/reopen reproduces run metadata, metrics, and raw-evidence references offline.
- **AC-D39-06:** Agent assertions alone cannot create passing judgments.

## Sources and related documents

- [uPlot data documentation](https://github.com/leeoniya/uPlot/blob/master/docs/README.md), [MCAP timestamp/recording specification](https://mcap.dev/spec) — RESEARCH-RECORDED, 2026-10-31; MCAP is optional future interchange, not required storage.
- [Approved comparison reference](https://refero.design/pages/1653cc08-edba-44ac-bddf-54f183015194) — visual pattern only.
- [Telemetry](serial-monitor-and-telemetry.md), [hardware tests](hardware-testing-and-debugging.md), [provenance](context-provenance-and-freshness.md).

## TASK-09 implementation — 2026-11-03

Procedures are ordinary experiments/procedures.json source. Creating a run retains
canonical selected procedure bytes and immutable revision records. TODO drafts
cannot become runs. Starting freezes declared configuration; accepted design
changes or explicit setup segments preserve history and make whole-run comparison
non-comparable. Layout-only movement does not change the design. Restart marks
running acquisitions interrupted and never replays physical work.

Attached intervals retain parsed/raw artifacts and deterministic metric artifacts.
Known device/upload/firmware/source associations cannot be silently replaced by a
different recording. An upload gap or firmware-transition observation leaves
whole-record firmware/build/source unknown until exact segment binding exists.
Agent tools append attributed notes only; trusted native host actions record a
judgment against retained procedure/evidence. A segmented, empty, unreviewed-gap,
unknown-unit or parse-error numeric run cannot receive a whole-run pass.

Comparisons disclose unit, clock, procedure, setup, parameter and identity
differences, and conservatively refuse unsupported improvement claims. Preview
metadata is bounded; full run parameters remain intact. Offline JSON export
retains raw, parsed, procedure and metric bytes/checksums, to a 128 MiB bound.
Source/build/upload identities are referenced with explicit limitations; their
complete ordinary files/artifacts belong in the separate project archive.
Recognizable credentials, including decoded raw serial payloads across segments,
block export without altering original evidence. Detection is not a general
secret classifier.
