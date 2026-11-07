# TASK-05 — Agent adapters and domain tools

Started 2026-11-02. Status: done (TASK-05 / G3 adapter scope). Integration owner: root.
Depends on completed TASK-02 and TASK-04. Gate G3; validation VG-02/03/08.

Owners: task05_codex owns Codex adapter and fixtures; task05_opencode owns
OpenCode adapter and fixtures; task05_core owns shared runtime/context/handoff.
Root owns companion composition, MCP/domain-tool bridge, contract exports,
workspace/build/package integration, task status and retained evidence.

Owning documents: D21–D30; D14/D18/D19/D20 govern shared contracts;
D48/D50 govern verification and ordering. Requirements: REQ-PROD-02,
REQ-AGENT-21, REQ-AGENT-22, REQ-AGENT-23, REQ-AGENT-24, REQ-AGENT-25,
REQ-AGENT-26, REQ-AGENT-27, REQ-AGENT-28, REQ-AGENT-29, REQ-AGENT-30.
Canonical provider contract v1 and context-packet schema v1 remain authoritative.

Expected files: packages/agents, packages/adapters/codex and opencode,
packages/application/src/context and tools, apps/companion, contracts exports,
agent fixtures/tests, scripts, workspace/package configuration, verification.

Planned checks: normalized lifecycle and failure cases for both providers;
duplicate events, wrong project, expired approvals, unsupported capabilities;
bounded revision-scoped context and secret exclusion; handoff/checkpoint replay;
MCP mapping to existing coordinator, exact artifact policy, no mutation retries;
live isolated debugging task for each installed provider; dirty-buffer conflict;
full software, inspected package and installed host checks. No physical upload,
global provider configuration edits or credential extraction are authorized.

Implemented both version-pinned provider adapters, normalized task lifecycle,
revision/source-scoped context, immutable task/checkpoint journals, application
handoff, and the official-SDK stdio MCP bridge to the existing coordinator.
Bridge credentials are task-specific; a retired session cannot act for a newer
task. Reading an operation grants no cancellation rights. Source freshness
compares the complete saved input inventory. Host-only upload grants bind exact
target/artifact parameters. Credentials are excluded from tool results too.

Executed the final `npm run verify:task -- TASK-05`: contract validation,
TypeScript/boundary checks, complete software tests, inspected VSIX, and installed
trusted/restricted VS Code hosts passed. The installed host dirty-buffer test
preserved unsaved user and external-provider versions. Both native providers
completed the same off-by-one diagnosis; live interrupt, resume and one-time
permission responses passed. Both also called the real stdio MCP bridge and
received the correct isolated project snapshot through AgentService.

Independent adapter-owner integration review identified and root fixed stale
bridge reuse, cancellation ownership, added-input freshness, uncertain restart,
shutdown isolation, malformed auth bytes, and tool-result credential leakage.
Regressions cover those boundaries. Earlier live/packaging/test failures remain
under verification/history and verification/evidence/task-05.

Completion record: verification/task-05.json. No hardware operations were run.
Images/attachments, WSL and untested provider versions are refused; experiment
writes await TASK-09. Unrestricted external shells remain outside service
enforcement. The unified UI follows in TASK-06; G6 release remains unvalidated.
