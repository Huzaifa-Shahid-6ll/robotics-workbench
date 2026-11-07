---
doc_id: D20
title: "Security and data boundaries"
status: implementation-spec
updated: 2026-11-01
depends_on: [D11, D18]
requirement_ids: [REQ-ARCH-05]
---

# Security and data boundaries

## Authority and threat boundary

**SPECIFIED:** This document owns application security/data-flow boundaries. It is a design specification, not a security certification. The local workbench handles untrusted repository content, datasheets, serial text, model output, generated SVG, and subprocess output. None of those inputs grants permission to execute commands or control hardware.

The application protects its own routes through validation, scope, host trust, and provider permissions. An agent with unrestricted shell/device access can bypass an MCP tool policy. The UI MUST disclose that boundary and use the provider's supported sandbox/permission controls where available. Do not claim that a local service makes cloud model inference private or offline.

## Trust and executable configuration

Reuse VS Code Workspace Trust. In untrusted workspaces, permit static inspection where safe and block project-controlled execution: agent startup, builds with hooks, upload, CAD scripts, and executable-path overrides. A compile can execute configured tools; it is not categorically read-only. Application/machine-level trusted tool paths cannot be silently replaced by repository settings.

Executable discovery records absolute path, version, environment, and source of configuration. Tool invocation uses structured arguments with explicit adapters for shell-wrapper edge cases. Never execute a command extracted from a datasheet, serial message, or model answer merely because it resembles an installation fix. The task's authorized scope and method policy determine allowed actions.

## Credentials and outbound data

Provider-managed login remains with Codex/OpenCode through supported interfaces. Do not scrape credential files or read another extension's private secrets. Application-owned API keys use VS Code SecretStorage or the selected approved OS credential boundary. Store opaque references in SQLite; never tokens in workbench.json, source snapshots, chat context, exports, or ordinary logs.

Each connection displays three separate facts: application execution location, agent-runtime location, and model endpoint/provider. A local agent server may call a hosted model. Context assembly records files/excerpts/images/windows sent by the application, their source and revision, and destination connection. It MUST NOT claim visibility into provider-internal retrieval or hidden reasoning.

Default exclusions include common credential material and explicitly private user paths. Exclusions reduce accidental context inclusion but are not a sandbox against unrestricted shell access. Provider retention/account policies remain provider-specific and must be sourced before making claims. Switching providers never silently switches accounts or endpoints to recover from quota/authentication errors.

## Renderer and transport controls

SOURCE-VERIFIED through Context7 on 2026-11-01: VS Code webviews support CSP, localResourceRoots, controlled resource URIs, and message passing. Use a deny-by-default CSP with bundled scripts/styles and no arbitrary remote scripts. Permit only required local resources. Keep the acquired host API object private. Sanitize/escape untrusted output, including Markdown and SVG paths; do not evaluate HTML from agent responses.

Validate every inbound message against D18 and a per-view method allowlist. Resolve projectId against the connection's authorized scope, not only the payload. A renderer cannot choose a different project's files by supplying another UUID. Unknown methods, oversized payloads, and malformed IDs fail before reaching execution.

Prefer local named-pipe/stdio boundaries for initial native operation. Named-pipe current-user access, discovery file integrity, session nonce, and ownership checks require platform tests. If a provider requires HTTP, bind to loopback, configure supported authentication, validate Origin where applicable, and avoid permissive CORS. Loopback is not authentication. Do not expose a control endpoint on all network interfaces for convenience.

## Filesystem scope

Use canonical resolved paths and explicit project/artifact roots. A string-prefix check is insufficient. Test path traversal, case-insensitive comparison, drive changes, UNC paths, junctions/symlinks, and alternate Windows path forms. A path outside authorized roots requires an explicitly scoped operation; it is never accepted because it was returned by a model.

Artifact handles resolve through the registry rather than accepting arbitrary filesystem paths from webviews. Downloads and document imports remain data until explicitly processed by an allowed tool. Generated files are staged and validated before replacing existing user files. Preserve independent KiCad edits and dirty source buffers rather than using elevated filesystem access to force a write.

## Logging, exports, and incident recovery

Log IDs, versions, timestamps, operation categories, and bounded diagnostics by default. Redact known secret values before persistence and test multiline/encoded representations, while acknowledging redaction is not perfect. Diagnostic bundles are inspectable and explicitly requested; they exclude raw source/serial recordings by default. Deleting a connection removes application-owned credentials and invalidates active use without erasing unrelated project history.

If suspicious content requests a privileged action, treat it as untrusted content and continue the user's authorized task where possible. If a credential is accidentally captured, stop propagation, identify affected local outputs, and provide a precise remediation path without displaying the secret again. Do not silently delete the user's entire project as recovery.

## Acceptance criteria

- **AC-D20-01:** A hostile repository executable-path setting does not launch in Restricted Mode.
- **AC-D20-02:** Script/HTML/SVG payloads in serial/model/document content execute no renderer code.
- **AC-D20-03:** Cross-project, traversal, junction, and alternate-path probes fail scope checks.
- **AC-D20-04:** Missing or invalid local transport authentication cannot invoke protected methods.
- **AC-D20-05:** Synthetic secrets are absent from context bundles, standard logs, and full-project exports.
- **AC-D20-06:** Changing model destination updates outbound-data disclosure before the next turn.

## Sources and gates

SOURCE-VERIFIED: [Webview security](https://code.visualstudio.com/api/extension-guides/webview). RESEARCH-RECORDED: [Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust), [common capabilities/SecretStorage](https://code.visualstudio.com/api/extension-capabilities/common-capabilities), [MCP transport security](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [OpenCode server](https://opencode.ai/docs/server/). Actual provider permissions, transport ACLs, credential handling, and Windows behavior remain VALIDATION-GATE tests before release.
