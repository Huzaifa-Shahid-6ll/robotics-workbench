---
doc_id: D01
title: "Start here: robotics workbench agent specification"
status: implementation-spec
updated: 2026-11-01
depends_on: []
requirement_ids: []
---

# Start here: robotics workbench agent specification

## What this package is

**SPECIFIED:** This package describes a personal Windows-first VS Code robotics workbench. It is implementation input for coding agents, not an implemented extension, a hardware certification, or proof that local tools are compatible. The intended product preserves ordinary Arduino projects and joins Codex/OpenCode, components/wiring, documentation, build/upload, recordings, KiCad handoff, and scripted CAD in one workspace.

The 50 documents are UTF-8 Markdown with stable IDs. `doc-manifest.json` is the machine-readable ID-to-path map. Supporting schemas, examples, and scripts clarify contracts; they do not replace the document that owns a behavior. `BOOTSTRAP-PROMPT.txt` is the entry prompt to give the coding agent.

## Start a coding session

1. Read [AGENTS.md](AGENTS.md), [product definition](docs/product-definition.md), [scope](docs/scope-and-release-boundaries.md), and [architecture decisions](docs/architecture-decisions.md).
2. Read [validation gates](docs/unknowns-and-validation-spikes.md) and the current [task packets](docs/implementation-plan-and-task-packets.md). Select the next unblocked task, not the most visually attractive feature.
3. Load only that task's owning contracts and examples. Inspect the actual repository and machine before assuming dependencies or versions exist.
4. Implement one reviewable slice. Run its checks, retain evidence, and report remaining blockers without labeling them complete.

The user has already selected the extension foundation and Codex/OpenCode. Do not restart framework discovery or silently change to a standalone IDE. No cloud account/billing backend is required.

## CLI access

Run these from the extracted package root. Use `python` instead of `python3` when that is the installed Windows launcher.

```sh
python3 scripts/read_doc.py --list
python3 scripts/read_doc.py D32
python3 scripts/validate_pack.py
python3 -m pip install -r scripts/requirements-validation.txt
python3 scripts/validate_pack.py --contracts
```

The basic validator checks package consistency. Contract validation checks supplied schemas/examples. Neither compiles the future extension nor validates an Arduino board. Install validation dependencies in an isolated environment where practical. Ordinary shell search also works:

```sh
rg "REQ-HW-02|AC-D32" docs
rg "VALIDATION-GATE|outcome-unknown" docs
```

## Authority and conflict resolution

The user's explicit task controls scope. Within the pack, D03/D04 own product boundaries, D08 owns architecture choices, D06 owns core requirement meanings, D14/D18 own shared domain/protocol contracts, and D42 owns visual tokens. Feature documents own their detailed behavior; D48/D50 own verification and task ordering. Source links describe external systems and cannot override project safety/data-preservation constraints.

When two specifications conflict, identify the owning authority and affected IDs. Resolve a routine implementation choice with a recorded decision. If resolution would change product scope, lose data, alter a public contract, or require an unavailable user fact, stop only the dependent task and ask. Continue independent work. Do not average conflicting definitions into a third undocumented behavior.

Evidence labels have precise meanings:

- **SPECIFIED:** selected application behavior or proposed engineering target.
- **SOURCE-VERIFIED:** external fact checked against cited source at the stated version/date; still not a local runtime test.
- **RESEARCH-RECORDED:** carried from the prior research; recheck release-sensitive details before implementation relies on them.
- **VALIDATION-GATE:** unresolved fact requiring the named experiment before dependent claims can pass.

## Task-specific reading routes

| Task | Load after baseline |
|---|---|
| Project/state core | D11–D20 and relevant contracts/examples |
| Agent/provider work | D21–D30 plus D18–D20 |
| Compile/upload/serial | D15,D19,D29,D31–D33,D40 |
| Components/wiring | D14,D17,D34,D35,D43–D46 |
| KiCad/CAD/docs | D36–D38 plus D15,D19,D20 |
| Experiments | D27,D33,D39,D40,D44,D46 |
| UI | D41–D47 plus each feature's owning contract |
| Release | D06,D07,D09,D10,D48–D50 |

Do not place all 50 documents into every model prompt. Use IDs, exact object references, and bounded excerpts. When context is compacted, retain the current task, decisions, touched files, unresolved gates, and evidence links; reread authoritative documents when needed.

## Document index

