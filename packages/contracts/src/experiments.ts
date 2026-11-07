const isRequestId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

export type ExperimentLifecycle = 'draft' | 'ready' | 'running' | 'completed' | 'aborted' | 'interrupted';
export type ExperimentOutcome = 'pass' | 'fail' | 'inconclusive' | 'not-evaluated';
export type EvidenceArtifact = { artifactId: string; sha256: string; sizeBytes: number };
export type ExperimentProcedure = {
  schemaVersion: 1; procedureId: string; version: number; purpose: string; setup: string[];
  controlledInputs: string[]; instruments: string[]; steps: string[]; expectedOutputs: string[];
  tolerances: string[]; stopConditions: string[]; decisionRules: string[];
};
export type ExperimentAssociation = { id: string | null; reason: string | null };
export type ExperimentAssociations = {
  sourceSnapshotId: ExperimentAssociation; buildId: ExperimentAssociation; uploadOperationId: ExperimentAssociation;
  deviceId: ExperimentAssociation; deviceObservationId: ExperimentAssociation; firmwareSha256: ExperimentAssociation;
};
export type ExperimentParameter = { value: number | string | boolean; unit: string | null };
export type ExperimentRun = {
  schemaVersion: 1; kind: 'experiment-run'; experimentId: string; revisionId: string; previousRevisionId: string | null;
  revision: number; projectId: string; projectRevision: number; lifecycle: ExperimentLifecycle;
  procedure: ExperimentProcedure; procedureArtifact: EvidenceArtifact;
  parameters: Record<string, ExperimentParameter>; setup: string; associations: ExperimentAssociations;
  createdAt: string; changedAt: string; startedAt: string | null; finishedAt: string | null;
  frozenConfigurationSha256: string | null; selections: import('./telemetry').RecordingSelection[];
  metricArtifacts: EvidenceArtifact[];
  comparable: boolean; changes: { at: string; reason: string; configuration: string }[];
  notes: { author: string; at: string; reason: string; text: string }[];
  judgment: { outcome: ExperimentOutcome; evaluator: string | null; criterion: string | null; evidenceRevisionIds: string[]; at: string | null };
  revisionReason: string;
};
export type RetainedTelemetryDerivation = {
  schemaVersion: 1; kind: 'telemetry-derivation'; recordId: string; projectId: string; derivationId: string; derivationSha256: string;
  recordingId: string; parserVersion: string; configurationSha256: string; parsedArtifact: EvidenceArtifact;
  rawArtifacts: EvidenceArtifact[];
  recordingMetadata: Record<string, unknown> | null;
};
export type ExperimentMetric = {
  formulaVersion: 'sample-statistics-v1'; channelId: string; unit: string | null;
  count: number; min: number | null; max: number | null; mean: number | null;
  missingData: 'exclude-absent-no-interpolation'; gaps: number; issues: number;
  formula: { mean: 'sum(value)/count'; interval: 'inclusive'; weighting: 'sample' };
  selection: import('./telemetry').RecordingSelection;
};
export type ExperimentComparison = { exploratoryOverlay: boolean; formalImprovementAllowed: boolean; incompatibilities: string[]; conclusion: 'not-evaluated' };

export function isExperimentProcedure(value: unknown): value is ExperimentProcedure {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as ExperimentProcedure;
  const names = ['setup', 'controlledInputs', 'instruments', 'steps', 'expectedOutputs', 'tolerances', 'stopConditions', 'decisionRules'] as const;
  return Object.keys(p).length === 12 && p.schemaVersion === 1 && isRequestId(p.procedureId) && Number.isSafeInteger(p.version) && p.version > 0
    && typeof p.purpose === 'string' && p.purpose.length > 0 && p.purpose.length <= 4096
    && names.every(key => Array.isArray(p[key]) && p[key].length > 0 && p[key].length <= 100 && p[key].every(text => typeof text === 'string' && text.length > 0 && text.length <= 4096));
}
