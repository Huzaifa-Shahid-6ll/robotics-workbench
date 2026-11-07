---
doc_id: D23
title: "Codex integration"
status: implementation-spec
updated: 2026-11-01
depends_on: [D09, D20, D22, D25]
requirement_ids: [REQ-AGENT-23]
---

# Codex integration

## Decision and evidence boundary

**SPECIFIED:** integrate the installed Codex runtime through its documented app-server interface. Do not scrape terminal output, reproduce its agent loop, or extract its authentication token for a separate model client. REQ-AGENT-23: the adapter MUST preserve supported upstream lifecycle and permission semantics while adding robotics context through supported interfaces.

**SOURCE-VERIFIED 2026-11-01:** official app-server documentation and the repository dispatch implementation establish initialization before thread and turn operations. The official authentication page distinguishes supported sign-in paths. Context7 also returned an exec-server handshake example; that is a different subsystem and MUST NOT be substituted for app-server initialization. No Codex process was run during specification writing.

## Startup and compatibility procedure

1. Resolve the user-configured executable or discover it without modifying PATH. Record the absolute executable path, version output and launch environment with secrets redacted.
2. Run a read-only compatibility probe for the selected version. Obtain its app-server schema/types from matching official release documentation or supported schema-generation facility; retain the fingerprint.
3. Start the owned child process in the intended workspace, using an argument array and no shell interpolation. Keep protocol stdout separate from bounded stderr diagnostics.
4. Send app-server initialization using the exact selected schema, await its response and complete the documented initialization notification sequence.
5. Resolve supported account/readiness and model capabilities. Do not assume every authenticated account has access to every model.
6. Start or resume the correct workspace-scoped thread, then admit turns through D21.

The application MUST fail with `PROVIDER_UNSUPPORTED` if required fields or event shapes cannot be decoded. It MUST NOT “try likely parameter names” on a real project. Stdio is the initial workbench transport choice; alternate transports require an explicit compatibility entry rather than opportunistic fallback.

## Lifecycle mapping

| Workbench operation | Vendor surface to verify in pinned schema |
|---|---|
| Open session | `thread/start` |
| Resume existing session | `thread/resume` |
| Submit user task/context | `turn/start` |
| Interrupt current turn | `turn/interrupt` |
| Optional steering | `turn/steer`, only when supported |
| Receive activity | Thread/turn/item notifications from selected protocol |
| Resolve permission | Reply to the exact server-originated request |

The listed method family is an integration target, not a complete wire payload. Generate or import matching types in implementation. `providerSessionId` stores the upstream thread ID unchanged. A thread acknowledgement is not evidence that the user's request succeeded; only attributable terminal notifications complete a provider turn.

## Context and robotics integration

Supply the concise D26 context packet as ordinary supported text input, with immutable file or artifact references when permitted. Keep project instructions additive; do not replace the upstream base prompt to force a custom agent personality. Normal project files remain searchable through Codex's own tools.

Use the robotics MCP bridge as the initial domain-tool integration. It forwards operations to the shared coordinator. Any dynamic-tool facility must remain capability-gated until its exact release contract and approval behavior pass the local spike. Do not make an experimental field necessary for basic compile/upload workflows. Image attachments require both runtime and model capability; otherwise keep the image available to the user and explain the limitation.

## Authentication, Windows and recovery

Provider-managed login remains authoritative. Show readiness and safe account labels without copying auth files to the renderer, manifest, ZIP exports, or logs. An expired account produces `AUTH_REQUIRED` and preserves the task for resumption. Rate limits leave the queued task visible; do not silently switch to paid API access.

**VALIDATION-GATE:** test the actual Windows 10 machine, console/process behavior, sandbox support and paths containing spaces. If WSL is required, Windows remains the USB/serial owner. Explicitly map workspace/artifact paths across that boundary and refuse unmappable inputs. A native-to-WSL fallback cannot happen mid-turn without starting a separately identified runtime session.

On process loss, mark the connection disconnected and reconcile before resubmission. Persist pending approval IDs but never replay a previous yes to a different request. Hardware operations already handed to the coordinator retain their independent receipt; killing Codex cannot undo them.

## Acceptance criteria

- AC-D23-01: Fresh start, resume, streamed answer, approval response, interrupt and reconnect pass against the pinned executable on Windows.
- AC-D23-02: An initialization error prevents all thread/turn calls.
- AC-D23-03: Stderr warnings cannot corrupt protocol parsing or leak credentials.
- AC-D23-04: Lost acknowledgement cannot cause automatic duplicate task or upload submission.
- AC-D23-05: Both ordinary source files and a revision-stamped component query are accessible in one test task.
- AC-D23-06: Unsupported models/images/tool capabilities produce actionable errors without pretending success.

## Sources and ownership

[Official app-server documentation](https://learn.chatgpt.com/docs/app-server); [official dispatch implementation](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/message_processor.rs); [authentication](https://learn.chatgpt.com/docs/auth). Moving main-branch documentation MUST be replaced by the tested release reference during compatibility validation. See [provider contract](provider-adapter-contract.md), [accounts](accounts-subscriptions-and-api-routing.md), and [context assembly](context-assembly-and-retrieval.md).
