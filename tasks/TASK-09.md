# TASK-09 — Telemetry and experiments

Started 2026-11-03 after scoped TASK-08 passed. Status: done for the scoped G5 task.
Integration owner: root. Depends on completed TASK-04; gate G5; validation VG-06.

Owning documents: D33,D39,D40,D44–D47; D14,D16,D18,D19,D20,D27 govern
identity, persistence, protocol, operation supervision, trust and freshness.
Requirements: REQ-HW-33-01, REQ-HW-39-01, REQ-HW-40-01, REQ-HW-07,
REQ-UX-44..47 and REQ-ARCH-50. All fifty documents are divided among three
agents for reading, with cross-contracts loaded by each owner as needed.

Exclusive owners: task09_parsers owns telemetry contracts, streaming parsers,
recording fixtures, raw observer/worker integration and its checks;
task09_experiments owns experiment contracts and application records/metrics/export;
task09_view owns S08/S09 renderer, strict frame protocol and browser checks.
Root owns shared exports/request schemas, companion/native host composition,
agent context, package/build and final evidence/status. Parser ownership of
HardwareService was limited to capture observers and liveness, preserving
unrelated hardware behavior.
Existing operation states, device ownership and raw evidence remain authoritative.

Expected files: packages/contracts, packages/adapters/serial,
packages/application/src/experiments, packages/webviews, bounded recording/run
fixtures, apps/companion, apps/extension, scripts, tasks and verification.

## Implemented slice

Schema-version-1 contracts separate immutable `telemetry-v1` parser profiles,
configuration SHA-256, UUID derivation identity and complete source fingerprints.
Raw capture retains its existing `raw-v1` contract and ordinary append-only
JSONL/base64 artifacts. Profiles explicitly select raw text, labeled numeric,
single-line CSV mapping or JSON Lines mapping. They never switch modes during
capture or inject a telemetry library into firmware.

Streaming framing preserves partial transport chunks and exact raw byte/sequence
spans. Invalid UTF-8, binary, missing/nonfinite values and incomplete frames do
not become numeric zero samples. Unknown units remain null. Device clock sources
and epochs are explicit; wraps, resets, repeated timestamps and receive-clock
regressions remain visible. Modulus-based unwrapping does not prove a reboot did
or did not occur. Host receive time is never presented as sensor acquisition time.
Offline derivation interleaves raw gaps in the same order as streaming parsing,
preserving measured loss counts and explicit null counts.

Final derivation runs under the existing heavy-job queue in a supervised worker.
It verifies canonical artifact scope, ordinary-file ownership, complete segment
hashes, recording/session identities, decoded raw digest and byte count. Failed
or interrupted final segments marked incomplete may supply their complete
LF-terminated JSONL prefix; their full original bytes/hash remain unchanged and
an explicit unknown-tail issue is appended. Completed evidence cannot use that
exception. Timeout, cancellation, corruption and parse failure preserve source
artifacts and perform no port writes.

Raw observers run after complete preserved writes. Throwing or rejected display
callbacks cannot fail acquisition; display omissions are counted. HardwareService
exposes bounded live snapshots from its existing coordinator instead of opening
a second port. Live views retain a 1 MiB display byte ring, latest 2,000 samples
and 100 gap/issue markers. Display pause and hidden-view lifecycle do not stop raw
capture. Provisional live evidence cannot be frozen as a retained interval.

S08/S09 use uPlot 1.6.32 with a paged accessible table, visible clock/units and
gap-preserving display decimation. Deterministic statistics use every selected
finite sample before display reduction. Frozen context records exact recording,
channels, derivation, parser/configuration, time basis/epoch, range and original
design revision; later UI selections do not replace those references. Read-only
recording queries and agent context use the shared companion path.

Procedures remain ordinary source files. Run records retain canonical procedure
bytes, frozen configuration, explicit unknown associations, append-only revisions,
notes, linked recordings and deterministic metric artifacts. Restart interrupts
unfinished runs without replaying physical actions. Comparison exposes unit,
clock, procedure, setup and firmware differences and refuses unsupported
improvement conclusions. Agent assertions alone cannot create passing judgments.
Offline exports retain evidence bytes/checksums and reject recognized credentials,
including decoded raw payloads, without rewriting original evidence.

## Executed evidence and completion

[Run 6112b8d4-30a4-4c90-9974-0a5850c9ffb1](../verification/task-09.json)
records the following executed checks on Windows 10.0.19045 x64, Node 24.18.0:

