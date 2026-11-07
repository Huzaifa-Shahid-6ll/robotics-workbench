---
doc_id: D21
title: "Agent runtime and task lifecycle"
status: implementation-spec
updated: 2026-11-01
depends_on: [D11, D18, D19]
requirement_ids: [REQ-AGENT-21]
---

# Agent runtime and task lifecycle

## Authority and status

**SPECIFIED:** this document owns the application-level lifecycle around existing Codex and OpenCode runtimes. It does not implement another autonomous reasoning loop. Provider protocol details belong to D23/D24; operation scheduling belongs to D19. REQ-AGENT-21: every visible task state MUST be derived from persisted application facts or attributable provider observations.

A workbench task may contain several provider turns and robotics operations. A completed provider turn does not imply a successful compile, completed upload, or correct robot behavior. The task view MUST present those outcomes separately. All behaviors below are implementation requirements, not results of tests already run.

## Task admission

The host MUST resolve the active project, explicit user request, current selection, current projectRevision, and sourceSnapshotId before admitting a task. Empty or ambiguous hardware targets MUST remain unset; COM-port strings cannot fill in missing device identity. Create taskId and turnId before contacting the provider. Persist the request and context packet ID before transmission, with credentials excluded.

Only one mutating provider turn per project is admitted by default. Independent read-only investigation may run concurrently, but its results remain revision-scoped. A second request while a turn is active offers queue, supported steering, or interrupt. It MUST NOT silently create another writer. Steering is enabled only when the adapter advertises it and records which active turn received the amendment.

## State and transitions

Tasks use the canonical operation status vocabulary. The UI may add a phase label without inventing another terminal status.

| Current status | Trigger | Result and required action |
|---|---|---|
| queued | Dependencies ready | running; persist turn admission |
| running | Provider permission or essential user answer | awaiting-input; store correlated request |
| awaiting-input | Valid answer and current preconditions | running; deliver once |
| running | Provider completes and all requested acceptance checks pass | succeeded with scoped evidence; missing required physical checks keep task incomplete |
| running | Known unrecoverable error | failed with diagnostic and recovery route |
| running | Interrupt confirmed, no uncertain effects | cancelled; keep applied edits visible |
| running | Lost process during uncertain external effect | outcome-unknown; reconcile before another mutation |
| outcome-unknown | Authoritative reconciliation | Preserve original receipt; append a linked reconciliation receipt with observed result |

An interrupt request is not confirmation of cancellation. The application MUST distinguish stopping text generation from stopping a currently running subprocess. Upload interruption follows D32, including unknown board state. Closing a panel never means permission to kill an upload or discard the task receipt.

## Application-owned task record

```ts
interface AgentTask {
  schemaVersion: 1;
  taskId: string;
  projectId: string;
  projectRevision: number;
  sourceSnapshotId: string | null;
  providerId: "codex" | "opencode";
  providerSessionId: string | null; // opaque
  status: "queued" | "running" | "awaiting-input" | "succeeded" |
          "failed" | "cancelled" | "outcome-unknown";
  contextPacketId: string;
  operationIds: string[];
  changeSetIds: string[];
  unresolvedQuestions: string[];
}
```

This is an internal proposed TypeScript contract, not a vendor request shape. Persist enough activity to reconstruct the UI without persisting private provider internals. Tool observations, textual answers, proposed changes and actual edits MUST have distinct event kinds. Already-applied CLI edits use Keep/Revert; unapplied proposals use Apply/Dismiss. Revert requires conflict checks against subsequent user edits.

## Completion and recovery

A final response MUST summarize changes, verification performed, remaining limitations, and linked artifacts. Missing test evidence produces a qualified result rather than a fabricated pass. If the task requested only an explanation, no compile is required. If it requested an upload, provider prose is insufficient: the coordinator receipt supplies the upload outcome.

On restart, query the provider session before retransmission. If the request may have been accepted but cannot be reconciled, keep outcome-unknown and allow an explicit new task. Never replay an upload because an SSE stream or JSON-RPC connection disconnected. An identical failed tool request repeated three times without changed inputs or evidence pauses that task for replanning; this initial threshold is a tunable project choice, not a research constant.

## Acceptance criteria

- AC-D21-01: Restart after transmission but before acknowledgement; no duplicate turn is submitted automatically.
- AC-D21-02: A provider says “done” after a failing compile; UI exposes failed compilation and cannot claim firmware validation.
- AC-D21-03: Interrupt during a file edit preserves the diff and unrelated dirty buffers.
- AC-D21-04: Two pending writers cannot modify the same project concurrently without an explicit conflict-resolution path.
- AC-D21-05: A stale permission answer cannot authorize a newly selected device or artifact.

## Sources and related documents

**RESEARCH-RECORDED:** [SWE-agent](https://arxiv.org/html/2405.15793v3) motivates informative tool feedback; [ReAct](https://arxiv.org/html/2210.03629v3) motivates acting on observations. Neither establishes hardware safety or the chosen state machine. See [provider contract](provider-adapter-contract.md), [jobs](jobs-and-process-supervision.md), and [change/recovery journeys](journeys-states-and-recovery.md).
