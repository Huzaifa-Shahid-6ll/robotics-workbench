# TASK-06 — Unified agent context and review UI

Started 2026-11-02 after TASK-05 passed. Status: done (G3 UI scope).
Integration owner: root. Three exclusive agents own renderer, host/context
provider, and task change review. Root owns shared v1 view contracts,
extension/companion composition, build/package integration and evidence.

Owning documents: D13,D26,D27,D28,D41–D47; shared protocol D18 and trust D20.
Requirements: REQ-ARCH-02, REQ-ARCH-06, REQ-AGENT-26/27/28, REQ-UX-41..47.
Expected files: packages/webviews, apps/extension, packages/contracts/src/views.ts,
associated tests/fixtures, package/build scripts, task/verification records.
Verification: VG-08 dirty-buffer/external-edit conflicts; native diff/review
preconditions; state/message validation and malicious content; recreation without
replay; explicit provider capabilities and task/operation states; keyboard,
responsive, theme/zoom and reduced-motion checks; inspected installed VSIX.

Reference lock: approved D41 primary native VS Code + Factory/Cursor compact
workspace. Current Refero searches reviewed Factory/Cursor/Attio styles and R02,
R03,R06 screens. Preserve host fonts/colors, thin separators, 4px controls,
12px panel padding and compact text. Borrow Cursor's persistent composer,
Factory's grouped context, GitHub's file list/native diff, Attio's row alignment.
Marketing palettes/fonts/hero treatments are outside their approved roles.
Use real source/context/artifacts; no generated decorative media required.

Implemented the common React view, strict typed messaging/CSP, context facets,
pin policy, task selection, explicit provider/model/profile controls, independent
task/provider/hardware states, approval/interrupt/reconcile/handoff controls,
and native diff/source review with immutable artifact-backed persistence.
The view is movable and lazy; hidden views stop polling. Interleaved edits
preserve both versions. Unattributed writes are labelled honestly and revert
requires exact diff/hash confirmation. Source freshness uses actual input bytes,
including after Keep. Window ownership cannot be switched by background polling.

Executed deterministic UI/protocol/context/review/persistence suites and native
VS Code development host checks. Native tests displayed exact retained diffs,
performed a confirmed minimal source revert, preserved dirty user/provider
versions, froze selection across a save dialog, and rejected a competing writer.
Isolated Edge browser QA covers three themes, narrow320px,200% font zoom,
keyboard focus, reduced motion, inert markup, draft retention and duplicate Send.
Its project/provider/device facts are synthetic and labelled accordingly.

Final packaging/installed-host evidence is recorded in verification/task-06.json.
The final wrapper passed all five stages. Browser QA exercised byte-identical
packaged JS/CSS. Initial disk-full and timing/context failures are retained;
task-local temporary profiles/cache moved to G: without deleting user data.
The synthetic capture fixture now observes readiness and explicitly stops after
handoff, retaining its exact byte/gap/cursor assertions under slow I/O.
Windows screen-reader validation, full journey/performance and G6 release remain
TASK-11/12. This task performs no physical hardware operation. Source/task review
does not claim an upload or rewiring occurred.
