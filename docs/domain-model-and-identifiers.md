---
doc_id: D14
title: "Domain model and identifiers"
status: implementation-spec
updated: 2026-11-01
depends_on: [D11]
requirement_ids: [REQ-ARCH-01]
---

# Domain model and identifiers

## Authority

**SPECIFIED:** This document is the glossary and identity authority for application contracts. Names below are workbench concepts, not claims about vendor APIs. Each serialized object has an explicit schema version where it crosses a persistence or IPC boundary. Schema version 1 is the initial design; a UUID is a stable identity, not a human label.

## Entities and relations

| Entity | Identity and essential fields | Ownership |
|---|---|---|
| Project | projectId, projectRevision, manifest URI | Manifest plus host binding |
| Component definition | definitionId, definitionVersion, pin capabilities, source refs | Versioned catalog record |
| Component instance | componentId, definition reference, label | Manifest |
| Pin reference | componentId + canonical pinId | Definition within project |
| Net | netId, member pin references, declared intent | Manifest |
| Compiler target | targetId, fqbn, board options | Manifest configuration |
| Device | deviceId, identity evidence, last observed transport | Operational records |
| Source snapshot | sourceSnapshotId, input inventory and hashes | Immutable artifact registry |
| Build | buildId, sourceSnapshotId, configuration fingerprint, outputs | Operational records |
| Upload | uploadId, buildId, artifact digest, deviceId, operationId | Operational records |
| Recording | recordingId, deviceId, capture metadata, raw artifact | Operational records and artifacts |
| Experiment | experimentId, applicable build/upload/design references, observations | Operational records |
| Session | sessionId, provider, opaque provider session reference | Operational records |
| Operation | operationId, kind, status, targets, timestamps | Operational records |

Project, component instance, net, target, device, build, upload, recording, experiment, session, and operation IDs MUST be generated UUIDs. Labels such as `front-range` are editable aliases and MUST NOT serve as foreign keys. A sourceSnapshotId is a UUID identifying an immutable inventory; content hashes separately prove its bytes. Definition identity MAY use a namespace string plus version because it identifies a catalog specification rather than an instance.

## Revisions, versions, and hashes

`projectRevision` is a positive monotonically increasing integer for accepted design-intent manifest changes. It is not an editor document version, build number, or provider turn index. Presentation-only layout changes do not invalidate electrical confirmation; keep layout in a sidecar with its own revision. An implementation that keeps layout within the manifest MUST compute semantic intent changes separately and preserve this distinction.

Every mutation checks the current authoritative manifest and expected revision. External manual edits that do not increment the revision are detected by manifest content hash: the service assigns the next accepted revision through a reviewed host edit or treats the document as needing reconciliation. Never accept changed meaning under an unchanged revision as current evidence.

`sourceSnapshotId` captures exact saved source bytes used for a build. SHA-256 identifies individual artifact bytes and inventories. A configuration fingerprint covers tool versions, FQBN/options, core/compiler/library identities, local library modifications, and flags. Equal source hashes alone do not establish equal firmware.

## Physical identity and evidence

`deviceId` is a workbench identity associated with observed evidence. `COM3` is a transport address, not a durable identity. USB serial numbers may be missing or duplicated; VID/PID identify a class, not necessarily one board. On ambiguous reconnection, require target confirmation rather than silently assigning the previous identity. Compiler target `fqbn` and physical board observation are separate fields.

Pins resolve aliases to one canonical resource. For example, a definition may map a digital alias and an analog alias to the same pin; conflict checks operate on the canonical pinId. Net membership describes an intended electrical relationship, not measured continuity. Definition limits need units, provenance, and uncertainty; an unknown voltage tolerance is not safe compatibility.

Observations MUST record source kind, actor or instrument, timestamp, applicable revisions/artifacts, and evidence reference. D27 owns the claim-basis enum: `planned`, `reported`, `measured`, and `inferred`. Verification is a separate scoped judgment with result `passed`, `failed`, or `inconclusive`, a procedure, and an acceptance criterion. A model-generated explanation is inferred interpretation, not measurement. Contradicting observations remain stored until an explicit resolution links them.

## Illustrative object fragment

```json
{
  "schemaVersion": 1,
  "projectId": "11111111-1111-4111-8111-111111111111",
  "projectRevision": 4,
  "componentId": "22222222-2222-4222-8222-222222222222",
  "label": "Front range sensor",
  "definition": {"definitionId": "generic:hc-sr04", "definitionVersion": "1"},
  "sourceSnapshotId": "33333333-3333-4333-8333-333333333333"
}
```

This demonstrates naming and identity only; it is not a complete component schema or measured hardware record. Example UUIDs are fixtures and MUST NOT be reused for real projects.

## Errors and acceptance criteria

Reject duplicate IDs, unresolved pin references, invalid UUID formats, nonpositive revisions, and unsupported schema versions. A missing artifact creates an explicit broken-evidence state rather than deleting its historical record. A copied project with the same projectId requires an explicit “same project at new location” or “fork with new identity” choice before simultaneous write access.

- **AC-D14-01:** Renaming a component preserves its net and experiment references.
- **AC-D14-02:** Two aliases for one physical pin cannot evade a pin conflict rule.
- **AC-D14-03:** Reassigning a COM address does not automatically identify a different board as the previous device.
- **AC-D14-04:** A wiring edit invalidates applicable physical confirmation while retaining the original observation.
- **AC-D14-05:** Identical source with different core/library configuration produces distinguishable build records.

## Sources and related documents

These schemas are SPECIFIED project choices informed by research tracks on component modeling, project state, and provenance. Primary anchors: [Arduino platform specification](https://docs.arduino.cc/arduino-cli/platform-specification), [Arduino sketch specification](https://docs.arduino.cc/arduino-cli/sketch-specification). Read [D15](project-format-and-firmware-preservation.md), [D16](storage-and-migrations.md), D34, D35, and D39 before expanding an entity.
