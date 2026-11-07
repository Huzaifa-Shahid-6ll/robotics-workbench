---
doc_id: D15
title: "Project format and firmware preservation"
status: implementation-spec
updated: 2026-11-01
depends_on: [D14]
requirement_ids: [REQ-PROD-01, REQ-PROD-05, REQ-ARCH-06]
---

# Project format and firmware preservation

## Authority and invariant

**SPECIFIED:** This document owns `workbench.json`, project import, and firmware-preservation behavior. “Preserve firmware” means preserving standard Arduino compatibility and avoiding mandatory invasive changes. It does not prohibit source edits that the user requests. The application MUST NOT require a proprietary firmware runtime, automatically convert sketches to PlatformIO, or burn a bootloader as routine recovery.

Existing sketch folders remain where they are. `.ino`, `.h`, `.cpp`, libraries, cores, and compiler/upload recipes continue through ordinary Arduino tools. A new project may use a helpful layout, but import MUST NOT enforce that layout. Editing and offline compilation do not require an AI login, connected board, or CAD installation.

## Manifest structure

The initial manifest is UTF-8 JSON with `schemaVersion: 1`. It contains project identity, accepted design revision, sketch references, compiler targets, component instances, intended nets, explicit code bindings, document links, and optional extension metadata. Data owners and identities follow [D14](domain-model-and-identifiers.md). [workbench.schema.json](../contracts/workbench.schema.json) is the executable structural authority for required fields and types. [workbench.valid.json](../examples/workbench.valid.json) is its minimal fixture. Cross-reference uniqueness, pin validity, and canonical path containment need semantic validation beyond JSON Schema.

```json
{
  "schemaVersion": 1,
  "projectId": "11111111-1111-4111-8111-111111111111",
  "projectRevision": 1,
  "name": "Range sensor bench",
  "sketches": [{"path": "RangeSensor", "targetId": "44444444-4444-4444-8444-444444444444"}],
  "targets": [{"targetId": "44444444-4444-4444-8444-444444444444", "fqbn": "arduino:avr:uno", "options": {}}],
  "components": [],
  "nets": [],
  "codeBindings": [],
  "documents": [],
  "extensions": {}
}
```

The example assumes `RangeSensor/RangeSensor.ino` exists; it is not a complete runnable project by itself. Paths in the manifest are normalized project-relative paths with `/` separators. Absolute executable paths, credentials, transient COM addresses, raw serial logs, and database internals MUST NOT be stored here. External document references must be explicit and excluded from portable exports unless deliberately included. Disallow escaping the project through `..`, symlink/junction resolution, or alternate Windows path syntax for operations that promise project scope.

A component may remain unresolved with `definition: null` and `identityStatus: "unresolved"`. Candidate labels, evidence references, and user-entered provisional pin labels are allowed by the schema, but do not authorize electrical compatibility claims. Resolved components reference an immutable definition object. Net `intent` is an object containing optional domainId, designState (`proposed` or `accepted`), and sourceRefs; it is not a free-text field. D34 and D35 own their detailed semantics.

Presentation positions belong in a separate layout sidecar keyed by stable component IDs. Layout edits do not change electrical intent. Unknown top-level fields fail validation unless housed in the declared `extensions` namespace; known extension fields must survive supported edits. This prevents agents from inventing hidden configuration keys while preserving deliberate future extension points.

## Import algorithm

1. Resolve a local folder and discover sketch candidates without writing files.
2. Inventory relevant files, installed toolchain information, existing configuration, and dirty editor buffers.
3. Let the user select among ambiguous sketches/targets; do not infer a board from an unrelated connected USB device.
4. Record a baseline compile when the toolchain is ready. Failure remains a baseline failure, not permission to upgrade dependencies.
5. Create optional workbench metadata through a visible edit. Do not rename the sketch or move source.
6. Register project location and identity locally, then populate derived views.

The agent can propose dependency upgrades separately, with before/after validation. Import must remain useful when compilation is temporarily unavailable. Baseline record status explicitly distinguishes “not attempted,” “failed,” and “succeeded.”

## Editing and preservation

Manifest changes use optimistic concurrency against both projectRevision and current document/content identity. D13 governs dirty buffers. Accepted intent edits advance projectRevision and invalidate dependent physical confirmations. Direct text edits that are malformed remain intact and repairable; no automatic rewrite from the last valid database projection is allowed.

Source change review is independent of upload. Keeping agent edits does not flash a device. Reverting source does not restore old firmware, and restoring an old manifest does not move wires. Native KiCad files become independently authoritative after user editing; generated exports record their originating manifest revision and detect divergence before overwrite.

## Export and relocation

A project-only export includes ordinary files and metadata. A full evidence export additionally includes a consistent operational snapshot and selected immutable artifacts with a checksum inventory; no provider secrets. Exports record missing external dependencies honestly. Restore verifies paths/hashes before registering the project. Relocation retains identity when the original is not independently active; deliberate fork creates a new projectId and records lineage rather than merging histories accidentally.

## Errors and acceptance criteria

Unsupported future schema opens read-only with a compatibility message. Duplicate IDs block mutations. Missing sketch references show a repair action and do not create empty replacement files. Export during recording follows the snapshot procedure in D16 and never copies an actively changing main database file alone.

- **AC-D15-01:** Import an existing Uno sketch; source hashes remain unchanged until an explicit edit.
- **AC-D15-02:** Open the imported sketch in Arduino IDE without conversion or a workbench runtime dependency.
- **AC-D15-03:** Invalid manual JSON survives repair and never gets replaced by a stale projection.
- **AC-D15-04:** Full export/restore preserves evidence references and excludes test credentials.
- **AC-D15-05:** Copying a project does not silently combine two independent write histories.

## Sources

RESEARCH-RECORDED: [Sketch specification](https://docs.arduino.cc/arduino-cli/sketch-specification), [build process](https://docs.arduino.cc/arduino-cli/sketch-build-process), [platform specification](https://docs.arduino.cc/arduino-cli/platform-specification). Workbench manifest fields are proposed app contracts, not Arduino-standard fields. D31 owns exact version-tested CLI invocation.