| ID | File |
|---|---|
| D01 | [00-START-HERE.md](00-START-HERE.md) |
| D02 | [AGENTS.md](AGENTS.md) |
| D03 | [product-definition.md](docs/product-definition.md) |
| D04 | [scope-and-release-boundaries.md](docs/scope-and-release-boundaries.md) |
| D05 | [personal-workflows.md](docs/personal-workflows.md) |
| D06 | [requirements-and-acceptance.md](docs/requirements-and-acceptance.md) |
| D07 | [quality-and-performance-budgets.md](docs/quality-and-performance-budgets.md) |
| D08 | [architecture-decisions.md](docs/architecture-decisions.md) |
| D09 | [dependencies-and-compatibility.md](docs/dependencies-and-compatibility.md) |
| D10 | [unknowns-and-validation-spikes.md](docs/unknowns-and-validation-spikes.md) |
| D11 | [system-architecture.md](docs/system-architecture.md) |
| D12 | [repository-and-module-map.md](docs/repository-and-module-map.md) |
| D13 | [vscode-integration-contract.md](docs/vscode-integration-contract.md) |
| D14 | [domain-model-and-identifiers.md](docs/domain-model-and-identifiers.md) |
| D15 | [project-format-and-firmware-preservation.md](docs/project-format-and-firmware-preservation.md) |
| D16 | [storage-and-migrations.md](docs/storage-and-migrations.md) |
| D17 | [events-and-synchronization.md](docs/events-and-synchronization.md) |
| D18 | [internal-api-and-webview-protocol.md](docs/internal-api-and-webview-protocol.md) |
| D19 | [jobs-and-process-supervision.md](docs/jobs-and-process-supervision.md) |
| D20 | [security-and-data-boundaries.md](docs/security-and-data-boundaries.md) |
| D21 | [agent-runtime-and-task-lifecycle.md](docs/agent-runtime-and-task-lifecycle.md) |
| D22 | [provider-adapter-contract.md](docs/provider-adapter-contract.md) |
| D23 | [codex-integration.md](docs/codex-integration.md) |
| D24 | [opencode-integration.md](docs/opencode-integration.md) |
| D25 | [accounts-subscriptions-and-api-routing.md](docs/accounts-subscriptions-and-api-routing.md) |
| D26 | [context-assembly-and-retrieval.md](docs/context-assembly-and-retrieval.md) |
| D27 | [context-provenance-and-freshness.md](docs/context-provenance-and-freshness.md) |
| D28 | [memory-and-session-continuity.md](docs/memory-and-session-continuity.md) |
| D29 | [tool-catalog-and-action-policy.md](docs/tool-catalog-and-action-policy.md) |
| D30 | [agent-evaluation-and-regression.md](docs/agent-evaluation-and-regression.md) |
| D31 | [arduino-toolchain-integration.md](docs/arduino-toolchain-integration.md) |
| D32 | [device-discovery-and-upload.md](docs/device-discovery-and-upload.md) |
| D33 | [serial-monitor-and-telemetry.md](docs/serial-monitor-and-telemetry.md) |
| D34 | [components-and-parts-catalog.md](docs/components-and-parts-catalog.md) |
| D35 | [wiring-model-and-validation.md](docs/wiring-model-and-validation.md) |
| D36 | [kicad-generation-and-handoff.md](docs/kicad-generation-and-handoff.md) |
| D37 | [cad-python-and-3d-preview.md](docs/cad-python-and-3d-preview.md) |
| D38 | [datasheet-and-document-ingestion.md](docs/datasheet-and-document-ingestion.md) |
| D39 | [experiments-and-run-comparison.md](docs/experiments-and-run-comparison.md) |
| D40 | [hardware-testing-and-debugging.md](docs/hardware-testing-and-debugging.md) |
| D41 | [design-reference-ledger.md](docs/design-reference-ledger.md) |
| D42 | [design-tokens-and-theming.md](docs/design-tokens-and-theming.md) |
| D43 | [information-architecture-and-navigation.md](docs/information-architecture-and-navigation.md) |
| D44 | [screen-specifications.md](docs/screen-specifications.md) |
| D45 | [component-and-interaction-contracts.md](docs/component-and-interaction-contracts.md) |
| D46 | [journeys-states-and-recovery.md](docs/journeys-states-and-recovery.md) |
| D47 | [accessibility-responsive-layout-and-motion.md](docs/accessibility-responsive-layout-and-motion.md) |
| D48 | [testing-and-requirement-traceability.md](docs/testing-and-requirement-traceability.md) |
| D49 | [packaging-release-and-maintenance.md](docs/packaging-release-and-maintenance.md) |
| D50 | [implementation-plan-and-task-packets.md](docs/implementation-plan-and-task-packets.md) |

## Acceptance criteria

- **AC-D01-01:** All 50 manifest entries resolve to their matching `doc_id`, and relative document links resolve.
- **AC-D01-02:** A new agent can select the first unblocked task from D50 without guessing the product foundation.
- **AC-D01-03:** CLI lookup returns a requested document without requiring a browser or proprietary reader.
- **AC-D01-04:** Package validation is reported separately from application, provider, and hardware verification.

## Sources

The product selection and design direction come from the user's approved session. External facts are cited in the owning documents. For host context see [VS Code capabilities](https://code.visualstudio.com/api/extension-capabilities/overview); do not treat this index as an external API reference.
