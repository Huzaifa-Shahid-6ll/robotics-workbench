---
doc_id: D43
title: Information architecture and navigation
status: implementation-spec
updated: 2026-11-01
depends_on: [D13, D14, D41]
requirement_ids: [REQ-UX-43]
---
# Information architecture and navigation

## Purpose and boundaries

**SPECIFIED:** This document owns where users find work, how views link to one another, and how selections cross view boundaries. It does not own persisted project schemas, provider session formats, or hardware operation rules. Those remain D14, D22, and D32. The host workbench is the navigation shell. Do not add an application-level sidebar inside every editor tab.

**SOURCE-VERIFIED:** VS Code offers sidebar views, editor areas, panel containers, status items, and command contributions. Custom webviews are reserved for domain interactions that native controls do not adequately express. These host facts were checked against official UX guidance on 2026-11-01.

## Navigation map

| Surface | Content | Default implementation |
|---|---|---|
| Existing Explorer | Ordinary source files and folders | Unmodified native Explorer |
| Robotics view container | Project, components, connections, runs, references | Native tree views with contextual actions |
| Agent view | Provider/session, conversation, task actions, context chips | Movable webview view |
| Main editor | Code, wiring, components table, schematic, CAD, run detail/comparison, documents | Native text/diff when applicable; lazy custom views otherwise |
| Bottom area | Problems, terminal, build output; optional serial console | Reuse native views; custom serial view only for capture controls |
| Status bar | Selected board/port summary and current operation | Compact items, click for details |
| Settings | Paths, provider preferences, capture defaults, display options | Native settings plus readiness overview |

Users may move views through host mechanisms. The extension MUST not force a saved arrangement on every activation. First-run may suggest opening the agent beside code, but must not replace the user's existing workbench layout. Closing a view does not cancel its underlying operation; the remaining status indicator links back to it.

## Stable navigation contract

Internal view targets use stable domain IDs, not display names. The following is a proposed app-level navigation payload, not a public VS Code API:

```json
{
  "schemaVersion": 1,
  "projectId": "11111111-1111-4111-8111-111111111111",
  "projectRevision": 12,
  "view": "component",
  "entityId": "22222222-2222-4222-8222-222222222222",
  "origin": "wiring",
  "focus": "inspector",
  "reveal": true
}
```

The UUIDs above are synthetic fixture identities and MUST NOT be reused for real projects. Editable labels such as “Front range sensor” are not foreign keys. `projectRevision` describes the selected design snapshot. Source selections additionally carry URI and document version; run selections carry immutable run/artifact IDs. The application MUST not reinterpret a historical target as the latest revision without showing that change. Unknown/deleted entities open a tombstone explanation with a link to available history, not the first matching name.

Selecting a component updates highlight and a small selection summary. It MUST NOT automatically submit a prompt, start a job, or replace an existing editor tab. Explicit Open wiring/Open code/Open datasheet actions navigate. “Ask about selection” copies a revision-bound reference into the composer; sending remains a separate action. Code can reference several components, so cross-links list candidates rather than guessing one.

## Command discoverability

D13 owns final registered command identifiers. All user-facing workbench commands MUST use the display prefix `Robotics:` and be reachable from Command Palette. Proposed actions include Open Project, Check Tools, Select Board, Compile, Upload Artifact, Open Serial Monitor, Open Wiring, Open Components, Open Runs, Inspect Context, and Review Task Changes. Menus reuse those commands rather than implementing duplicate operation logic.

No default shortcut may override common editing or terminal commands. Toolbar icons MUST have text tooltips and accessible names. Command titles distinguish `Compile` from `Upload`; a generic Run button is prohibited where the operation is ambiguous. Context menu actions show the exact component/file/device target when several are available.

## Multi-root, history, and empty states

Every tree root and agent session belongs to an explicit project. Multi-root workspaces show project labels and preserve the active project independently from the active text tab. Hardware actions require an unambiguous project plus selected target; opening a file from another root does not silently retarget an upload.

Navigation history stores view targets and UI state, never credentials or large artifact payloads. Back restores the selected entity and scroll position when it still exists. Editor pinning follows native expectations. A project with no components displays Add component and Import reference actions; it must still allow ordinary code editing and compilation. A disconnected board affects device actions, not source navigation.

## Recovery and acceptance

If a webview is destroyed, reconstruct from durable IDs and safe local view state. If a source moved, resolve through recorded identity where possible and show the new location; never invent a page citation. A stale navigation request may inspect historical data read-only but cannot authorize a current mutation.

- **AC-D43-01:** From a selected component, reach code, wiring, docs, and latest applicable run without re-searching its name.
- **AC-D43-02:** Hiding the agent at 1366×768 restores useful editor width without interrupting a task.
- **AC-D43-03:** Two projects with identically named components remain correctly scoped.
- **AC-D43-04:** Every visible action has a Command Palette or keyboard-accessible equivalent.
- **AC-D43-05:** Closing/reopening a view restores selection but does not duplicate an operation.

Sources: [VS Code UX overview](https://code.visualstudio.com/api/ux-guidelines/overview), [Webviews](https://code.visualstudio.com/api/extension-guides/webview), accessed 2026-11-01. Related: [screen specifications](screen-specifications.md), [journeys](journeys-states-and-recovery.md), [internal protocol](internal-api-and-webview-protocol.md).
