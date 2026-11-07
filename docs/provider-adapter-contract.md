---
doc_id: D22
title: "Provider adapter contract"
status: implementation-spec
updated: 2026-11-01
depends_on: [D18, D21]
requirement_ids: [REQ-AGENT-22]
---

# Provider adapter contract

## Authority and requirement

**SPECIFIED:** a small adapter translates vendor sessions into stable workbench interactions. REQ-AGENT-22: provider differences MUST be declared capabilities, never silently emulated or discarded. The interface below is application-owned. D23 and D24 own mappings to verified vendor interfaces. Adding an adapter does not authorize changing global provider configuration.

The adapter owns transport, protocol validation, provider lifecycle, and vendor-specific errors. The robotics service owns device access, builds, artifacts, and state. The webview cannot call vendor endpoints directly or receive provider secrets. Provider execution remains local to the selected runtime, with any model network calls performed by that runtime.

## Proposed interface

```ts
type Capability = "resume" | "interrupt" | "steer" | "images" |
  "mcp" | "usage" | "approvals" | "structured-output";
interface ProviderAdapter {
  inspect(): Promise<ProviderDescriptor>;
  open(input: OpenSession): Promise<SessionRef>;
  submit(input: SubmitTurn): Promise<TurnRef>;
  observe(session: SessionRef, cursor?: string): AsyncIterable<AgentEvent>;
  answerApproval(input: ApprovalAnswer): Promise<void>;
  interrupt(turn: TurnRef): Promise<void>;
  reconcile(session: SessionRef): Promise<SessionSnapshot>;
  close(options: { stopOwnedProcess: boolean }): Promise<void>;
}
```

`ProviderDescriptor` includes providerId, executableVersion, adapterVersion, protocolFingerprint, supported capabilities, and readiness problems. `SessionRef` includes projectId, taskId, providerSessionId and canonical workspace URI. `SubmitTurn` includes clientTurnId, session reference, user text, contextPacketId, immutable attachments and explicit model configuration. An absent capability is false; absent usage is unknown, not zero.

The complete definitions of every referenced input/output type are in [provider-adapter.ts](../contracts/provider-adapter.ts). That file is a normative application contract, not vendor implementation code. Runtime validators must enforce the documented bounds and host authorization; TypeScript types alone are insufficient. Optional steering remains disabled until an explicit versioned contract extension is implemented.

Protocol-specific types MUST remain inside the adapter package. Common UI code MUST NOT branch on vendor event names. Vendor payloads retained for debugging must be sanitized and access-limited; attach a digest or local diagnostic artifact rather than sending full raw events to the renderer.

## Event normalization

Normalized events use D18's envelope: schemaVersion, eventId, sequence, projectId, projectRevision, optional operationId, type, occurredAt, payload. Additional taskId, providerSessionId and clientTurnId belong in payload where relevant. Workbench sequence is assigned on ingestion; provider timestamps and cursors remain separate data.

| Event type | Required payload information |
|---|---|
| agent.session.opened | Session reference and capability snapshot |
| agent.turn.started | clientTurnId and provider turn identifier if available |
| agent.text.delta | Message ID, delta index, text |
| agent.tool.started | Tool call ID, safe display name, redacted inputs |
| agent.tool.finished | Tool call ID, outcome, artifact/result references |
| agent.approval.requested | Approval ID, action, target, scope, expiry |
| agent.turn.finished | Provider terminal outcome and attributable usage |
| agent.connection.changed | Connection state, reason, recovery route |

The adapter MUST separate a repeated delta from a new delta. When a protocol lacks reliable event replay, reconcile full authoritative state and replace the affected presentation snapshot; do not concatenate replayed text. Preserve events that cannot be normalized as diagnostic metadata, not invented user-facing completion events.

## Permission and workspace boundaries

Approval answers MUST bind to provider session, provider request ID, task, action, and current target preconditions. An answer to a resolved/expired request returns `APPROVAL_EXPIRED`. Default-deny missing correlation. Offer only the intersection of workbench scope and provider-supported scope. Never translate a one-time/task approval into a broader session/global allow rule; if the runtime cannot honor the narrower scope, use its one-time path or report unsupported scope. Provider runtime permissions and coordinator policies are independent checks. Neither an adapter nor MCP prohibits an unrestricted provider shell from bypassing the coordinator; report this limitation and configure the runtime permissions honestly.

Workspace canonicalization MUST handle Windows casing, symlinks, spaces, and a moved directory. A session created for another project cannot be resumed merely because its display name matches. A provider switch creates a new session and uses D28's handoff; private histories are not translated.

## Errors and compatibility gate

Normalize `PROVIDER_NOT_FOUND`, `PROVIDER_UNSUPPORTED`, `AUTH_REQUIRED`, `MODEL_UNAVAILABLE`, `RATE_LIMITED`, `TRANSPORT_LOST`, `PROTOCOL_ERROR`, and `APPROVAL_EXPIRED`. Include retryable and safe next action. Only read/reconcile requests may be automatically retried after ambiguous delivery. Disable dependent features when a capability probe fails; preserve editing and offline build access.

**VALIDATION-GATE:** each supported executable/SDK pair needs an observed version, protocol/schema fingerprint, startup transcript fixture, approval fixture, interrupt fixture and restart fixture. A version string alone does not establish compatibility. Unknown combinations show “not yet tested” and require the compatibility probe before use.

## Acceptance criteria

- AC-D22-01: Both adapters pass identical normalized-session contract tests without vendor types leaking into UI modules.
- AC-D22-02: Unsupported image input is reported before submission, never silently omitted.
- AC-D22-03: Duplicate events, expired approvals and abrupt transport loss produce deterministic state.
- AC-D22-04: Provider switching transfers only application-owned facts and references.
- AC-D22-05: Closing a borrowed server connection does not terminate another user's runtime.

## Sources

**SOURCE-VERIFIED 2026-11-01:** [Codex app-server](https://learn.chatgpt.com/docs/app-server), [OpenCode SDK](https://opencode.ai/docs/sdk/), [OpenCode server](https://opencode.ai/docs/server/). They establish distinct supported integration surfaces, not this common interface. Related: [Codex](codex-integration.md), [OpenCode](opencode-integration.md), [security](security-and-data-boundaries.md).
