---
doc_id: D35
title: "Wiring model and validation"
status: implementation-spec
updated: 2026-11-01
depends_on: [D14, D15, D27, D34]
requirement_ids: [REQ-HW-35-01]
---

# Wiring model and validation

## Purpose and authority

**SPECIFIED — REQ-HW-35-01:** The wiring table and canvas are two views of one manifest-owned intended connection model. The canvas is a project wiring view, not a circuit simulator or proof of physical continuity. A line on screen never establishes a measured connection. D35 owns nets, endpoint resolution, validation rules, and physical-confirmation invalidation.

## Core representation

A net is an unordered set of logical endpoints, not an ordered workflow edge. An endpoint identifies componentId and stable pinId; rendered connector positions and aliases resolve to that pin/resource. Canvas positions, bend points, zoom, and grouping are presentation data and MUST NOT change electrical connectivity. Crossing visual lines do not imply connection; junctions only reflect explicit net membership.

```json
{
  "netId": "77777777-7777-4777-8777-777777777777",
  "label": "Front sensor trigger",
  "members": [
    {"componentId": "88888888-8888-4888-8888-888888888888", "pinId": "digital-7"},
    {"componentId": "22222222-2222-4222-8222-222222222222", "pinId": "trig"}
  ],
  "intent": {
    "domainId": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    "designState": "proposed",
    "sourceRefs": []
  }
}
```

This example is illustrative and requires resolved definitions before electrical checks. Actual supply voltage and tolerance are source-backed domain facts, not deduced from the domain ID. Physical observations are separate records with net/endpoint scope, projectRevision, observer, procedure, timestamp, result, and evidence references. No default `physicallyVerified: true` field is allowed.

## Mutation protocol

A command MUST carry projectId, expectedProjectRevision, stable affected IDs, and explicit add/remove/change operations. Validate the entire patch before atomically replacing the manifest; increment projectRevision once for a successful design transaction. If another view or external edit changed the revision, reject with a conflict and refreshed snapshot. Never merge endpoint changes merely because line geometry appears similar.

Dragging a wire proposes endpoint membership, then shows a preview of consequences. Users can undo manifest changes through the host integration; undo does not move a real wire or rewind an upload. Deleting a component requires a preview of removed endpoints and invalidated bindings. Net merges/splits preserve a migration record so historical experiment references remain interpretable. Use explicit code bindings to propose firmware edits; do not run broad text replacements of every numeric pin value.

## Deterministic rule results

Each result includes ruleId/version, severity, outcome, affected IDs, projectRevision, source facts used, and explanation. Outcomes are `pass`, `fail`, `not-checked`, or `not-applicable`; these are validation outcomes, not job statuses. A rule set can complete successfully while reporting failing rules.

| Rule family | Required information | Failure or limitation |
|---|---|---|
| Referential integrity | Component and pin IDs | Missing endpoint is an error |
| Alias/resource allocation | Alias map and selected modes | Conflicting exclusive use is an error |
| Signal direction | Pin electrical types | Known incompatible driven outputs flagged |
| Supply/domain compatibility | Reviewed voltage limits and conditions | Known incompatibility flagged; missing facts not checked |
| Required connections | Definition requirements | Missing required endpoint flagged |
| Bus participation | Bus type and roles | Shared buses allowed where valid, not blanket duplicate rejection |
| Firmware binding consistency | Resolved source binding | Unresolved expressions remain unknown |

A shared bus can require constraints beyond pin connectivity; partial support MUST disclose unchecked address, pull-up, speed, loading, and firmware conditions. The first release need not solve arbitrary electrical analysis. It MUST avoid claiming “safe circuit” from a finite rule list. KiCad ERC is an additional separately scoped check, not a substitute for these semantics.

## Freshness and physical confirmation

Any design change conservatively makes revision-scoped physical confirmations stale. Later dependency-aware reuse may retain unaffected observations only with explicit applicability reasoning; the initial implementation should favor truthful staleness. Store the original observation unchanged. Build, upload, schematic export, and experiment records link to the design revision they used. Newer source or wiring does not rewrite historical evidence.

A confirmation workflow states which endpoints were inspected, how, and at what revision. Photos may supplement observations but cannot establish hidden continuity or voltage. User confirmation is a claim with provenance, not an instrument reading. Agent context must distinguish planned, user-confirmed, measured, stale, and unknown states.

## Errors and acceptance criteria

**IMPLEMENTED — TASK-07:** Version1 operations produce one validated plan with
canonical unordered nets, rule results, inverse operations and consequences.
Renames preserve component IDs; explicit source bindings do not rewrite firmware.
Known failing error rules block acceptance. Unknown/candidate facts are
`not-checked` and remain visible. Reviewed open-drain bus membership is allowed;
addresses, loading, pull-ups, speed and firmware constraints remain unchecked.

The Components & Wiring editor uses native text edits after exact revision/hash,
clean-buffer and document-version checks. It retains baseline/proposed bytes
before applying. An intervening user/provider edit conflicts without reverting
the file. Undo previews inverse intent against the exact last accepted bytes and
creates a newer revision. Native editor undo is ordinary source editing and may
require revision reconciliation. `.workbench-layout.json` stores geometry with
its own revision/hash; moving a component never changes projectRevision.
Semantic no-ops retain the existing design revision.

Accepted migrations and user-reported observations are immutable operational
records. Reports retain actor, procedure, exact revision, result and evidence;
they are never inferred measurements. Any changed design makes older reports
stale without rewriting them. Hardware upload and physical verification remain
separate operations. Browser fixtures and native software tests do not establish
real-board continuity, voltage, identity or safety.

Malformed external manifest edits suspend mutations and show parse errors without overwriting the file. Preserve a recoverable last valid snapshot for read-only display and label it stale. Unsupported component types remain representable; checks requiring their facts are disabled specifically.

- **AC-D35-01:** Canvas and table changes produce identical canonical nets; dragging layout alone leaves electrical semantics unchanged.
- **AC-D35-02:** Two simultaneous edits cannot lose connections silently; stale revision writes are rejected.
- **AC-D35-03:** Aliased pins conflict correctly while a supported shared bus is not rejected merely for multiple endpoints.
- **AC-D35-04:** Unknown limits cannot produce a passing voltage check or a fabricated value.
- **AC-D35-05:** Rewiring invalidates applicable physical confirmations and leaves historical experiments intact.
- **AC-D35-06:** A visual crossing without explicit net membership remains electrically disconnected in export.

## Sources and related documents

- [Uno pinout](https://docs.arduino.cc/resources/pinouts/A000066-full-pinout.pdf), [KiCad schematic format](https://dev-docs.kicad.org/en/file-formats/sexpr-schematic/) — RESEARCH-RECORDED, 2026-10-31.
- Rules above are SPECIFIED application behavior, not electrical certification.
- [Components](components-and-parts-catalog.md), [KiCad handoff](kicad-generation-and-handoff.md), [context freshness](context-provenance-and-freshness.md).
