---
doc_id: D47
title: Accessibility responsive layout and motion
status: implementation-spec
updated: 2026-11-01
depends_on: [D07, D42, D43, D44, D45]
requirement_ids: [REQ-UX-47]
---
# Accessibility, responsive layout, and motion

## Authority and target

**SPECIFIED:** Every custom view must remain usable by keyboard, with screen-reader navigation, at increased zoom, and in light/dark/high-contrast themes. The primary practical target is the user's 1366×768 Windows display, i5-9500, 16 GB RAM, and integrated graphics. This is a product acceptance target, not proof of any accessibility certification. Native VS Code accessibility behavior should be reused rather than recreated. Domain canvases must have equivalent structured views.

D42 owns token values; this document owns behavior under constrained width, assistive interaction, and reduced motion. Budgets in D07 take precedence over aesthetic animation preferences.

## Layout rules

Custom layouts respond to their actual container width, not only the desktop width. The host user controls sidebar/editor splits; do not resize unrelated host panels or reopen hidden inspectors on each selection.

| Available custom-view width | Required arrangement |
|---|---|
| 900px and above | Main content with optional 280px inspector; user may collapse it |
| 600–899px | Main content; inspector replaces or overlays content on explicit request |
| 320–599px | Single column, wrapped action labels, progressive disclosure |
| Below 320px | Essential status plus open-in-editor action; no unreadable squeezed canvas |

These thresholds are proposed CSS layout defaults, not forced host window widths. The agent composer remains reachable without horizontal scrolling. Toolbars move secondary actions into a labelled More actions menu. Do not hide current device identity or operation outcome merely to save space. Tables may horizontally scroll within their region, but row identity and navigation controls remain available. A canvas can pan and zoom; ordinary prose and forms must reflow.

At 1366×768, the supported default is one working editor plus an optional agent pane. A context inspector or component properties panel can replace the agent subview or open a tab. Four permanently visible columns are prohibited. At 200% zoom, text wraps and controls grow; truncation provides full value by focus/copy and cannot hide the distinguishing part of a device label.

## Keyboard and focus contract

Tab traverses meaningful controls in visual order; Shift+Tab reverses. Standard buttons activate with Enter/Space. Menus, lists, and trees use their expected arrow-key behavior. Escape exits a transient interaction and restores focus to its invoker. Focus must never jump to a streaming response automatically. Opening a requested inspector moves focus to its heading or first relevant control; closing it returns focus to the originating row/node.

Canvas interactions require a connection table alternative supporting endpoint selection, connection creation, inspection, and removal. No core wiring action may require dragging. Plots expose channel selection, exact interval inputs, summary values, and data-table/export options. CAD preview provides labelled reset/orbit controls where feasible and an artifact/source alternative; do not claim a text description conveys full geometry.

When an item disappears during refresh, focus moves to the next meaningful item or section heading and announces the change. Modal input is limited to genuinely blocking decisions; nonblocking tool progress stays within the relevant view. Host shortcuts take precedence. A global shortcut is not a substitute for a discoverable control.

## Semantic structure and announcements

Use actual buttons, labels, tables, headings, and form elements. Virtualized content must expose useful counts and selected state. Icons need accessible names; decorative icons are hidden from assistive technology. Expanded panels expose expanded/collapsed state. Validation messages associate with fields and a summary links to invalid entries.

Operation status changes are announced at coarse transitions, not every token, byte, or chart sample. Announce Running, Waiting for input, Completed, Failed, Cancelled, or Outcome unknown with the operation name. A live serial stream must not flood announcements; provide a deliberate read-current-window action. Provider completion and hardware completion are separate announcements. Never use a success sound or confetti for an unverified physical result.

## Contrast, color, and motion

Proposed acceptance thresholds are at least 4.5:1 for normal text, 3:1 for large text, and 3:1 for meaningful control/focus boundaries, with manual review of host-derived themes. Information must not depend on color alone. Chart lines pair color with labels/patterns; wiring status pairs text and icons. High-contrast themes display explicit selected/focus outlines.

Default motion is brief and functional: 100–150ms opacity or disclosure transitions; no spring overshoot, parallax, decorative looping, or animated camera moves on selection. Respect `prefers-reduced-motion` and host accessibility configuration available to the implementation. In reduced-motion mode, transitions are immediate and scrolling/reframing is not animated. A spinner may indicate unknown progress but cannot imply a percentage. Pause rendering when a graphics view is hidden; recording continues according to the service state.

## Failure behavior and validation gates

If a GPU/WebGL viewer fails, keep source and export controls available with a precise viewer error. If a theme token is absent, use D42 role-preserving fallbacks. If the screen reader cannot meaningfully operate a canvas, the structured equivalent is mandatory, not optional help. Accessibility defects affecting core workflows block the release even if the default mouse layout looks correct.

- **AC-D47-01:** Complete import, agent task, review, compile, board selection, and upload-detail inspection with keyboard only.
- **AC-D47-02:** Operate wiring through its table without pointer dragging.
- **AC-D47-03:** At 1366×768 and 200% zoom, primary actions and explanatory errors remain reachable with no clipped text.
- **AC-D47-04:** Test a Windows screen reader against status transitions, validation, and focus restoration; record actual version and result.
- **AC-D47-05:** Reduced-motion mode removes nonessential animation; hidden graphics views stop rendering while capture status remains correct.
- **AC-D47-06:** Audit three theme families with measured contrast plus manual inspection; record exceptions instead of claiming blanket compliance.

Sources: **SOURCE-VERIFIED** [VS Code UX](https://code.visualstudio.com/api/ux-guidelines/overview) and [Webview API](https://code.visualstudio.com/api/extension-guides/webview), accessed 2026-11-01. Thresholds and breakpoints above are product requirements. Related: [tokens](design-tokens-and-theming.md), [components](component-and-interaction-contracts.md), [quality budgets](quality-and-performance-budgets.md).
