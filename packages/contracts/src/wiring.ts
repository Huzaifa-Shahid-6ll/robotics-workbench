import type { WorkbenchManifest } from './project';

export type WiringOperation =
  | { type: 'component.add'; component: WorkbenchManifest['components'][number]; beforeComponentId?: string }
  | { type: 'component.replace'; component: WorkbenchManifest['components'][number] }
  | { type: 'component.rename'; componentId: string; label: string }
  | { type: 'component.resolve'; componentId: string; definition: WorkbenchManifest['components'][number]['definition']; pinMapping?: Record<string, string> }
  | { type: 'component.remove'; componentId: string; removeBindings: boolean }
  | { type: 'net.set'; net: WorkbenchManifest['nets'][number] }
  | { type: 'net.remove'; netId: string }
  | { type: 'binding.set'; binding: WorkbenchManifest['codeBindings'][number]; beforeBindingId?: string }
  | { type: 'binding.remove'; bindingId: string }
  | { type: 'document.set'; document: WorkbenchManifest['documents'][number] }
  | { type: 'pin.mode'; componentId: string; pinId: string; mode: string };
export interface WiringRuleResult {
  ruleId: string; ruleVersion: string; severity: 'error' | 'warning' | 'info';
  outcome: 'pass' | 'fail' | 'not-checked' | 'not-applicable'; affectedIds: string[];
  projectRevision: number; sourceFacts: string[]; explanation: string;
}
export interface WiringPlan {
  schemaVersion: 1; projectId: string; expectedProjectRevision: number;
  next: WorkbenchManifest; inverseOperations: WiringOperation[];
  changes: string[]; rules: WiringRuleResult[]; confirmationInvalidated: boolean;
}
export interface PreparedWiringPlan extends WiringPlan { previewId: string; previous: WorkbenchManifest; manifestSha256: string }
export interface WiringViewState {
  schemaVersion: 1; trusted: boolean; loading: boolean; error: string | null;
  project: { projectId: string; projectRevision: number; name: string; manifestSha256: string } | null;
  manifest: WorkbenchManifest | null;
  catalog: { definitionId: string; definitionVersion: string; label: string; detail: string }[];
  pins: Record<string, { pinId: string; label: string; aliases: string[]; modes: string[]; electricalType: string }[]>;
  rules: WiringRuleResult[];
  confirmations: { observationId: string; subjectIds: string[]; projectRevision: number; basis: 'reported' | 'measured'; result: 'passed' | 'failed' | 'inconclusive'; procedure: string; note: string; observedAt: string; applicability: 'current' | 'stale' }[];
  layout: { revision: number; sha256: string | null; positions: Record<string, { x: number; y: number }> };
  selection: { kind: 'component' | 'net'; id: string } | null;
  preview: { previewId: string; changes: string[]; rules: WiringRuleResult[]; confirmationInvalidated: boolean } | null;
}
export type WiringViewAction = 'ready' | 'refresh' | 'select' | 'propose' | 'commit' | 'discard' | 'layout' | 'undo' | 'openCode' | 'openDocument' | 'ask' | 'observe' | 'openManifest' | 'openCatalog';
export interface WiringViewRequest { schemaVersion: 1; requestId: string; projectId: string | null; type: WiringViewAction; payload: Record<string, unknown> }
export interface WiringViewResponse { schemaVersion: 1; type: 'state'; state: WiringViewState }
export type WiringSnapshotData = Pick<WiringViewState, 'catalog' | 'pins' | 'rules' | 'confirmations' | 'layout'> & { manifest: WorkbenchManifest; manifestSha256: string };
