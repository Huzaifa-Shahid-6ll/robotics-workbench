---
doc_id: D36
title: "KiCad generation and handoff"
status: implementation-spec
updated: 2026-11-01
depends_on: [D19, D34, D35, D41]
requirement_ids: [REQ-HW-36-01]
---

# KiCad generation and handoff

## Purpose and authority

**SPECIFIED — REQ-HW-36-01:** Reuse KiCad for schematic validation, rendering, native files, and advanced editing. The workbench owns a limited generator and provenance adapter, not a replacement schematic editor. KiCad is optional until the user invokes a schematic operation. Existing code/build features MUST remain usable when it is absent.

**SOURCE-VERIFIED:** Current official documentation retrieved through Context7 on 2026-11-01 describes `sch erc`, JSON reports, violation exit codes, and per-sheet SVG exports. The corpus tracks `master`; each command option MUST be capability-gated against the installed release. Earlier research recorded the stable 10.0 manual. Do not assume future schematic IPC support exists in a stable installation.

## Capability discovery and native authority

Record the absolute executable path, version, supported command help, library paths, environment, and tested format range. Pin the supported major/patch combination after a real fixture roundtrip. A missing or unsupported release exposes a disabled operation with a specific remedy, not silent format conversion. Project symbol tables and referenced resources are inputs to validation, so source hash alone is insufficient for preview-cache identity.

For workbench-generated designs, the manifest owns intended connections and a generation receipt records their revision. For imported or externally edited native schematics, the `.kicad_sch` project owns schematic connectivity. The workbench MUST detect divergence rather than overwrite native edits to force alignment. An explicit reviewed reconciliation can import a supported subset or create a fresh generated copy. No automatic lossless bidirectional synchronization is promised.

## Generation pipeline

1. Resolve supported component definitions and stable endpoint IDs; reject unresolved symbol/pin mappings.
2. Construct a typed intermediate schematic model and mapping from componentId/pinId to KiCad UUID/reference/pin number.
3. Generate into a new staging directory using version-tested templates and a deterministic supported subset of native syntax.
4. Parse/load through KiCad CLI, export connectivity, compare exact intended endpoints, and run ERC.
5. Export previews and record diagnostics, source/dependency hashes, generator version, mapping, and operation result.
6. Present changes and validation findings before replacing an existing generated artifact.

The generator MUST identify itself distinctly in native metadata and create stable valid UUIDs. It MUST preserve unsupported native objects unchanged through a tested roundtrip or refuse editing them. Regex substitution of arbitrary schematic text is prohibited. Initial supported subset: single-sheet symbol instances, named nets/wires, labels, junctions, and explicit no-connect markers from pinned templates. Hierarchical generation remains gated; imported multi-sheet preview/export should preserve per-sheet identity.

## CLI adapter examples

These patterns were verified in official documentation; paths are placeholders and MUST be passed as argument-array elements:

```text
kicad-cli sch erc --format json --exit-code-violations --output <report.json> <design.kicad_sch>
kicad-cli sch export svg --output <preview-directory> <design.kicad_sch>
```

With the documented violations option, exit code 5 indicates ERC violations; it is not equivalent to tool launch failure. Retain structured report and raw process evidence. A completed ERC job can have operation status `succeeded` and a validation verdict `fail`; the UI must show both. Missing symbols, invalid input, unavailable output, or unsupported flags are execution failures. Exact diagnostic parsing is versioned.

SVG previews MUST be sanitized or rendered in an isolated viewer without active scripts or external resource fetching. A preview is derived data and must display its source revision/staleness. Successful rendering does not establish connectivity. Compare exported netlist equivalence against the intended model, using canonical endpoint sets rather than visual line positions or net-label spelling alone.

## Handoff, failures, and recovery

Open native KiCad as an external application with the explicit project path; do not embed its GUI or automate private commands. File watching notices saved external changes and invalidates previews/mappings. Unsaved KiCad state is not accessible unless a supported API proves otherwise; tell the user to save before validation. A race between external save and generation must fail the expected-hash check and preserve both files.

Publish staged files only after required parser/connectivity checks complete. Keep the last valid preview on failure with an out-of-date badge. ERC findings remain reviewable; zero findings do not certify power capacity, thermal performance, physical wiring, or firmware behavior. Full-project export must include required local symbols/libraries or explicitly list unresolved external dependencies.

## Acceptance criteria

### TASK-10 implemented bounded subset — 2026-11-03

