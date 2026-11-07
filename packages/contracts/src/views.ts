import type { ApprovalRequest, Capability, DisplayMessage, ProviderId } from '../../../contracts/provider-adapter';
import type { OperationStatus } from './project';

export interface ContextViewItem {
  id: string; title: string; sourceUri: string; revision: number; location: string;
  facets: ('available' | 'pinned' | 'supplied-this-turn' | 'observed-retrieved' | 'stale')[];
  summary: string; reason: string; sha256: string | null;
}
export interface ReviewViewItem {
  id: string; path: string; effect: 'proposed' | 'written' | 'conflicted' | 'kept' | 'reverted';
  baselineSha256: string | null; currentSha256: string | null; summary: string;
}
export interface WorkbenchViewState {
  schemaVersion: 1; project: { projectId: string; projectRevision: number; name: string } | null;
  loading: boolean; error: string | null; trusted: boolean;
  providers: { providerId: ProviderId; readiness: string; capabilities: Capability[]; detail: string }[];
  tasks: { taskId: string; providerId: ProviderId; status: OperationStatus; summary: string }[];
  task: { taskId: string; providerId: ProviderId; modelId: string; status: OperationStatus; providerOutcome: OperationStatus | null;
    contextPacketId: string; sourceSnapshotId: string | null; messages: DisplayMessage[]; pendingApprovals: ApprovalRequest[];
    activities: { id: string; title: string; summary: string }[]; problem: string | null } | null;
  context: ContextViewItem[]; changes: ReviewViewItem[];
  operations: { operationId: string; kind: string; status: OperationStatus }[];
}
export type ViewAction = 'ready' | 'refresh' | 'send' | 'selectTask' | 'stop' | 'reconcile' | 'approval' | 'handoff' | 'pin' | 'openEvidence' | 'review' | 'authorizeUpload';
export interface WorkbenchViewRequest {
  schemaVersion: 1; requestId: string; projectId: string | null; type: ViewAction; payload: Record<string, unknown>;
}
export interface WorkbenchViewResponse { schemaVersion: 1; type: 'state'; state: WorkbenchViewState }
