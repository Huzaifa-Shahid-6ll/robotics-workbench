# TASK-11 — Recovery and complete journeys

## Resumed acceptance — 2026-11-06

The user authorized completing TASK-11/TASK-12 with desktop and MCP tools.
Root owns this resumed run; no delegated agents are active. Existing D05/D06/D07,
D44/D46/D47/D48 contracts, requirement IDs and acceptance thresholds still apply.
Expected changes: these task records, verification evidence/catalog/traceability,
and only implementation files needed to fix an observed failure. Verification
will reuse the exact installed candidate, exercise native keyboard/theme/zoom
and recovery views, review current vendor support, and validate release evidence.
Screen-reader speech and physical observations will only pass if actually observed;
the earlier request to stop Narrator is retained until explicitly resumed.

Native inspection exposed a retained Agent timeout banner. An isolated copy of
the existing controller audit reproduces it: a failed snapshot followed by a
successful explicit Refresh still retains the old read error. The expected fix
is limited to `apps/extension/src/agent-controller.ts` and regression coverage in
`scripts/ui/controller-readiness-audit.cjs` (REQ-UX-04, REQ-UX-46, AC-D44-06).
Actual action failures must remain visible through background refresh; clearing
a read error must not create a successful task or hardware receipt.

### Resumed result

The Agent controller now separates action errors from read errors, following the
existing engineering-controller pattern. A successful read clears a recovered
timeout; background refresh preserves action failures, and explicit Refresh may
clear the displayed action error without changing any task or hardware receipt.
The regression first failed against the original controller and then passed.

All 433 software tests passed with two isolated test-file workers, along with
five controller-readiness checks and the engineering fault audit. The original
default-concurrency run had 432 passes and one archive-stage rename EPERM; the
unchanged archive suite passed all ten checks in isolation. That failure and the
full passing rerun are retained; its filesystem cause is not attributed.
The patched VSIX passed inspection and both installed trusted/restricted hosts.

Native keyboard inspection opened Recovery, a retained upload receipt and a
private diagnostic preview, then reached the real consent and save dialog before
cancelling. Both operational database versions were preserved and compared before
restoring the historical baseline; the only additions were this session's preview
artifact, observation and admission event. A final native run used a copied store.
Its screenshots still timed out after the desktop tools refreshed. Both QA windows
were closed; native dimensions/appearance/zoom, full keyboard journeys and actual
Windows screen-reader output remain unverified. TASK-11 remains in review and
D04 G6 / D48 complete-release acceptance remains open. Evidence is under
`verification/evidence/task-12/resumed-0bfc2f57` and the two native UI run directories.

Started 2026-11-04. Status: implementation ready for review; manual acceptance remains open. G6 is not accepted.
Integration owner: root, branch codex/task-11-recovery. Depends on completed
TASK-06 through TASK-10. TASK-12 remains blocked until this task's evidence passes.

Owning documents: D05,D06,D07,D11,D16,D20,D30,D40,D44,D46,D47,D48; D14,D18,D19
own shared identities, versioned boundaries and operation states; D50 owns order.
Requirements: every D06 core requirement, REQ-ARCH-48, REQ-ARCH-50, REQ-UX-44,
REQ-UX-46, REQ-UX-47, REQ-HW-40-01. Validation gates: VG-08,VG-11,VG-13,VG-14,VG-15.

Three implementation agents have exclusive ownership: task11_recovery owns
archive helpers and new recovery companion modules/tests; task11_journeys owns
integrated journey tests and scripts/recovery; task11_ui owns the native recovery
controller/tests and extension manifest. Root owns shared protocol/schema changes,
main/extension composition, evidence validation, performance measurements and
integration. D01–D17, D18–D34, D35–D50 are read across those agents, with each also
reading its governing cross-contracts. Current vendor APIs use Context7.

Expected paths: apps/companion, apps/extension, packages/application,
packages/test-fixtures, scripts, verification, tasks. Integration may additionally
extend packages/contracts and matching contracts schemas for the versioned recovery
boundary, packages/webviews/src/agent.css for measured disabled-control contrast,
and packages/adapters/arduino for cooperative exact-input scanning. The latter
fixes an observed real-PC IPC stall without weakening build identity. Supporting
README and owning D16/D18/D48 documentation change with these boundaries. This
does not change canonical IDs, states or data authorities.

Planned checks (not yet executed): portable archive plus tamper/write-failure/
credential rejection; history inspection without device; unknown upload no replay;
cross-feature persistent-project journey and D48 fault matrix; native keyboard
recovery and conflict preservation; D07 measured workloads; traceability rejection
of missing links, unknown tests and unbacked success; full software suite, schemas,
VSIX inspection and installed trusted/restricted host. Actual unplug/replug and
Windows screen-reader checks require user participation and remain pending until
observed. Historical TASK-04 device evidence is not a new bench run.

No dependency upgrades, bootloader actions or public publishing are planned.

## Integration checkpoint — 2026-11-04

Three agents read all D01–D50 across their assigned ranges and governing
cross-contracts; current document hashes are in verification/evidence/task-11/documentation.json.
The deterministic journey/fault contribution passed 125 tests. A full integration
run passed 410 software tests and VSIX inspection; its installed-host stage found
an incorrect test assumption about programmatic virtual-document edits, then a
real sticky engineering inspection error. Both are corrected; final installed-host
verification and the changed long-capture boundary require another final run.
Failure history is retained, including 917644f0,1269ff87,4ac46abf and preflight logs.

