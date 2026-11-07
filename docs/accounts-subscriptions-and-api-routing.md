---
doc_id: D25
title: "Accounts, subscriptions and API routing"
status: implementation-spec
updated: 2026-11-01
depends_on: [D20, D22]
requirement_ids: [REQ-AGENT-25]
---

# Accounts, subscriptions and API routing

## Authority and product rule

**SPECIFIED:** the workbench reuses supported installed-agent authentication and configuration. It is not a subscription broker or a service that converts one product's login into arbitrary API access. REQ-AGENT-25: the selected account, runtime and billing route MUST be visible before a task is submitted, and the application MUST NOT silently fall back to a potentially chargeable route.

This document owns account routing and credential handling. It does not define provider entitlement or guarantee access to a model. The user's actual installed accounts, plan terms, limits and permitted integration paths are VALIDATION-GATE items. The first implementation supports Codex and OpenCode; additional direct API clients are later adapters, not a reason to recreate those agent runtimes.

## Connection model

```ts
interface AccountRoute {
  routeId: string;
  providerId: "codex" | "opencode";
  runtimeLocation: "windows" | "wsl";
  authOwner: "provider-runtime";
  authMethod: "subscription" | "api-key" | "other-supported" | "unknown";
  accountLabel: string | null; // non-secret display value
  modelId: string | null;
  readiness: "unknown" | "ready" | "login-required" |
             "unsupported" | "rate-limited" | "unavailable";
  checkedAt: string | null;
}
```

A route ID is an application reference, never a credential. No route object contains tokens, passwords, private auth-file contents, or full account responses. A configured route can be unavailable without disabling Arduino builds, local files, diagrams, or historical experiments.

## Discovery and login workflow

Read supported provider readiness signals; do not reverse-engineer private credential caches. If a login is needed, invoke the runtime's documented login flow through the appropriate adapter or direct the user to the exact supported local command. Authentication links are transient and must not enter persistent logs. The user chooses the account in the provider-controlled flow. Workbench stores only safe readiness metadata.

OpenCode server authentication protects the local service connection and is distinct from the model account configured inside OpenCode. Codex login status is distinct from having an API key. Treat unknown billing mode as unknown and require explicit route selection before an alternative route is used. Never claim an account is free merely because no API key was entered.

Global configuration is read-only by default. When setup requires a workspace-scoped integration entry, show its exact diff and preserve unrelated entries. Secrets entered into an authorized settings flow MUST travel to the owning credential mechanism without echoing through model context or terminal history. Environment variables passed to a child process MUST be the minimal required set, not a dump of the host environment.

## Task routing and failover

A task records routeId, providerId, safe model label, runtime version, and applicable permission profile. It remains bound to that route until the user explicitly changes it. Model selection uses discovered availability; a typed but unavailable model yields `MODEL_UNAVAILABLE` before execution.

On expired credentials, pause with `AUTH_REQUIRED`; on a rate limit, report any provider-supplied retry information without inventing a reset time. Automatic retry is allowed only where request delivery is known not to have started work. A new route creates a new provider session with the D28 handoff. It does not transfer private authentication or assume the old session's unfinished tool was cancelled.

Usage is displayed only when attributable data exists. Unknown token usage, remaining quota, or cost MUST stay unknown. Estimated cost needs an explicit estimated label and a versioned pricing source; do not calculate dollar amounts from subscription usage unless the provider actually defines that relationship. Budget guards are local preferences and cannot guarantee prevention of all charges outside the workbench.

## Export, diagnostics and deletion

Export task evidence and safe route labels, excluding credential references that could grant access. Diagnostics scrub Authorization headers, query secrets, auth URLs and provider responses with credential-bearing fields. A disconnect action removes the workbench connection, not the provider's global account, unless the user specifically requests a supported logout. Clearing memory does not imply revoking credentials; the UI names these separate effects.

## Acceptance criteria

- AC-D25-01: Expired subscription authentication never triggers an API-key fallback automatically.
- AC-D25-02: Exported projects, logs and context packets contain no planted test secrets.
- AC-D25-03: OpenCode local-server credentials cannot be confused with model-provider credentials.
- AC-D25-04: Unavailable AI leaves offline editing and build workflows usable.
- AC-D25-05: Switching route retains attributable evidence and creates a fresh provider session when required.
- AC-D25-06: Missing usage data renders “unavailable,” not zero tokens or zero cost.

## Sources and validation limits

**SOURCE-VERIFIED 2026-11-01:** [Codex authentication](https://learn.chatgpt.com/docs/auth), [OpenCode server authentication](https://opencode.ai/docs/server/). These establish available mechanisms, not this user's eligibility. Validate actual account readiness locally without disclosing credentials. Related: [Codex](codex-integration.md), [OpenCode](opencode-integration.md), [security](security-and-data-boundaries.md), [session continuity](memory-and-session-continuity.md).
