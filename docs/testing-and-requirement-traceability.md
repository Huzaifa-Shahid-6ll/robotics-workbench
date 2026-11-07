---
doc_id: D48
title: Testing and requirement traceability
status: implementation-spec
updated: 2026-11-01
depends_on: [D06, D07, D18, D30, D40, D47]
requirement_ids: [REQ-ARCH-48]
---

# Testing and requirement traceability

## Authority and evidence status

**SPECIFIED:** This document owns test layers, evidence records, release gates, and the mapping from requirements to proof. [D06](requirements-and-acceptance.md) owns requirement meanings; subsystem documents own behavior. [D30](agent-evaluation-and-regression.md) owns agent evaluation tasks, and [D40](hardware-testing-and-debugging.md) owns physical procedures. This specification does not claim that any implementation test has run. Empty evidence is `not-run`, never an implicit pass.

**SOURCE-VERIFIED:** Official VS Code documentation retrieved through Context7 on 2026-11-01 supports extension-host integration tests using `@vscode/test-electron` and `@vscode/test-cli`. Isolated user data and test workspaces avoid contamination from persisted trust decisions. These facilities do not verify the product's hardware behavior.

**REQ-ARCH-48:** Every in-scope requirement MUST have traceable verification evidence of the appropriate class before complete-release acceptance.

## Test layers and boundaries

The documentation pack includes [the manifest](../doc-manifest.json), [contract schemas](../contracts/operation.schema.json), synthetic examples, and [the pack validator](../scripts/validate_pack.py). These are existing **documentation-pack tools**, separate from the future application test harness. From the extracted pack root, run `python scripts/validate_pack.py` for standard-library document/link/JSON checks. After installing [requirements-validation.txt](../scripts/requirements-validation.txt) in an isolated Python environment, run `python scripts/validate_pack.py --contracts` for schema validation. The dependency file pins the tested validator dependency; it is not the app's Python CAD environment. These checks cannot establish provider or hardware compatibility.

| Layer | Required targets | What a pass proves |
|---|---|---|
| Documentation/contracts | Unique document IDs; resolved links; valid schemas and examples; no inconsistent statuses | The pack is internally consumable, not that the app works |
| Pure domain | Pin aliases, net validation, revision checks, parsing, artifact identity | Deterministic functions satisfy their contracts |
| Adapter contract | Fake CLI, fake serial, recorded provider transcripts, errors and cancellation | Our normalized interface behaves consistently against the fixtures |
| Service integration | SQLite, files, subprocesses, coordinator ownership, recovery | Local state survives specified faults with truthful outcomes |
| Extension host | Commands, dirty buffers, diagnostics, trust, activation/disposal | Behavior works inside the supported VS Code host |
| Webview/UI | Message validation, selection, keyboard, theme, layout | Views correctly represent application-owned state |
| Packaged installation | Clean Windows profile, installed VSIX, real native dependencies | Distribution works independently of a developer checkout |
| Real hardware | Actual selected Uno, upload, serial reset/reconnect, device removal | The recorded procedure worked on the named device and environment |
| Complete journeys | Existing sketch through build, review, upload, recording and export | Required subsystems cooperate in a persistent project |

Fake adapters MUST be explicitly selected by a test harness and MUST NOT be selectable accidentally by production UI. CI SHOULD run deterministic layers without paid accounts or USB devices. Live-provider and real-device suites MUST be separate, manually initiated or explicitly configured jobs. Never expose tokens to untrusted pull-request jobs.

## Traceability contract

Maintain a machine-readable `verification/traceability.json` during implementation. This is a **proposed implementation artifact**, not a file guaranteed by this documentation pack. Each requirement from D06 MUST map to one or more acceptance criteria, implementation owners, and test IDs. Each test record MUST identify its evidence class. A single successful test may cover multiple requirements only when assertions demonstrate each one.

```json
{
  "schemaVersion": 1,
  "requirementId": "REQ-ARCH-48",
  "acceptanceCriteria": ["AC-D48-01"],
  "testIds": ["verification.requirement-coverage"],
  "implementationPaths": ["verification/traceability.json"],
  "evidence": [],
  "verificationStatus": "not-run"
}
```

This example maps this document’s traceability requirement to its coverage check. The named verification test is specified here and must be implemented before it can pass. The implementation path is the required ledger artifact, not an assertion that the application repository already exists. Verification statuses are `not-run`, `passed`, `failed`, `blocked`, and `not-applicable`; these are **verification statuses**, not operation statuses. `not-applicable` requires a documented scope decision and cannot erase an in-scope requirement.

