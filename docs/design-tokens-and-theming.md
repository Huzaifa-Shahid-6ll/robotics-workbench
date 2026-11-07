---
doc_id: D42
title: Design tokens and theming
status: implementation-spec
updated: 2026-11-01
depends_on: [D13, D41]
requirement_ids: [REQ-UX-42]
---
# Design tokens and theming

## Purpose and authority

**SPECIFIED:** This document owns custom-webview token roles. Native trees, dialogs, buttons, editors, and Quick Picks retain native styling. The values below are chosen product defaults derived from D41; they are not claimed as extracted production CSS. Changes to spacing or component size must update this document and visual fixtures together.

**SOURCE-VERIFIED:** VS Code exposes theme colors and webview font variables. A contributed webview must follow the active host theme. See the official sources at the end. The implementation MUST not assume the user uses a dark theme or a particular installed font.

The authoritative machine-readable values are [contracts/design-tokens.json](../contracts/design-tokens.json). This document owns their meaning and acceptance rules. Changes MUST update both; a mismatch fails documentation validation. The JSON is a data specification, not implemented theme code.

## Token mapping

| Product role | Webview CSS source/fallback |
|---|---|
| Canvas | `var(--vscode-editor-background)` |
| Primary text | `var(--vscode-editor-foreground)` |
| Secondary text | `var(--vscode-descriptionForeground, var(--vscode-editor-foreground))` |
| Divider | `var(--vscode-panel-border, var(--vscode-contrastBorder, transparent))` |
| Focus outline | `var(--vscode-focusBorder)` |
| Link | `var(--vscode-textLink-foreground)` |
| Field background/text | `--vscode-input-background` / `--vscode-input-foreground` |
| Field border | `--vscode-input-border`, then contrast border |
| Primary action | `--vscode-button-background` / `--vscode-button-foreground` |
| Primary hover | `--vscode-button-hoverBackground` |
| Selection | `--vscode-list-activeSelectionBackground` / corresponding foreground |
| Error text | `--vscode-errorForeground` |
| UI font | `--vscode-font-family`, size `--vscode-font-size`, weight `--vscode-font-weight` |
| Code font | `--vscode-editor-font-family`, size `--vscode-editor-font-size`, weight `--vscode-editor-font-weight` |

These are CSS variable spellings; API theme identifiers use dots, for example `editor.background`. An undefined token MUST receive a role-preserving fallback. A missing border cannot be the only indicator of focus or selection. Do not apply opacity to whole controls to implement disabled states: preserve readable text, remove activation, and expose the reason.

## Geometry and typography

| Token | Value / rule |
|---|---|
| Space scale | 4, 8, 12, 16, 24, 32 CSS px |
| Related controls gap | 8px; compact icon groups 4px |
| Panel interior padding | 12px; dense table cell horizontal padding 8px |
| Control radius | 4px |
| Grouped content radius | 6px |
| Separators | 1px; focus outline 2px with 2px offset |
| Control minimum target | 24×24 CSS px; visible icon may be 16px |
| Compact table row | minimum 28px, grows for font/zoom |
| Default line height | 1.45 for prose, 1.5 for logs |
| Local title | 1.15em, weight 600; no display headlines |
| Small metadata | minimum 12px equivalent, never reduce user font preference |
| Shadows | none by default; overlays may use host widget shadow |

Dimensions are minima, not clipped fixed heights. Tokens MUST be exposed centrally, not copied into individual components. Code samples and numeric measurements use a monospace role; ordinary labels remain UI text. Use tabular numerals where supported without changing the host typeface. Long hashes display a short prefix with full value available by keyboard/copy; shortened hashes are presentation only.

## Semantic color and chart rules

Status always includes icon plus text. `succeeded`, `failed`, `cancelled`, and `outcome-unknown` MUST remain distinguishable in grayscale. Unknown outcomes are not successes with a warning badge. Stale context gets a textual freshness label; muted color alone is insufficient.

Chart series use an explicit stable `seriesKey -> styleIndex` mapping persisted for the comparison session. Initial proposed categorical colors are blue `#0072B2`, orange `#E69F00`, green `#009E73`, purple `#CC79A7`, cyan `#56B4E9`, and vermilion `#D55E00`; these are product choices, not Refero token values. Pair color with dash/marker patterns and labels. A contrast gate MUST validate series against the active background; adjust luminance without changing legend identity. More than six series use an accessible legend and configurable isolation rather than unlimited similar colors.

Wiring categories MUST not borrow chart color semantics. Errors, selection, net identity, and physical confirmation each need distinct labels. Voltage domains can use named badges; never equate green with an electrically safe circuit.

## Theme change and failure behavior

Theme changes apply live without losing selected component, cursor position, chart interval, or draft message. Canvas renderers must redraw their colors while keeping their transform. A renderer that cannot support the active high-contrast theme MUST offer its equivalent connection table or data table; it cannot silently hide the content. Rendering exceptions show a readable error boundary with Open source/Retry view actions; those actions never retry hardware operations.

## Acceptance and references

- **AC-D42-01:** Theme switches retain view state and produce no hardcoded light rectangle in a dark view.
- **AC-D42-02:** At 200% zoom no text is vertically clipped by fixed control heights.
- **AC-D42-03:** Charts remain interpretable with colors removed and values available in a table.
- **AC-D42-04:** Token lint rejects new raw UI colors outside the token module and explicit chart palette.
- **AC-D42-05:** Render and inspect normal, hover, focus, disabled, selected, error, and stale states in all three theme families.

Sources accessed 2026-11-01: [Theme colors](https://code.visualstudio.com/api/references/theme-color), [Webview theming](https://code.visualstudio.com/api/extension-guides/webview). Related: [D41](design-reference-ledger.md), [D45](component-and-interaction-contracts.md), [D47](accessibility-responsive-layout-and-motion.md). These checks remain implementation gates.
