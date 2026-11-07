---
doc_id: D41
title: Design reference ledger
status: implementation-spec
updated: 2026-11-01
depends_on: [D03, D13]
requirement_ids: [REQ-UX-41]
---
# Design reference ledger

## Purpose and authority

**SPECIFIED:** This document owns the approved visual direction and the bounded role of each external reference. D42 owns implementation tokens; D44 owns screen behavior. The user approved the twelve Refero screens below. Approval covers inspiration, not a pixel-identical clone or a claim that reference screenshots implement robotics functionality. All references were retrieved in this research session; no production application has been rendered or usability-tested.

The product is a compact robotics workspace inside VS Code. Its visual identity is precise, quiet, and evidence-oriented. The memorable interaction is cross-selection: selecting a component reveals its wiring, code, documents, and applicable measurements through the same stable ID. The visual system MUST support that relationship rather than decorate it.

## Approved screen ledger

| Ref | Source | Owns this pattern | Explicit limit |
|---|---|---|---|
| R01 | [Orchids](https://refero.design/pages/9cae5de0-255b-4687-afcf-7a6b0912ad3f) | Compact navigation beside dominant editor | Reuse VS Code shell; do not recreate its file explorer |
| R02 | [Cursor](https://refero.design/pages/acc9b60c-b2b4-4126-ad0f-82361e37a027) | Agent activity, persistent composer, review affordance | Reference is web agent UI, not desktop extension implementation |
| R03 | [Factory](https://refero.design/pages/beb6c1d6-a0fe-4d8c-9761-e1b321183102) | Grouped context sources and inspector | Does not reveal provider-private reasoning or every internal prompt |
| R04 | [Attio](https://refero.design/pages/361d1d78-a133-43a7-b1ca-52a9ee163e15) | Dense records, filtering, selected row | Adapt to parts and pins; omit CRM navigation |
| R05 | [n8n](https://refero.design/pages/bc1e065f-1c09-4748-9ffb-fc04bffbd6d9) | Zoomable nodes, connections, contextual inspector | Workflow edges are not electrical nets; domain model remains D35 |
| R06 | [GitHub](https://refero.design/pages/4b64c360-ee73-4c4e-91e2-1c7a9b923f8b) | Changed-file list and comparison | Use native diff; omit pull-request/social chrome |
| R07 | [Steel](https://refero.design/pages/3fd6fb3a-5de2-48d6-986e-79d85cdc3e3f) | Timestamped event records and expandable payloads | Browser session control is not robot control |
| R08 | [W&B detail](https://refero.design/pages/1141e627-682d-4219-a1bd-9efc6e15fcee) | Charts with configuration provenance | Replace training metrics with declared physical units |
| R09 | [W&B comparison](https://refero.design/pages/1653cc08-edba-44ac-bddf-54f183015194) | Run selection, consistent series, comparisons | Do not compare incompatible time bases silently |
| R10 | [Spline](https://refero.design/pages/42c103b0-f7ac-4e89-b0cc-d77d174aa739) | Viewport, hierarchy, selected properties | No promise of Spline modeling features or CAD dimension accuracy |
| R11 | [Factory docs](https://refero.design/pages/cbccf094-418c-45ec-850a-4d46d960676f) | Source reading beside assistant | Citations must resolve to actual document versions/pages |
| R12 | [Cursor connections](https://refero.design/pages/a6a8face-1797-4a2c-8fdc-a966595e9304) | Integration rows with status/actions | A logged-in subscription is not automatically API entitlement |

## Full style references and interpretation

**RESEARCH-RECORDED:** Refero full styles retrieved for Factory `f1ed1d46-4e76-41fe-a9f8-3017e55dc6ee`, Cursor `c5c78f9c-11f1-406d-9a0d-67959b509e31`, and Attio `9f0c028b-6b11-415e-ab92-f32e4597cbe2` describe their marketing/product websites. Their source sites are [Factory](https://factory.ai), [Cursor](https://cursor.com), and [Attio](https://attio.com). They provide taste and role guidance, not authoritative app CSS. Retrieved descriptions contain occasional inconsistent values; do not mechanically import them.

Factory contributes fine borders, low decoration, small corner radii, and clear code-versus-prose typography. Cursor contributes compact activity cards and short action groups. Attio contributes table alignment, rare color emphasis, and lightweight surfaces. The website's large headlines, serif hero typography, generous section gaps, orange branding, and marketing shadows are outside the chosen role and MUST NOT enter the IDE by default.

## Reference lock

Primary direction: host-native VS Code with the Factory/Cursor compact workbench pattern. Preserve dominant working content, small readable labels, thin separation, expandable detail, and persistent task context. Secondary sources have the bounded roles in the ledger. Host theme colors and host font settings take precedence over reference palettes. Dark, light, and high-contrast modes are equal requirements.

Media is functional: actual schematic previews, CAD renders, document pages, plots, and source diffs. Do not replace real artifacts with generated illustrations. Icons are functional and monochrome except semantic states. A schematic preview must display its source revision and validation status; a beautiful render is never evidence of electrical correctness.

## Drift and acceptance

Implementation changes to reference roles require an entry in D08 explaining why. A missing licensed font is resolved by host typography, not downloading a proprietary font. A reference unavailable later remains identified by UUID and the extracted role recorded here; do not block implementation on its availability.

- **AC-D41-01:** Every custom screen references at least one ledger item or a named native-host pattern.
- **AC-D41-02:** A screenshot review demonstrates the same hierarchy in light and dark themes without hardcoded brand backgrounds.
- **AC-D41-03:** The wiring canvas labels its domain as intended connections, not a verified schematic.
- **AC-D41-04:** No unrequested branded assets, landing-page sections, billing UI, or full CAD modeling shell appear.

## Related sources

[SOURCE-VERIFIED VS Code UX](https://code.visualstudio.com/api/ux-guidelines/overview), accessed 2026-11-01. Read [tokens](design-tokens-and-theming.md), [screens](screen-specifications.md), and [navigation](information-architecture-and-navigation.md) next. The acceptance checks above are release obligations, not completed tests.