- `.venv-validation/Scripts/python.exe scripts/validate_pack.py --contracts`:
  passed, with retained document/contract log.
- `npm run check`: passed, including TypeScript and three dependency-boundary
  tests.
- `npm test`: **335 passed, 0 failed**, including the complete-prefix worker,
  observer ordering/failure isolation, live/offline gap equivalence, clock,
  parser-limit, immutable selection, run/recovery, comparison and export cases.
  Exact executable paths, timestamps and evidence hashes are in the run record;
  [the suite log](../verification/README.md)
  retains the observed results. These are software results, not new physical
  measurements.

Final review corrected comparison units/styles per channel and restricted interval
export to exact full-resolution selected samples. The service suite passed11/11;
production browser QA passed12checks and15screenshots, including mixed mm/mW
comparisons. A fresh checked VSIX and installed trusted/restricted hosts passed
after both corrections. Final run: 6b53dd25-b674-40e8-9417-ef731a0fc671.
Exact commands, hashes, native reports and retained baseline results are in
[the completion record](../verification/task-09.json). No remaining scoped gates.

## Historical real-capture replay

[Replay evidence f2980680-1c05-4e54-b117-5285fcf857ae](../verification/README.md)
passed read-only analysis of TASK-04 recording
`e2f1dc6f-31b3-4535-a0c2-19cbb0117e33`. The exact raw SHA-256 is
`15790cc268bf2fcb371a7a929827d49ec1d7b6b33a1822a184a52c1a8c87c0c3`;
both source segment hashes are retained in the replay result. Derivation
`4617b88f-dfef-8406-9fbb-b666bd8d8166` yielded 95 counter samples, preserved upload
and cancellation gaps and rejected startup/binary lines as numeric frames.
Counter units remain explicitly unknown. This reuses previously observed Uno
bytes and performs no new USB open, upload, reset, sensor or wiring procedure.

## Document-reading ledger

The three-way reading assignment covers D01-D50 without redefining shared
contracts. Each agent's completion is recorded as an attributed claim:

- `task09_parsers` confirmed its D01-D17 partition. Additional reads were
  D18,D19,D20,D27,D33,D39,D40,D48,D50, plus the task packet and Ponytail skill.
- `task09_view` confirmed all sixteen documents D35-D50, plus
  D13,D18,D20,D27,D33, the task packet, AGENTS/start instructions and applicable
  Refero/Context7/Ponytail guidance.
- `task09_experiments` confirmed all seventeen documents D18-D34, plus
  D01,D02,D14,D15,D16,D39,D40,D48,D50 and the task packet.

Together these attributed partition confirmations cover all fifty documents.
They are reading/coordination evidence, not proof of integration correctness.

## Limits and remaining gates

- One numeric frame is bounded to 1 MiB. Multiline quoted CSV is unsupported and
  rejected explicitly. Invalid/incomplete input remains available in raw evidence.
- Final derivation initially accepts 32 MiB of raw JSONL input and 64 MiB of
  parsed output, with a 30-second deadline. The 224 MiB old/32 MiB young V8 heap
  limits do not bound external buffers; separate input/output limits also apply.
  Raw recording retention remains independently bounded and is never deleted to
  satisfy display or parser limits.
- Historical replay proves deterministic handling of the retained capture,
  not current hardware state. No new physical sensor, wiring, calibration,
  actuator, unplug/replug or driver compatibility result was established.
- Metrics are sample statistics, not physical accuracy/calibration or uncertainty
  estimates. There is no cross-run device-clock mapping. Changed/segmented runs
  cannot pass whole-run criteria; per-segment judgments remain unsupported.
- Run JSON export is bounded to 128 MiB, with the native host save flow capped at
  64 MiB. Run-only archives reference source/firmware identity but omit those
  ordinary files/bytes; full project export is separate. Recognizable credential
  detection is not a general secret classifier.
- Browser checks use synthetic state and approximate 200% zoom using font size
  and viewport width. They do not prove Windows screen-reader behavior or
  installed VS Code webview behavior; final installed-host evidence is separate.
- The initial 30-minute memory/performance budget and complete G6/D48 release
  journeys remain separate obligations. TASK-09 is a scoped G5 slice, not a
  declaration that the complete personal workbench release has passed.

No physical result will be inferred from synthetic parsers, compilation or plots.
Existing real-board recordings may be replayed with their original provenance;
any new physical procedure requires its actual target/setup and observed evidence.
Task-local TEMP/TMP/npm cache and test profiles remain on G: under artifacts.
