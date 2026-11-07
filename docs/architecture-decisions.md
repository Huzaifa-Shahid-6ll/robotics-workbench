---
doc_id: D08
title: "Architecture decisions"
status: implementation-spec
updated: 2026-11-01
depends_on: [D03, D04]
requirement_ids: [REQ-ARCH-01, REQ-ARCH-03, REQ-ARCH-04, REQ-PROD-05]
---

# Architecture decisions

## Purpose and authority

**SPECIFIED:** This ledger owns architectural choices. Detailed contracts in D11–D40 implement these decisions; they cannot silently replace them. “Selected” means selected for this project, not proven fastest by a benchmark. Any reversal records evidence, affected documents, migration consequences, and a replacement decision.

## Decision ledger

| ID | Decision and rationale | Rejected default | Revisit only when |
|---|---|---|---|
| ADR-001 | VS Code extension, preserving native editing/search/diffs/terminal | Arduino IDE/Theia/Code OSS fork or new Electron shell | A required workflow cannot be implemented through stable host APIs |
| ADR-002 | TypeScript extension and small local Node companion; React only for custom webviews | Cloud backend or distributed services | Measured process/ABI constraints require a different local runtime |
| ADR-003 | Ordinary files plus versioned workbench.json own source/design intent | Database owns all editable engineering files | A concrete interoperability problem has a reviewed migration plan |
| ADR-004 | SQLite owns operational records; artifact bytes stored separately by digest | Graph database, full event sourcing, initial vector service | Proven query/scale constraints exceed the simple model |
| ADR-005 | Existing Codex/OpenCode reasoning loops behind capability-based adapters | Custom agent harness or assumptions of provider parity | Required capabilities unavailable through supported integrations |
| ADR-006 | One device coordinator; refuse competing owner when sharing is unavailable | Each panel/provider opens serial independently | Never for same-device concurrent mutation; topology may evolve with tests |
| ADR-007 | Arduino CLI and installed cores/libraries remain the build/upload foundation | Mandatory PlatformIO conversion or custom compiler | User explicitly selects another build system for a particular project |
| ADR-008 | Manifest owns intended wiring; native KiCad edits can own a separate schematic | Silent bidirectional synchronization | A proven lossless subset and conflict strategy are specified |
| ADR-009 | Reuse CadQuery and existing viewer workflow | New CAD modeler/tessellator | Public integration seams fail and a bounded replacement is justified |
| ADR-010 | Host theme, native controls, compact panels | Marketing-site styling imposed on IDE chrome | Host affordances demonstrably cannot represent required state |
| ADR-011 | Exact retrieval and bounded evidence before semantic indexing | Mandatory embeddings/RAG infrastructure | Measured document retrieval failures justify adding a replaceable index |
| ADR-012 | One foreground task owner by default, bounded review delegation | General multi-agent scheduler in the product | Repeated independent workloads demonstrate a need and safe ownership rules exist |

## Authority and identity rules

A manifest revision is not a source snapshot, compiler target, or physical device identity. Keep these separate even if the first prototype has one board and one file. UUID project/object IDs identify durable objects; content digests identify exact immutable artifacts. Changing a COM path does not create a new physical identity by itself, and matching a USB descriptor does not prove a unique board where descriptors are ambiguous.

The host editor and filesystem can temporarily disagree because of unsaved buffers or external CLI edits. Build and review flows MUST reconcile that boundary. SQLite cannot make arbitrary files, an uploader process, and physical hardware one atomic transaction. Operations record intent and external result, then reconcile incomplete effects after a crash.

## Lifecycle decisions

Operation states are exactly queued, running, awaiting-input, succeeded, failed, cancelled, and outcome-unknown. A queued acknowledgement is not successful completion. Stopping an agent does not necessarily stop an already-started hardware operation. Interrupted upload is never retried solely because the prior request ID is known.

The companion coordinates workbench clients, but cannot guarantee exclusivity against unrelated tools or unrestricted shell commands. Use supported workspace/provider permission mechanisms and report this boundary honestly. Do not claim that an MCP facade is a complete security sandbox.

## Reuse sequencing

Early compatibility work may exercise existing Codex/OpenCode UI plus the shared domain tools. The complete release still includes the unified panel and shared context/review surfaces requested by the user. OCP CAD Viewer reuse is preferred over building a custom viewport, subject to a documented supported seam. A wiring table can precede the canvas; this sequencing must not remove the canvas from the final scoped experience.

## Change proposal example

```yaml
adr: ADR-002
status: proposed-amendment
trigger: native serial binding fails in packaged runtime
alternatives:
  - pin a tested companion runtime and native build
  - select a verified compatible serial adapter
required_evidence:
  - clean-machine VSIX reproduction
  - runtime and ABI matrix
  - device ownership regression tests
migration: preserve operation and artifact schemas
```

The example is a proposal format, not a statement that such a failure occurred.

## Acceptance criteria

- **AC-D08-01:** Modules respect the documented host/domain/provider/tool boundaries and do not import vscode into reusable domain logic.
- **AC-D08-02:** Data-authority tests recover from a manifest write preceding a database update without replacing the file with stale DB state.
- **AC-D08-03:** Any architecture reversal has an ADR amendment and updates dependent contracts before implementation merges.
- **AC-D08-04:** A source rollback test does not relabel physical wiring or device firmware as rolled back.

## Sources and related documents

**RESEARCH-RECORDED:** [VS Code capabilities](https://code.visualstudio.com/api/extension-capabilities/overview), [SQLite atomic commit](https://sqlite.org/atomiccommit.html), [Arduino integration](https://docs.arduino.cc/arduino-cli/integration-options/), [OCP CAD Viewer](https://github.com/bernhard-42/vscode-ocp-cad-viewer). These support seams and constraints; ADR choices remain project judgments.

Related: [system architecture](system-architecture.md), [storage](storage-and-migrations.md), [validation gates](unknowns-and-validation-spikes.md).
