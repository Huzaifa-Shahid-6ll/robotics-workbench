import { createHash, randomUUID } from 'node:crypto';
import type { ExperimentAssociations, ExperimentProcedure, HashedParserProfile, TelemetryDerivation } from '@robotics-workbench/contracts';

export const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const procedure: ExperimentProcedure = { schemaVersion: 1, procedureId: randomUUID(), version: 1, purpose: 'Synthetic numeric stability test; no physical accuracy claim.', setup: ['Fake transport; no connected device.'], controlledInputs: ['Fixed synthetic sequence.'], instruments: ['Deterministic software fixture.'], steps: ['Acquire the fixture sequence.'], expectedOutputs: ['Known numeric samples.'], tolerances: ['Mean exactly two fixture units.'], stopConditions: ['Stop after all samples.'], decisionRules: ['Local evaluator inspects exact retained evidence.'] };
export const unknownAssociations = (): ExperimentAssociations => Object.fromEntries(['sourceSnapshotId', 'buildId', 'uploadOperationId', 'deviceId', 'deviceObservationId', 'firmwareSha256'].map(key => [key, { id: null, reason: 'Synthetic fixture has no physical association.' }])) as ExperimentAssociations;
export function syntheticDerivation(rawArtifactSha256: string, options: { unit?: string | null; values?: number[]; device?: boolean; gaps?: boolean } = {}): TelemetryDerivation {
  const profile: HashedParserProfile = { schemaVersion: 1, id: randomUUID(), parserVersion: 'telemetry-v1', mode: 'labeled-numeric', channels: [{ channelId: 'range', source: 'range', label: 'Synthetic range', unit: options.unit === undefined ? 'mm' : options.unit }], configurationSha256: hash('synthetic-parser') };
  const connectionSessionId = randomUUID();
  if (options.device) profile.deviceClock = { source: 't', unit: 'ms', wrapAt: null };
  return { schemaVersion: 1, recordingId: randomUUID(), derivationId: randomUUID(), derivationSha256: hash(randomUUID()), rawSha256: hash('range:1\nrange:2\nrange:3\n'), segmentSha256s: [rawArtifactSha256], parserVersion: 'telemetry-v1', configurationSha256: profile.configurationSha256, profile,
    samples: (options.values ?? [1, 2, 3]).map((value, sequence) => ({ channelId: 'range', value, unit: profile.channels[0].unit, hostReceiveMs: sequence * 10, deviceTimeMs: options.device ? sequence * 10 : null, deviceEpoch: 0, raw: [{ connectionSessionId, sequence, byteStart: 0, byteEnd: 8 }], parserVersion: 'telemetry-v1', configurationSha256: profile.configurationSha256 })),
    gaps: options.gaps ? [{ cause: 'disconnect', startHostReceiveMs: 10, endHostReceiveMs: null, lostBytes: null, connectionSessionId }] : [], issues: [] };
}
