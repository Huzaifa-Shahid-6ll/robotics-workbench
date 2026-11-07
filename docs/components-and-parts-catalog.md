---
doc_id: D34
title: "Components and parts catalog"
status: implementation-spec
updated: 2026-11-01
depends_on: [D14, D15, D35, D38]
requirement_ids: [REQ-HW-34-01]
---

# Components and parts catalog

## Purpose and authority

**SPECIFIED — REQ-HW-34-01:** Model exact part definitions separately from project instances and inventory quantities. The manifest owns the intended assembly; the catalog supplies versioned component facts. A familiar name such as “L293D” MUST NOT silently resolve an IC, breakout, or shield to the same pin map. The initial curated set is the user's actual board/sensor/driver parts, expanded only when needed.

## Definitions and instances

A definition has an immutable definitionId/version, manufacturer/model/revision/package, classification, provenance references, logical pins/resources, physical connectors, capabilities, and electrical/mechanical facts. An instance has a stable componentId, display label, definition reference or unresolved identity, project role, and user observations. Renaming an instance does not change its ID. Replacing a definition version is a reviewed migration, not a silent catalog update.

An illustrative application structure is:

```json
{
  "componentId": "22222222-2222-4222-8222-222222222222",
  "definition": null,
  "label": "Front ultrasonic module",
  "identityStatus": "unresolved",
  "candidateLabels": ["HC-SR04"],
  "evidenceRefs": ["66666666-6666-4666-8666-666666666666"],
  "provisionalPins": [
    {"pinId": "vcc", "label": "VCC"},
    {"pinId": "trig", "label": "TRIG"},
    {"pinId": "echo", "label": "ECHO"},
    {"pinId": "gnd", "label": "GND"}
  ]
}
```

These provisional labels are user-entered intent, not an authoritative pin map. A photo or agent suggestion may propose identity but cannot automatically promote it to confirmed. Keep the component useful for notes/layout while checks depending on unknown facts say `not-checked`.

## Pin and quantity semantics

A logical resource owns its aliases and capabilities. Physical header positions may refer to the same logical signal. For Uno, alias resolution must handle analog/digital/peripheral names without allocating one signal twice. Pin selection includes the chosen mode because a PWM-capable pin may already serve another function. Power and ground connectors may have multiple physical access points without representing separate independent rails.

Each numeric specification MUST retain value, unit, classification (`recommended`, `absolute-maximum`, `typical`, `measured`, or `estimate`), conditions, applicability, source reference, and review status. Unknown is `null` plus reason, never zero. Minimum and maximum ranges use explicit bounds and inclusivity. Unit conversion preserves the original source value and rejects incompatible dimensions. A typical rating cannot be used as a guaranteed limit; an absolute maximum cannot be presented as a recommended operating point.

A source reference identifies document hash/version, URL when available, page or section, extraction method, and review provenance. Chip facts do not establish breakout connector labels, jumper wiring, regulator presence, or thermal behavior. A module definition can reference a chip definition as composition while owning its own connector facts.

## Editing and linking behavior

The components table and wiring canvas MUST issue revision-checked mutations against the same manifest, not maintain parallel writable lists. Adding a component creates an instance without inferring physical possession. Inventory quantity belongs to a separate local inventory record; deleting a project instance does not delete stock or its catalog definition. Definition deletion is refused while referenced unless an explicit archival migration preserves references.

Datasheet extraction creates candidate facts for review. Manual facts require an author/source note, even if the source is “measured by user.” Conflicting measurements remain separate observations. An agent can explain conflict but cannot erase less-convenient evidence. Code references are explicit bindings or discovered candidates; computed pin expressions remain unresolved until a supported analysis confirms them.

CSV import requires header mapping and preview. Unknown columns are preserved in import metadata or explicitly ignored; duplicate instance IDs fail validation. Export includes definition versions and source links necessary to interpret pins, while respecting original-document redistribution limitations. The catalog MUST be usable offline for already attached definitions.

## Error and migration behavior

Missing symbol, unknown package, changed pin map, inconsistent units, duplicate aliases, and unavailable datasheet are separate issues. Invalid definitions cannot become active. Updating a pin map invalidates affected connection checks, generated schematic mappings, and applicable physical confirmations; it does not silently reroute wires. Keep a machine-readable migration diff with old/new endpoint mappings and unresolved references.

**VALIDATION-GATE:** Confirm the actual Uno variant, ultrasonic module markings, and whether the L293D is an IC or module before assigning definitive part facts. Documentation can proceed with unresolved identities; only affected electrical checks and fabrication claims are blocked.

## TASK-07 implementation boundary

**IMPLEMENTED:** `ComponentDefinition` version1, validation, alias resolution,
dimension-safe conversion and explicit pin-map migrations live in contracts/domain.
Optional ordinary `components/catalog.json` contains
`{"schemaVersion":1,"definitions":[]}`; attached definitions remain usable offline.
The companion refuses different content under an already observed definition
ID/version. Numeric facts retain classification, conditions, applicability and
review provenance. Unknown values retain a reason and remain null.

The built-in Uno R3 A000066 reference contains reviewed external pin aliases and
mode capabilities only. It is never selected from an instance label or USB port.
Voltage/drive limits remain unknown. The actual user's board/module identity
gate still applies. Source locations/hashes and review scope are retained in
`packages/test-fixtures/components/README.md`; synthetic electrical facts are
labelled software fixtures. CSV import, inventory and document extraction belong
to later scoped work; they are not claimed by this task's catalog editor.

## Acceptance criteria

- **AC-D34-01:** Two component instances can share one immutable definition while retaining independent observations and connections.
- **AC-D34-02:** Alias collisions resolve to one logical resource; ordinary display-label changes do not invalidate IDs.
- **AC-D34-03:** Unknown identity produces `not-checked`, not a false safe or failed electrical verdict.
- **AC-D34-04:** Definition upgrades produce explicit migration diffs and cannot silently alter pin assignments.
- **AC-D34-05:** Source-backed, measured, and estimated dimensions remain distinguishable in UI, exports, and agent context.

## Sources and related documents

- [Uno R3 official pinout](https://docs.arduino.cc/resources/pinouts/A000066-full-pinout.pdf), [Uno hardware](https://docs.arduino.cc/hardware/uno-rev3), [TI L293/L293D datasheet](https://www.ti.com/lit/ds/symlink/l293d.pdf) — RESEARCH-RECORDED, 2026-10-31; part applicability still requires review.
- [KiCad common format](https://dev-docs.kicad.org/en/file-formats/sexpr-intro/) — RESEARCH-RECORDED pin/instance vocabulary.
- [Domain model](domain-model-and-identifiers.md), [wiring validation](wiring-model-and-validation.md), [datasheet ingestion](datasheet-and-document-ingestion.md).
