# Codex adapter fixtures

TASK-05 / REQ-AGENT-22, REQ-AGENT-23; normative D22 v1.

The adapter uses the installed Codex CLI **0.160.1** app-server stdio schema.
The generated bundle fingerprint is
`8683f6fd9fbb994fa2bfb704ab5b02c9890238fa507a4c0ff33ff45884cd0a2e`.
The original read-only/start/interrupt/resume transcript is retained at
`artifacts/compatibility/lifecycle/codex.json`; original matching schemas at
`artifacts/compatibility/codex-schema/` (local generated artifacts).

Current documentation queried via Context7 `/openai/codex` and
`/openai/codex/rust-v0.163.0` on 2026-11-02. Its first result incorrectly covered
exec-server; implementation deliberately uses the locally generated **app-server**
schema, not that separate subsystem. Public source reference:
https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/app-server/README.md

Deterministic tests live in `packages/adapters/codex/test/codex.test.ts` and cover
startup order, duplicate terminal events, unsupported capabilities, workspace
binding, simultaneous writers, correlated one-time approval, secret redaction,
lost acknowledgements and initialization failure. Unknown delivery never retries.
Stdio has no replay IDs for text deltas: reconnect replaces presentation from
`thread/read` rather than concatenating historical delta messages.

`live-smoke.ts` explicitly invokes the installed provider in a separate scratch
workspace, using existing supported authentication. It performs the common
off-by-one diagnosis, interrupts a second text turn, then restarts/resumes without
submitting another turn. It writes sanitized evidence under
`artifacts/task05-codex-live/result.json`. It does not access a board, mutate
provider configuration, or extract credentials. The live run also requests a
harmless scratch-file write under read-only policy, observes the actual upstream
approval and sends a one-time denial to that exact request. The earlier
premature-interrupt failure is retained separately. No broad permission is granted.
Attachment capability remains unavailable pending model validation.
