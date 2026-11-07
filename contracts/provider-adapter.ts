/**
 * SPECIFIED application contract v1, D22. No runtime implementation.
 * Vendor request/response types MUST NOT leak through this interface.
 * Validate UUIDs/URIs/timestamps and bounded lengths at runtime; TS is not validation.
 */
export type UUID = string;
export type ISODateTime = string;
export type ProviderId = "codex" | "opencode";
export type OperationStatus = "queued" | "running" | "awaiting-input" |
  "succeeded" | "failed" | "cancelled" | "outcome-unknown";
export type Capability = "resume" | "interrupt" | "steer" | "images" |
  "mcp" | "usage" | "approvals" | "structured-output";
export type ErrorCode = "PROVIDER_NOT_FOUND" | "PROVIDER_UNSUPPORTED" |
  "AUTH_REQUIRED" | "MODEL_UNAVAILABLE" | "RATE_LIMITED" |
  "TRANSPORT_LOST" | "PROTOCOL_ERROR" | "APPROVAL_EXPIRED" |
  "WORKSPACE_MISMATCH" | "REVISION_CONFLICT" | "CAPABILITY_UNSUPPORTED";
export interface AdapterProblem {
  code: ErrorCode;
  message: string; // max 2048 chars; safe for display
  retryable: boolean;
  nextAction: string; // max 1024 chars; no credentials
}
export interface ProviderDescriptor {
  providerId: ProviderId;
  executableVersion: string;
  adapterVersion: string;
  protocolFingerprint: string; // SHA256 of tested schema/compatibility material
  capabilities: Capability[]; // explicit set; absent means unsupported
  readiness: "ready" | "blocked" | "unknown";
  problems: AdapterProblem[]; // max 32
}
export interface SessionRef {
  providerId: ProviderId;
  projectId: UUID;
  taskId: UUID;
  providerSessionId: string; // opaque, max 512 chars
  workspaceUri: string; // canonical file URI validated by host
}
export interface ModelConfiguration {
  modelId: string; // max 256 chars; discovered availability required
  profileId: string | null; // workbench-owned tested configuration reference
}
export interface OpenSession {
  projectId: UUID;
  taskId: UUID;
  projectRevision: number;
  workspaceUri: string;
  routeId: UUID;
  model: ModelConfiguration;
  permissionProfileId: string;
  resume: SessionRef | null; // null starts a new provider session
}
export interface AttachmentRef {
  artifactId: UUID;
  sha256: string; // lowercase 64 hexadecimal characters
  mediaType: string; // max 128 chars
  displayName: string; // max 256 chars
  byteLength: number; // nonnegative integer
}
export interface SubmitTurn {
  clientTurnId: UUID; // deduplicated within the session, not a vendor guarantee
  session: SessionRef;
  projectRevision: number;
  sourceSnapshotId: UUID | null;
  userText: string; // max 32768 chars; independent of injected context budget
  contextPacketId: UUID;
  attachments: AttachmentRef[]; // max 16; adapter resolves approved local artifacts
  model: ModelConfiguration;
}
export interface TurnRef {
  clientTurnId: UUID;
  session: SessionRef;
  providerTurnId: string | null; // max 512 chars; null when vendor has no turn ID
}
export interface ApprovalRequest {
  approvalId: UUID;
  providerRequestId: string; // opaque, max 512 chars
  turn: TurnRef;
  action: string; // max 128 chars
  targetSummary: string; // max 2048 chars, sanitized
  expectedProjectRevision: number;
  deviceId: UUID | null;
  artifactSha256: string | null;
  permittedScopes: ("once" | "task")[]; // never implies global permission
  expiresAt: ISODateTime;
}
export interface ApprovalAnswer {
  approvalId: UUID;
  providerRequestId: string;
  turn: TurnRef;
  decision: "allow" | "deny";
  scope: "once" | "task";
  expectedProjectRevision: number;
  deviceId: UUID | null;
  artifactSha256: string | null;
}
export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  source: "provider-reported" | "unavailable";
  // No fabricated monetary cost from subscription activity.
}
export interface DisplayMessage {
  messageId: string;
  role: "user" | "assistant";
  text: string; // bounded 64 KiB; full content via artifactRef when larger
  artifactRef: UUID | null;
  complete: boolean;
}
export interface SessionSnapshot {
  session: SessionRef;
  descriptor: ProviderDescriptor;
  connection: "connected" | "disconnected" | "reconciling";
  activeTurn: TurnRef | null;
  latestTurnStatus: OperationStatus | null;
  pendingApprovals: ApprovalRequest[]; // max 32
  messages: DisplayMessage[]; // max 100; presentation snapshot, not private history
  nextCursor: string | null;
  observedAt: ISODateTime;
}
interface AgentEventBase {
  schemaVersion: 1;
  eventId: UUID;
  sequence: number; // coordinator-assigned integer >= 1
  projectId: UUID;
  projectRevision: number;
  operationId?: UUID;
  occurredAt: ISODateTime;
}
export type AgentEvent = AgentEventBase & (
  | { type: "agent.session.opened"; payload: {
      session: SessionRef; descriptor: ProviderDescriptor } }
  | { type: "agent.turn.started"; payload: { turn: TurnRef } }
  | { type: "agent.text.delta"; payload: {
      turn: TurnRef; messageId: string; deltaIndex: number; text: string } }
  | { type: "agent.tool.started"; payload: {
      turn: TurnRef; toolCallId: string; displayName: string;
      redactedInputSummary: string } }
  | { type: "agent.tool.finished"; payload: {
      turn: TurnRef; toolCallId: string; outcome: OperationStatus;
      artifactRefs: UUID[]; summary: string } }
  | { type: "agent.approval.requested"; payload: { approval: ApprovalRequest } }
  | { type: "agent.turn.finished"; payload: {
      turn: TurnRef; outcome: "succeeded" | "failed" | "cancelled" |
        "outcome-unknown"; usage: Usage; problem: AdapterProblem | null } }
  | { type: "agent.connection.changed"; payload: {
      session: SessionRef; connection: "connected" | "disconnected" |
        "reconciling"; problem: AdapterProblem | null } }
);
export interface ProviderAdapter {
  inspect(): Promise<ProviderDescriptor>;
  open(input: OpenSession): Promise<SessionRef>;
  submit(input: SubmitTurn): Promise<TurnRef>;
  observe(session: SessionRef, cursor?: string): AsyncIterable<AgentEvent>;
  answerApproval(input: ApprovalAnswer): Promise<void>;
  interrupt(turn: TurnRef): Promise<void>;
  reconcile(session: SessionRef): Promise<SessionSnapshot>;
  close(options: { stopOwnedProcess: boolean }): Promise<void>;
}