The real dedicated Uno (USB serial PRIVATE_BENCH_SERIAL_WITHHELD) received exact artifact
ad7580cf03dc5735ce6aaffd737065eb970268d768e24b7c3d151ffbc3ccd396.
Upload/serial handoff and external contention passed in hardware run 62f27e38;
that run's later human step timed out. A separate resume run 45b83f58 exposed
the old one-minute capture rollover. Native user captures now support 1–3600
seconds while provider tools retain their independent 1–60 second cap. Continuous
resume bb6c4ee7 passed actual unplug/replug without a new upload. Capture-only
process loss bfb807e6 passed restart/partial-raw recovery without reopening a port.
These are USB/serial/software observations, not sensor/wiring/actuator validation.

Actual 30-minute raw recorder/display-preview run e333d08f retained 17,709,920
bytes and bounded its preview. Host benchmark a10278d7 passed its scoped metrics
(90,841,088 incremental bytes, 461ms activation, observed shutdown). Browser run
46efbccd passed 111 screenshots and 66 sampled contrast audits across three theme
families, plus rendered response budgets. Native keyboard/zoom/Narrator observations
remain pending; synthetic browser scaling is not that evidence.

The same persistent bench project passed actual PDF ingestion/page rendering,
KiCad native generation/reopen and CadQuery generation/reopen in complete run
ab7486e6, which then exposed a recording-selection assertion in the test runner.
Its telemetry/archive completion, current live provider repetitions, final package
and manual native checks remain in progress. TASK-12 is still dependency-blocked.

## Final integration checkpoint — 2026-11-04

Complete resume 0e823e4f passed retained telemetry, exact interval/experiment
linkage and portable restore of the same persistent bench project, including
20 source files, 47 artifacts and 21 operation receipts. The experiment remains
inconclusive; uploader success is not physical behavior verification.

Live suite 2ee4ac54 passed all three Codex repetitions and exposed an OpenCode
handoff-context admission defect. The corrected bounded-context and provider
resource lifecycle paths passed 39 focused tests; a fresh live suite is pending.
Terminal tasks now release provider/bridge resources after durable checkpoints,
while uncertain effects and pending approvals require explicit reconciliation.

Full software run 923fe8c3 passed 419 tests and cancelled one durable event-burst
case at its 30-second harness deadline on the project drive. Its assertions and
2 MiB/128-event workload remain unchanged; the test and enclosing stage deadlines
were extended for a recorded rerun. An earlier build exhausted Windows virtual
allocation while linking every test simultaneously; sequential batches of eight
completed the build. Failure logs remain retained.

Native conflict run 4eb902b6 reached the actual proposed diff, but both screenshot
tools timed out and the user reported no visible window/diff. Narrator, visual
inspection, keyboard completion and native zoom remain unverified. The interrupted
fixture retained its source/review copies. A rebuilt installed host and fresh
visible native session are required; no manual acceptance is inferred from the
accessibility tree or browser screenshots. TASK-12 remains blocked.

Run 65dd2500 passed all five verification stages: contracts, boundaries/evidence
validation, all 420 software tests plus both controller audits, inspected VSIX,
and installed trusted/restricted host with companion exit observed. A later
read-only live preflight exposed a 12.135-second project snapshot: it unnecessarily
hashed compiler inputs for a revision-1 build when current intent was revision 2.
The existing stale-revision decision now precedes those hashes. Six hardware
boundary tests and TypeScript passed; a real post-fix snapshot took 182ms, with
source unchanged and clean shutdown (05ee810b). Fresh live repetitions are running.

The user confirmed fresh native window 681a4ee0 was visible, then reported a
sound without spoken values and requested skipping further Narrator checks.
The supplied shortcut was incorrect for that purpose: Alt+F5 is visual diff
navigation; current VS Code documentation specifies its Accessible Diff Viewer
(F7). The original report and procedure correction are retained separately.
No accessibility pass, product defect, or release-gate waiver is inferred.
Manual Narrator checks will not be requested again in this run. Native visual,
keyboard, zoom and speech acceptance remain open; G6 is not accepted.

Final functional evidence: fresh suite 70601b9c passed Codex 3/3 and OpenCode
3/3 with application handoff, exact project facts, unchanged protected source and
no new operation/upload receipts. Current package 95aa2e5e passed inspection and
installed trusted/restricted hosts after the stale-input-scan fix. Native fixture
6bf7b7f0 passed proposed/written/conflicted review assertions and retained actual
dirty-editor and saved-provider copies with separate verified hashes. Its sources
and immutable JSON review store are synthetic; it is not a manual UI or backend
SQLite claim. Earlier failed fixture runs are retained.

All reversible TASK-11 implementation work is ready for review. Manual native
coverage and complete-release acceptance remain incomplete. Only independent
TASK-12 release preparation may proceed while those gates remain open; this does
not approve a release, remove a requirement, or mark TASK-11 fully accepted.

Git attributes preserve evidence/history bytes without newline conversion, so a
checkout cannot invalidate recorded checksums. CSS/CJS source uses the existing
LF convention; this fixes the observed safe-CRLF staging refusal without changing
global Git configuration.
