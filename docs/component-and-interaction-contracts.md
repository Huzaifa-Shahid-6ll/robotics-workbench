---
doc_id: D45
title: Component and interaction contracts
status: implementation-spec
updated: 2026-11-01
depends_on: [D18, D42, D44]
requirement_ids: [REQ-UX-45]
---
# Component and interaction contracts

## Purpose and authority

**SPECIFIED:** This document owns reusable presentation contracts. Domain validation remains in the service; disabling a button is not an authorization boundary. Components emit typed intents and display confirmed state. Native VS Code controls are preferred for native functions; the following contracts apply when a custom view is needed. No component may invoke a shell, read arbitrary local files, or access provider credentials directly.

## Shared component input

The following TypeScript is an illustrative app contract; implementation exports should be generated or checked against D18 rather than copied independently:

```ts
type OperationStatus = 'queued' | 'running' | 'awaiting-input' |
  'succeeded' | 'failed' | 'cancelled' | 'outcome-unknown';
type ActionAvailability =
  | { enabled: true }
  | { enabled: false; reason: string; remedyCommand?: string };
interface EntityRef {
  projectId: string;
  projectRevision: number;
  entityId: string;
}
interface ViewData<T> {
  value?: T;
  state: 'loading' | 'ready' | 'empty' | 'stale' | 'error';
  observedAt?: string;
  error?: { code: string; message: string };
}
```

IDs are stable opaque values. Dates are machine ISO timestamps formatted for display, with absolute value available in details. Local UI state such as expanded rows and canvas position must not increment `projectRevision`. A pending mutation may show a local pending indicator, but final committed identity comes from service acknowledgement.

## Component catalog

| Component | Required input | Output/intents | Critical invariant |
|---|---|---|---|
| OperationRow | operationId, type, status, target, progress phase, capabilities | inspect, requestCancel | No generic percent unless measurable; cancellation is a request |
| EvidenceChip | source ID, version, location, freshness, inclusion state | open, pin/unpin | Unpin does not delete evidence |
| EntityTable | stable rows, columns, selection, sort/filter | select, editDraft, requestCommit | Row index is never identity |
| PropertyInspector | entity reference, fields, validation, baseline revision | patch proposal, reset draft | Stale baseline cannot silently overwrite newer fields |
| ConnectionEditor | endpoint IDs, net ID, validation | propose connect/disconnect | Display segments do not define net semantics |
| TaskChangeRow | baseline/current/proposed references, effect state | diff, apply/dismiss OR keep/revert | Actions reflect whether writes already occurred |
| LogViewer | bounded event window, cursor, gaps, capture state | fetch page, pause display, copy | Pausing scroll does not stop capture |
| PlotPanel | channel schema, series data, time basis, units, style IDs | select interval, isolate, export | Downsampled display is not raw evidence |
| SourceCitation | source version, page/location, excerpt bounds | reveal source | Missing source does not navigate to an unrelated latest file |
| ToolReadinessRow | detected version/path, check time, capability states | configure, test, inspect | Executable detection does not mean authenticated/usable |
| EmptyState | reason, permitted actions | invoke named command | Does not turn absent hardware into an error for offline work |
| InlineError | error code, operation/source ID, safe remedy | inspect/retry-read | No mutation replay from generic retry |

## Form, table, and action behavior

Forms maintain a draft separate from committed domain state. Validate on blur and submit; do not erase invalid input. Error summaries link to fields. Save sends expected revision and typed changes, then shows the resulting committed revision. Conflict returns the user's draft with a comparison action. Enter in a multiline composer inserts a line break unless an explicit send shortcut is chosen; the displayed shortcut must match the configuration. Escape closes transient menus or cancels a local draft only after preserving/confirming unsaved edits where necessary; it never silently interrupts hardware.

Tables use stable sorting and preserve selected IDs during refresh. A filter hiding the current selection shows that fact in details. Large tables may virtualize, but accessible row counts and navigation must remain meaningful. Destructive actions are not hidden behind ambiguous trash icons alone; name the entity and affected references. Batch actions operate on the explicit selected ID set, not all rows that happen to be visible after a refresh.

Action requests carry a unique request ID. Disable duplicate submission while the same request is pending, but do not assume this replaces service idempotency. If a response is lost, query the operation before resubmitting. Buttons for new artifacts require explicit selection when multiple outputs exist. Menus and toolbar buttons call the same registered action contract.

## Rendering and recovery

Render untrusted content as escaped text or sanitized supported markup. Provider-supplied links and paths must pass host validation before navigation. A markdown command-looking string is content, not authority. Webviews report errors through an error boundary and offer reload view; underlying jobs continue or reconcile according to their service state. Component teardown releases listeners and graphics resources, not jobs merely because they are offscreen.

Async responses include their request scope. Ignore stale responses for a different project or selection while retaining them in the operation record if appropriate. Optimistic display is allowed for reversible presentation changes, such as collapse state; electrical intent, upload status, and physical confirmations use confirmed domain events.

## Acceptance and sources

- **AC-D45-01:** Double-clicking Upload issues one logical request; a lost response triggers status reconciliation rather than duplicate upload.
- **AC-D45-02:** A stale inspector preserves its draft and presents conflict resolution without overwriting current data.
- **AC-D45-03:** Filtering/sorting never changes the target of a pending row action.
- **AC-D45-04:** Every interactive icon has an accessible name, focus state, and keyboard activation.
- **AC-D45-05:** Malicious serial/provider markup cannot execute scripts or trusted commands.

Source-verified host constraints: [VS Code webviews](https://code.visualstudio.com/api/extension-guides/webview), accessed 2026-11-01. Product interactions are specified from [D41](design-reference-ledger.md). Related: [protocol](internal-api-and-webview-protocol.md), [security](security-and-data-boundaries.md), [accessibility](accessibility-responsive-layout-and-motion.md).
