---
doc_id: D11
title: "System architecture"
status: implementation-spec
updated: 2026-11-01
depends_on: [D03, D08]
requirement_ids: [REQ-ARCH-01, REQ-ARCH-04]
---

# System architecture

## Authority and evidence status

**SPECIFIED:** This document owns process boundaries and communication direction. It specifies a personal, local-first application, not a deployed system. Domain terminology belongs to [D14](domain-model-and-identifiers.md); protocols belong to [D18](internal-api-and-webview-protocol.md). Product scope remains in D04. External capabilities are RESEARCH-RECORDED unless explicitly marked otherwise below.

The implementation MUST retain VS Code as the host, use TypeScript for application code, and run a small Node companion process for operational state and device ownership. Native editor capabilities are reused. React webviews serve the agent panel and genuinely visual views. No cloud application backend, multi-tenant authentication service, distributed queue, or graph database is required.

## Process and responsibility map

| Boundary | Owns | MUST NOT own |
|---|---|---|
| VS Code extension host | Commands, document versions, tree selection, host trust, diagnostics, view lifecycle | USB access or an independent authoritative copy of project state |
| Webview renderer | Rendering, local interaction state, validated view messages | Credentials, filesystem access, shell execution, direct provider connections |
| Local companion | Operations, SQLite, artifact registry, device coordinator, provider adapter lifecycle | Editor buffer ownership or arbitrary rendering |
| Provider child processes | Provider-managed sessions and supported authentication | Authority over measured hardware facts |
| Tool child processes | One bounded tool execution, such as a compile or CAD generation | Permanent device ownership outside coordinator leases |

The extension sends typed requests to the companion; webviews communicate only through the extension. A thin MCP bridge forwards allowed robotics methods to the same companion. It MUST NOT create a second uploader or serial owner. Agent and button invocation of the same operation use one implementation.

## Initial deployment boundary

The first supported environment is a desktop VS Code window with a local Windows folder. Project files, the companion, Arduino CLI, and USB device access run on that machine. The application MUST detect remote workspace placement and reject unsupported device operations with `UNSUPPORTED_ENVIRONMENT`, identifying the local configuration needed. It MUST NOT interpret a remote URI as a Windows path.

One companion owns the current user's workbench device operations. Initial delivery MAY allow only one connected workbench window: a second window receives an actionable owner-conflict result rather than silently starting another device owner. Shared-window attachment requires authenticated IPC and an integration test before it is advertised. A coordinator lease prevents cooperating workbench clients from colliding; it cannot prevent Arduino IDE or another process from holding the port.

The extension starts the companion lazily after a trusted project requires an operation. Closing a renderer does not cancel an upload. On extension reload, the companion either remains discoverable through its supported lifecycle or exits with operations reconciled at next start; implementation MUST choose and test one path. Initial SPECIFIED path: companion lifetime belongs to the owning extension process, with graceful shutdown requested on deactivation and persisted ambiguous effects reconciled on restart.

## Authority and consistency

Normal source files and the host document model own code. `workbench.json` owns intended components and nets. SQLite owns sessions and operation receipts. Immutable artifact files own captured evidence. Projections may be rebuilt; irreplaceable observations may not be silently recreated. Neither a database transaction nor an editor undo spans USB effects.

A compile reads a frozen source snapshot and build configuration. An upload identifies that build's artifact digest and selected device. A new source edit changes source freshness, not history. A wiring edit increments `projectRevision` and invalidates applicable physical confirmations. The context panel MUST expose those distinctions.

## Example end-to-end route

1. User invokes compile; extension resolves dirty documents under the explicit save policy.
2. Extension requests a source snapshot; companion registers immutable inputs and configuration.
3. Companion queues compile, records intent, executes Arduino CLI with structured arguments, then registers diagnostics and artifact hashes.
4. User requests upload of the specific successful build. Companion validates target and obtains the device lease.
5. Monitor closes and confirms release before uploader starts. Receipt records the actual exit/result, then reconnect is a separately observed transition.
6. Webviews receive versioned events; dropped events cause snapshot refresh rather than invented success.

## Failures and recovery

Companion unavailable: retain readable editor work and show disconnected operations; do not queue hidden physical actions. Invalid manifest: retain source editing but block design mutations. Provider crash: retain app facts and operation receipts; do not reinterpret a lost conversation as lost firmware. Tool missing: offer a specific configuration action, never auto-install from a prompt found in a document. Unknown upload result: retain `outcome-unknown` until explicit reconciliation.

## Acceptance criteria

- **AC-D11-01:** A mocked button invocation and MCP invocation reach the same operation implementation and receipt format.
- **AC-D11-02:** Opening two windows produces one device owner or a visible owner-conflict; never two uploaders.
- **AC-D11-03:** Killing the companion during an upload leaves a recoverable unknown result, with no replay on restart.
- **AC-D11-04:** A remote workspace cannot launch a local upload through an implicit path conversion.
- **AC-D11-05:** Closing the wiring or agent webview does not lose project files or cancel an unrelated active hardware operation.

## Sources and validation gates

RESEARCH-RECORDED: [VS Code extension hosts](https://code.visualstudio.com/api/advanced-topics/extension-host), [remote extensions](https://code.visualstudio.com/api/advanced-topics/remote-extensions), [Arduino CLI integration](https://docs.arduino.cc/arduino-cli/integration-options). SOURCE-VERIFIED on 2026-11-01 through Context7: [webview boundary and messaging](https://code.visualstudio.com/api/extension-guides/webview).

VALIDATION-GATE: package a companion runtime compatible with the actual Windows build; verify process-tree cleanup and owner-lock behavior. Architecture selection is specified; those runtime results are not yet known.