The version-1 KiCad adapter enables the fixture-tested Windows x64 KiCad 10.0.8
CLI and records its exact executable SHA-256, command-help digest, environment
fingerprint, source/dependency hashes, endpoint mapping and immutable output
artifacts. The built-in tested executable fingerprint is
`852a4dea194f72a2293a7f8ea000c386074939efe61d8dcd2c25bfb32bf228d9`.
Missing or incompatible tools disable schematic operations alone.

Generation reads ordinary `components/kicad.json` with
`{"schemaVersion":1,"template":"pin-block-v1","components":[]}`. Each component
entry explicitly names componentId, definitionId, definitionVersion, a unique
native reference and pins with canonical pinId/native number. All resolved
components and all their pins must be mapped. Unconnected pins require explicit
noConnect; unknown electrical types are refused. The bounded template supports
16 components with at most 16 pins each on one sheet. Its generic logical blocks
are explicitly chosen design symbols, never a guessed manufacturer symbol or
physical header drawing. Definitions retain the catalog's immutable-version rule.

The generator emits native schema 20250114 with stable UUIDs, embedded symbols,
named nets/labels, explicit no-connect markers, an ordinary local symbol library,
symbol table and project file. Actual KiCad load/netlist comparison gates
publication. ERC exit 5 remains successful execution with failing severity
verdicts. SVG output loses the exact known public DTD declaration and accepts
only passive geometry/text; active elements, event attributes and external
resources are refused. The preview uses an inert image under the offline CSP.

Generated and imported saved source are distinct origins. Native validation
accepts the tested single-sheet format with complete embedded symbols and
self-contained local dependencies; hierarchy, inherited/missing symbols, external
library paths, buses and embedded resource objects receive targeted refusals.
No arbitrary native object is edited. Every saved input is checked before and
after staging; no original native source is replaced. The last good preview
remains available with a stale label after failures, native edits or changed
manifest/dependency/tool fingerprints. Watchers are hints; preflight rehashing
enforces the final check.

`kicad.export` creates a new project-local directory exclusively, with native
source, local symbols, project metadata and provenance. An existing destination
is refused. Identical request IDs return the retained result; an interrupted
export is inspected rather than replayed. Native editing of the retained staged
file preserves immutable historical artifacts; export a project-local copy and
select its saved source for subsequent validation. Unsaved KiCad buffers remain
outside the integration boundary.

The native experiment in `scripts/engineering/kicad-spike.ts` actually passed
generation, exact endpoint equivalence, a zero-finding ERC fixture, per-sheet SVG,
ordinary export, a second independent CLI reopen, imported-native validation and
a real output/output ERC conflict, explicit no-connect markers and a real CLI
generation raced against an external saved-file edit on this installation.
The race failed publication and preserved the independent saved bytes.
Its evidence is under
`artifacts/task10-kicad-native/e9d7c1a1-8003-4a3a-8912-fae8227c0bca/result.json`.
The earlier failed SVG/grid/library experiment is retained beside it. These are
native CLI software checks, not GUI editing, hardware verification or G6 release
acceptance. The task-level evidence owns the final integrated build status.

- **AC-D36-01:** Generate a supported fixture, open it in pinned KiCad, and compare exported endpoint sets to the manifest.
- **AC-D36-02:** Introduced ERC violations appear with source revision and severity; process completion is not shown as a clean circuit.
- **AC-D36-03:** External edits during generation are never overwritten silently.
- **AC-D36-04:** Unsupported symbols, hierarchy edits, installed versions, and missing libraries fail with targeted diagnostics.
- **AC-D36-05:** Per-sheet previews and exported native projects reopen independently of the extension.
- **AC-D36-06:** SVG fixtures with scripts/external URLs cannot execute or make unsolicited network requests.

## Sources and related documents

- [Official CLI documentation source](https://gitlab.com/kicad/services/kicad-doc/-/blob/master/src/cli/cli.adoc) — SOURCE-VERIFIED, 2026-11-01.
- [Versioned 10.0 CLI manual](https://docs.kicad.org/10.0/en/cli/cli.html), [native schematic format](https://dev-docs.kicad.org/en/file-formats/sexpr-schematic/), [IPC scope](https://dev-docs.kicad.org/en/apis-and-binding/ipc-api/for-addon-developers/) — RESEARCH-RECORDED, 2026-10-31.
- [Wiring authority](wiring-model-and-validation.md), [job supervision](jobs-and-process-supervision.md), [security](security-and-data-boundaries.md).
