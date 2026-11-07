import type { ComponentDefinition, FactSource, NumericFact } from '@robotics-workbench/contracts';

export const syntheticSource: FactSource = { sourceId: 'synthetic:electrical', uri: 'urn:synthetic:electrical', sha256: '1'.repeat(64), documentVersion: 'fixture-1', location: 'Software fixture; not a physical measurement.', extractionMethod: 'manual', reviewStatus: 'reviewed', reviewedBy: 'Deterministic software fixture' };
export function syntheticFact(value: number | null, overrides: Partial<NumericFact> = {}): NumericFact {
  return { value, unit: 'V', classification: 'recommended', conditions: 'Synthetic test conditions only.', applicability: 'Deterministic software test; no real-board claim.', sourceId: syntheticSource.sourceId, reviewStatus: 'reviewed', unknownReason: value === null ? 'Deliberately unknown test quantity.' : null, ...overrides };
}
export function syntheticDefinition(): ComponentDefinition {
  return { schemaVersion: 1, definitionId: 'synthetic:input-module', definitionVersion: '1', manufacturer: 'Synthetic fixture', model: 'Input module fixture', revision: 'Fixture1', package: 'Synthetic module', classification: 'module', sources: [structuredClone(syntheticSource)],
    pins: [{ pinId: 'signal', label: 'Signal', aliases: ['SIG'], electricalType: 'input', modes: ['input'], required: true, sourceIds: [syntheticSource.sourceId], voltageRange: { minimum: syntheticFact(0), maximum: syntheticFact(5), minimumInclusive: true, maximumInclusive: true }, driveVoltage: null, busKind: null },
      { pinId: 'gnd', label: 'Ground', aliases: ['GND'], electricalType: 'ground', modes: ['ground'], required: true, sourceIds: [syntheticSource.sourceId], voltageRange: null, driveVoltage: null, busKind: null }],
    connectors: [{ connectorId: 'header', label: 'Synthetic resources', pinIds: ['signal', 'gnd'] }], facts: {} };
}