Each evidence record MUST include run ID, test ID, repository commit or source digest, app version, OS, dependency versions, start/end timestamps, result, evidence artifact hashes, and limitation notes. Hardware evidence additionally includes device identity, FQBN, firmware artifact digest, projectRevision, wiring confirmation reference, and observed procedure. No secret-bearing raw environment dump is permitted.

## Required fault matrix

| Fault | Assertion that MUST hold |
|---|---|
| Compile fails after earlier successful build | No automatic upload of the earlier artifact |
| Agent and user edit the same file | Both versions preserved; no silent overwrite on Keep/Revert |
| Manifest changes during a pending mutation | Revision conflict returned before applying stale intent |
| Library changes without sketch changes | Build input identity changes |
| Monitor owns port during upload request | Monitor release observed before uploader starts |
| Second VS Code window or external monitor contends | Explicit busy/ownership result; no false global-lock guarantee |
| Service dies during upload | Restart records `outcome-unknown`; no automatic replay |
| Disk fills during recording | Capture stops or degrades explicitly; truncation/gap is visible |
| Provider disconnects or repeats event | No duplicated mutation or fabricated completion |
| KiCad file edited outside workbench | Divergence reported; external file not overwritten |
| Project restored without original device | History remains inspectable; no claim of current device state |
| Untrusted datasheet instructs tool execution | Content treated as evidence, not authorization |

Inject failures at boundaries: before operation receipt, after receipt, after subprocess start, after external effect, and before result persistence. SQLite rollback alone is insufficient proof because filesystem and hardware effects lie outside its transaction.

## Test fixture discipline

Fixtures MUST be small, checked in, and labeled synthetic or captured. Captured traces MUST be redacted, versioned, and legally redistributable. A serial fixture includes bytes, timestamp basis, declared gaps, parser version, and expected output. Provider fixtures include observed event versions; they MUST NOT imply guaranteed compatibility with newer provider versions. Include multi-file sketches, spaces/Unicode in paths, modified local libraries, empty projects, corrupt manifests, partial recordings, and conflicting physical observations.

Do not write tests that merely reproduce implementation branches. Assert user-visible invariants and preserved data. Snapshot tests SHOULD cover stable rendering/shape, not volatile timestamps. Performance tests must state workload, machine, sampling method and warm/cold conditions, then compare against [D07](quality-and-performance-budgets.md).

## Release decision

Every in-scope requirement needs its designated evidence class. Mock-only upload evidence cannot satisfy real-device gates. A release candidate with a failed mandatory test is blocked; a failed optional CAD installation probe may defer CAD work during development but cannot be called the complete personal release while CAD remains in scope. Preserve failures alongside later passes so recovery is auditable.

TASK-11 registers actual test procedures in [test-catalog.json](../verification/test-catalog.json).
Run `node scripts/verification/validate-evidence.mjs` for requirement/acceptance/owner/
path links, known test IDs and artifact integrity. Its rejection regression runs in
`npm run check`. A full-requirement passed entry requires hashed artifacts, run/source/
version/environment/timestamp metadata and every designated evidence class. Registry
membership or a structural pass cannot promote historical scoped evidence to G6.

## Acceptance criteria

- **AC-D48-01:** Every D06 requirement has a unique traceability entry with an owner and explicit verification status.
- **AC-D48-02:** Required fault scenarios execute deterministically through fake adapters and retain outcome evidence.
- **AC-D48-03:** Packaged Windows installation and a real-Uno loop have separate evidence from development-host and simulated runs.
- **AC-D48-04:** A validator rejects missing requirement links, unknown test IDs, malformed evidence and success records without artifacts.
- **AC-D48-05:** Release report distinguishes document validation, software testing, live-provider testing and physical verification.

## Sources and related documents

- SOURCE-VERIFIED: [VS Code testing extensions](https://code.visualstudio.com/api/working-with-extensions/testing-extension), accessed via Context7 2026-11-01.
- RESEARCH-RECORDED: Prior research tracks 48–49, 2026-10-31, critical path and adversarial review.
- [D49 packaging](packaging-release-and-maintenance.md); [D50 task packets](implementation-plan-and-task-packets.md); [D10 validation gates](unknowns-and-validation-spikes.md).
