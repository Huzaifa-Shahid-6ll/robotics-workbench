# OpenCode adapter (TASK-05)

Implements application provider contract v1 (D22) against the observed Windows
OpenCode executable and standard `@opencode-ai/sdk` 1.18.32 pair. The server's
OpenAPI SHA-256 must equal
`46db986090aae41846cd6dbe16225a1d883f0bbcb4c48814008d3f6ce140aa5c`.
Unknown executable/schema combinations are refused before session submission.

`OpenCodeAdapter.launch` owns an authenticated loopback-only `serve --pure`
process. A constructor connection borrows an explicitly configured local server;
closing it never terminates that server. Configuration additions use only the
owned process environment. A read-only configuration probe rejects MCP name
collisions before the scoped addition is launched. No configuration file or
provider credential cache is rewritten/read by this module.

The default `read-only` session profile denies all tools except ordinary reads
and the catalog's explicit domain read names. `workspace-write` requires upstream
approval for effects. Unknown profiles are rejected and effective permission
rules are confirmed against the returned session. A resumed session must retain
the requested rules. Extra permission profiles are a trusted composition/test
seam. Approval answers bind request, session, turn, revision and target facts;
only `once` maps upstream, never `always`.

Prompt acknowledgements are not completion. Stable user message IDs correlate
authoritative assistant terminal records. Ambiguous delivery is retained as
unknown; reconnecting observation never repeats a prompt. Assistant text uses
full text-part comparisons to suppress duplicates, with per-message delta
indices. Events from another session or user messages are excluded. Borrowed
server version/schema changes block new work. Event, text, message, approval and
turn ledgers have explicit limits; oversize presentation fails visibly instead
of silently truncating evidence. Images/other attachments are not advertised.

SDK 1.18.32's generated SSE code calls global `fetch` rather than the configured
transport. The adapter therefore reads the documented `/event` stream with its
authenticated, redirect-denying fetch and bounded SSE decoder. All other vendor
API calls use the installed standard SDK. The pinned installed OpenAPI defines
`permission.asked`, session permission rules and the standard permission-response
alias; old generated SDK event types are not treated as current wire schemas.

Primary documentation read through Context7 on 2026-11-02:

- [Versioned SDK](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/web/src/content/docs/sdk.mdx)
- [Versioned server API](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/web/src/content/docs/server.mdx)
- [MCP configuration](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/web/src/content/docs/mcp-servers.mdx)
- [Tool permissions](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/web/src/content/docs/tools.mdx)

Those near-release docs are supplemented by the exact installed SDK source and
retained `artifacts/compatibility/opencode-openapi.json`; live adapter tests
confirmed the exact pair rather than assuming documentation equals compatibility.

Executed tests cover the shared normalized provider suite, duplicate submission
and events, unrelated sessions/user text, approval allow/deny/expiry/correlation,
unknown prompt delivery, authoritative cancellation, version drift, no automatic
model fallback, borrowed shutdown and loopback enforcement. Live checks used the
existing explicit `openai/gpt-6.1-sol` route in isolated scratch workspaces: the
same revision-stamped off-by-one debugging task as Codex, actual approval and
denial of a harmless echo command, session resume and observed cancellation.
Evidence is retained under `verification/evidence/task-05/opencode`.

No hardware, WSL, attachment support, unrestricted-shell sandbox claim, external
plugin compatibility or arbitrary model/server combination is verified here.
