---
doc_id: D12
title: "Repository and module map"
status: implementation-spec
updated: 2026-11-01
depends_on: [D11, D18]
requirement_ids: [REQ-ARCH-01]
---

# Repository and module map

TASK-10 adds optional `packages/adapters/kicad` and `packages/adapters/cad` behind
companion composition. Their feature contracts expose small pure browser validators;
the engineering renderer imports only those subpaths and host-neutral types. KiCad
and CAD services reuse the existing process supervisor, heavy-job queue, file scope
and SQLite/artifact store. CAD canonical source snapshots retain exact ordinary
source bytes; native scripts and templates remain independently usable. Optional
tool environments are external to the VSIX; only the application Python convention
runner and engineering webview assets are packaged. The native controller owns
dialogs, dirty-buffer checks and explicit handoffs to existing editors/viewers.

## Authority and intent

**SPECIFIED:** This document owns the proposed implementation repository structure, dependency direction, and code ownership boundaries. It does not claim these packages are implemented in this documentation archive. The archive's `docs/` and `contracts/` are planning assets. Implementers MUST create the runtime scaffold only through a task packet from D50.

Use a TypeScript workspace with one package manager and committed lockfile. Exact package-manager/runtime versions are VALIDATION-GATE decisions recorded in D09 after a Windows installation spike. Do not mix npm, pnpm, and Bun lockfiles. Reuse a tested dependency per role instead of implementing parallel abstractions before they are needed.

## Proposed implementation tree

```text
apps/
  extension/            # VS Code activation, commands, document/UI adapters
  companion/            # Local composition root, IPC, startup, shutdown
packages/
  contracts/            # Runtime schemas and matching exported types
  domain/               # Pure rules: identifiers, revisions, nets, validation
  application/          # Use cases and ports; no vendor imports
  persistence/          # SQLite repositories, migrations, artifact registry
  devices/              # Device coordinator and lease state machine
  agents/               # Provider-neutral interface and normalization
  adapters/
    arduino/            # CLI discovery, compile/upload argument construction
    codex/              # Supported protocol adapter, opaque provider IDs
    opencode/           # Supported server/SDK adapter
    serial/             # Port transport and raw capture
    kicad/              # Version-gated CLI and generated-export handoff
    cad/                # Python worker and viewer integration seams
    documents/          # Extraction/indexing provenance
  webviews/             # Shared UI primitives and view entry points
  test-fixtures/        # Fake executables, traces, temporary example projects
docs/                   # These normative specifications
scripts/                # Build, package, compatibility and test entry points
```

Do not create all packages as separate published artifacts. They are private workspace modules. A directory can begin as one module where the package split would add overhead; preserve the import boundary and documented owner. Avoid an unbounded `utils` package. Put a helper beside its domain and promote it only when two independent consumers need the same stable behavior.

## Dependency rules

`contracts` imports no runtime application or vendor package except its schema validator. `domain` imports contracts only where serialization types are needed; pure domain rules should use domain types. `application` depends on domain and port interfaces. Adapters implement those ports. Composition roots wire implementations. The extension may import application client types, never persistence internals. Webviews import public contract DTOs, never `vscode`, Node filesystem modules, native bindings, provider secrets, or SQLite.

The companion is the only composition root allowed to combine operation persistence with hardware adapters. A hardware adapter MUST NOT create its own queue or authoritative operation database. Provider adapter normalization MUST preserve provider-specific opaque payload references without leaking vendor types into the domain API.

## Ownership table

| Change | Primary location | Required related specification |
|---|---|---|
| Add operation status | `contracts`, application transition rules | D18 and D19; migration impact reviewed |
| Add board discovery field | Arduino/device adapters and DTO schema | D14 and D32 |
| Add graph interaction | webviews and host document adapter | D35, D44, D45 |
| Add persistent record | persistence migration and repository | D16, domain owner |
| Add provider capability | agents interface and provider adapters | D22–D24 |
| Add command | extension contribution plus command handler | D13, D43 |

## Coding and testing conventions

Use strict TypeScript. Unknown external payloads remain `unknown` until runtime validation succeeds. Use explicit units in numeric fields (`durationMs`, `sizeBytes`) and UTC ISO timestamps at serialized boundaries. Avoid paths embedded in display labels as identities. Define domain error codes once; UI localizes presentation separately.

Every module exposes a narrow public entry point. Cross-package relative imports into private source directories are forbidden. Test pure rules without VS Code; test host adapters inside the extension test host; fake adapters exercise failures without attached hardware. Hardware test scripts are distinctly named and require an explicit device selection so ordinary CI cannot accidentally flash a connected board.

Generated code goes under a marked generated directory with its source schema and generation command recorded. An agent MUST NOT hand-edit generated types to resolve a mismatch. Schema changes update both examples and compatibility tests. Documentation examples that are illustrative must be labeled as such and must not masquerade as external SDK calls.

## Errors and maintenance

An import cycle fails CI. A missing native dependency prevents the affected adapter from loading but not basic source editing. Optional CAD/document toolchains load on demand and report capabilities. A package upgrade requires the relevant contract and trace replay tests, not just successful installation. Keep incompatible vendor revisions behind an adapter; do not spread conditional vendor logic through view components.

## Acceptance criteria

- **AC-D12-01:** A dependency-boundary test rejects webview imports of Node, persistence, or provider implementations.
- **AC-D12-02:** Unit tests for domain rules execute without launching VS Code, Arduino CLI, or a provider.
- **AC-D12-03:** The packaged extension contains the intended companion and schemas but no credentials, recordings, or developer caches.
- **AC-D12-04:** A fresh checkout installs from one lockfile and runs documented build/check commands on the validated Windows environment.
- **AC-D12-05:** Disabling the CAD adapter does not prevent project open, source editing, or compile.

## Sources and related documents

RESEARCH-RECORDED: [VS Code extension anatomy](https://code.visualstudio.com/api/get-started/extension-anatomy), [extension capabilities](https://code.visualstudio.com/api/extension-capabilities/overview). Folder names and dependency policy are project design choices, not requirements imposed by VS Code.

Read [D11](system-architecture.md), [D18](internal-api-and-webview-protocol.md), D48, and D49 before implementing a scaffold or modifying boundaries.

## TASK-09 pure renderer contract seam — 2026-11-03

The renderer may import runtime validators only from the explicitly pure
@robotics-workbench/contracts/telemetry subpath. That module has no Node, host or
adapter dependency. General contracts/runtime and all persistence/process APIs
remain excluded from webviews. Boundary tests enforce the narrow exception so
shared parser/selection validators do not drift between frame and host.
