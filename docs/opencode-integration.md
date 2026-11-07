---
doc_id: D24
title: "OpenCode integration"
status: implementation-spec
updated: 2026-11-01
depends_on: [D09, D20, D22, D25]
requirement_ids: [REQ-AGENT-24]
---

# OpenCode integration

## Decision and source status

**SPECIFIED:** use a documented OpenCode server/SDK pair behind the D22 adapter. REQ-AGENT-24: preserve the user's existing provider configuration and permission rules while adding a scoped robotics connection. Do not scrape the TUI or silently replace global configuration.

**SOURCE-VERIFIED 2026-11-01:** public documentation describes a headless HTTP server, an OpenAPI document, and a JavaScript/TypeScript SDK. It documents both creating a server/client pair and connecting a client to an existing server. Context7 also surfaced newer development-branch plugin APIs. Those plugin interfaces are not interchangeable with the public SDK. No local OpenCode integration test has been executed for this pack.

## Version and ownership policy

**VALIDATION-GATE:** select one installed executable and one compatible SDK release. Capture the executable version, package lock entry, server health response, OpenAPI document hash, and a representative event fixture. Public pages currently illustrate `@opencode-ai/sdk`; this is a research anchor, not an unbounded dependency version. Do not combine standard-client parameter forms, `/v2` forms, or development-branch plugin types in one implementation.

A server connection has `ownership: owned | borrowed`. Owned means the workbench launched and supervises it. Borrowed means the user supplied a known local endpoint and the workbench cannot terminate or rewrite it. Launching a new headless process does not automatically attach to an existing TUI. Ask for no credentials in the chat transcript; local server authentication and model-provider authentication are separate settings.

## Startup sequence

1. Resolve executable and compatibility entry, canonical project directory, and existing configuration sources.
2. For owned mode, bind loopback only, select an available port and establish supported local-server authentication. Do not expose a wildcard network binding or permissive browser CORS as a convenience.
3. For borrowed mode, verify identity, readiness, authenticated access and intended project context before using it.
4. Query effective provider/model availability. Record inherited configuration versus workbench overrides without displaying secret values.
5. Subscribe to relevant events and create/resume the application-bound session.
6. Submit one D26 context packet and user message through the tested client interface.

Browser webviews communicate through the extension/service, not directly with the model server. Keep server credentials in the process supervisor or protected credential facility; never embed them in webview scripts or workspace JSON.

## Adapter mapping and configuration

```text
D22 inspect       -> tested health/version and capability probe
D22 open          -> documented session creation or session lookup
D22 submit        -> documented session prompt operation
D22 observe       -> documented event subscription
D22 interrupt     -> documented session abort operation
D22 reconcile     -> documented session/message state query
D22 answerApproval-> documented permission response operation
```

This mapping intentionally names responsibilities rather than pretending one vendor signature works across releases. The compatibility test MUST compile against the selected SDK and validate actual server payloads. Preserve opaque session/message IDs and associate events with project identity before showing them. Events from unrelated sessions on a shared server MUST not appear in the active task.

Configuration changes MUST be minimal and reviewable. Prefer process/runtime or workspace-scoped additions for the robotics MCP server. Detect collisions with a pre-existing entry of the same name; do not overwrite it automatically. Respect provider allow/ask/deny rules and distinguish them from coordinator authorization. Do not place an API key into an instruction file or manifest to make integration easier.

## Recovery and boundary cases

Handle returned API errors and thrown transport exceptions separately, normalizing both through D22. An event stream reconnect only resumes observation. It MUST NOT send the task prompt again. Where replay cursors are unavailable, query current session/message state and reconcile presentation by stable IDs.

An SDK retry facility MUST be configured or wrapped so ambiguous mutation delivery does not duplicate work. Abort acknowledgement alone does not prove a child tool stopped; track the tool/coordinator receipt. If the borrowed server changes version during use, invalidate compatibility and pause new turns. Existing artifact records remain available.

Windows paths containing spaces, a slow startup, an occupied port, expired provider login, project switching, and abrupt server termination are required fixture cases. A WSL deployment follows the same explicit path/USB separation as D23; it is not assumed to work from documentation alone.

## Acceptance criteria

- AC-D24-01: Existing provider configuration remains byte-for-byte unchanged unless a reviewed scoped change was requested.
- AC-D24-02: A borrowed server survives workbench shutdown.
- AC-D24-03: Reconnecting the event stream causes no duplicate prompt or tool effect.
- AC-D24-04: An unrelated session event is filtered out; wrong-project mutation is rejected.
- AC-D24-05: Unsupported SDK/server pairs fail before task submission.
- AC-D24-06: Permission approval, denial, timeout, interrupt and transport failure each yield deterministic task state.

## Sources

[OpenCode SDK](https://opencode.ai/docs/sdk/), [server](https://opencode.ai/docs/server/) were opened during this writing pass. [Configuration](https://opencode.ai/docs/config/), [MCP](https://opencode.ai/docs/mcp-servers/) and [permissions](https://opencode.ai/docs/permissions/) are RESEARCH-RECORDED from the preceding research pass and must be checked against the selected release. See [accounts](accounts-subscriptions-and-api-routing.md) and [provider contract](provider-adapter-contract.md).
