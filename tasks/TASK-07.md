# TASK-07 — Components and wiring

Started 2026-11-02 after TASK-06 passed. Status: done for the scoped G4 task; full release remains pending.
Integration owner: root. Three exclusive agents own component/catalog contracts,
pure wiring rules/edit plans, and React Flow/table presentation. Root owns
companion/host composition, process boundary validation, manifest/layout native
edits, observations, cross-selection, packaging and retained evidence.

Owning documents D14,D34,D35,D41–D47; D13/D15/D18/D20/D27 own preservation,
protocol, trust and freshness. Requirements REQ-ARCH-01, REQ-HW-34-01,
REQ-HW-35-01 and REQ-UX-41..47. Existing UUIDs, operation states and file/SQLite
authorities remain unchanged. Part identity is never inferred from a familiar
label; unknown electrical facts produce not-checked.

Expected files: packages/domain/src/components.ts and wiring.ts,
packages/application/src/wiring, packages/contracts, packages/webviews,
apps/companion, apps/extension, bounded fixtures/tests, scripts and verification.
Planned checks: definition immutability/alias resolution; renamed stable IDs;
canonical unordered nets/shared bus/resource conflicts; unknown limits and
direction/voltage checks; stale revision rejection and coherent code bindings;
conservative observation invalidation with immutable history; layout-only saves
without intent/revision change; canvas/table/cross-selection; malformed manifest
preservation; keyboard/theme/zoom browser checks; native host and installed VSIX.

Reference lock remains D41 host-native Factory/Cursor compact workbench. Current
Refero R04 Attio supplies aligned rows; R05 n8n supplies pan/zoom/selection only.
Its workflow semantics and execution controls do not apply to electrical nets.
React Flow12 is the selected interaction layer, with a full table alternative.
No physical wiring or measurements are implied by a connection or rule result.

C: filled during this batch. All task-local TEMP/TMP/npm cache use the ignored
artifacts/tmp and artifacts/npm-cache on G:. Do not delete unrelated user data.

Implemented boundaries: immutable source-reviewed catalog definitions and explicit
version migrations; deterministic rules and inverse intent; one manifest-backed
component/connection table and React Flow canvas; native revision/hash/version
checked source edits, independent layout sidecar, code/document navigation and
revision-bound agent context. Native dialogs record user-reported observations.
Catalog digest is rechecked before save and acceptance. No-op transactions keep
exact source bytes. Invalid external files and interleaved user/provider edits
remain preserved. Inverse restoration fields are refused at the frame boundary.

Three agents delivered catalog/contracts, wiring domain/application, and renderer
with exclusive ownership. Follow-up reviews found and closed the catalog-change
race and no-op formatting gap. Root integrated companion/native host/package and
verified actual VS Code editing; the catalog agent added companion fault tests.

Completed 2026-11-03. `npm run verify:task -- TASK-07` passed all five stages: documentation/contracts, TypeScript/boundaries, full software tests, VSIX package inspection and installed trusted/restricted hosts. Browser production QA passed 18 checks and six screenshots. Native tests exercised preview/save/no-op/undo, stable identity, independent layout, stale immutable reports, exact revision-bound Ask and preservation of concurrent user/provider and malformed external source. See `verification/task-07.json` for actual changed files, commands, hashes and limitations. Historical failing native EOL and browser fixture runs remain retained. No new physical wiring verification, screen-reader check, full D07 performance suite or G6/D48 release acceptance is claimed.
