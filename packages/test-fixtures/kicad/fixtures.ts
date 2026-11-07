import type { ComponentDefinition, WorkbenchManifest } from '@robotics-workbench/contracts';
import { referenceCatalog, validateDefinition } from '@robotics-workbench/domain';
import type { KicadMapping } from '@robotics-workbench/kicad';

/** Declared synthetic logical connector; no dimensions or physical measurements are asserted. */
export function kicadFixture() {
  const definition: ComponentDefinition = structuredClone(referenceCatalog[0]);
  Object.assign(definition, { definitionId: 'fixture.connector-2', definitionVersion: '1.0.0', manufacturer: 'Synthetic fixture', model: 'Logical connector', revision: 'fixture-1', package: 'logical-only', classification: 'connector', facts: {}, connectors: [] });
  definition.pins = ['A', 'B'].map(pinId => ({ pinId, label: pinId, aliases: [], electricalType: 'passive', modes: ['passive'], required: true, sourceIds: [definition.sources[0].sourceId], voltageRange: null, driveVoltage: null, busKind: null }));
  validateDefinition(definition);
  const componentIds = ['b1000000-0000-4000-a000-000000000001', 'b1000000-0000-4000-a000-000000000002'];
  const manifest: WorkbenchManifest = { schemaVersion: 1, projectId: 'a1000000-0000-4000-a000-000000000001', projectRevision: 1, name: 'Synthetic KiCad native fixture', sketches: [{ path: 'FixtureSketch', targetId: 'd1000000-0000-4000-a000-000000000001' }], targets: [{ targetId: 'd1000000-0000-4000-a000-000000000001', fqbn: 'arduino:avr:uno', options: {} }], components: componentIds.map((componentId, index) => ({ componentId, label: `Connector ${index + 1}`, identityStatus: 'resolved', definition: { definitionId: definition.definitionId, definitionVersion: definition.definitionVersion } })), nets: ['A', 'B'].map((pinId, index) => ({ netId: `c1000000-0000-4000-a000-00000000000${index + 1}`, label: `Fixture ${pinId}`, members: componentIds.map(componentId => ({ componentId, pinId })) })), codeBindings: [], documents: [], extensions: {} };
  const mapping: KicadMapping = { schemaVersion: 1, template: 'pin-block-v1', components: componentIds.map((componentId, index) => ({ componentId, definitionId: definition.definitionId, definitionVersion: definition.definitionVersion, reference: `J${index + 1}`, pins: [{ pinId: 'A', number: '1' }, { pinId: 'B', number: '2' }] })) };
  return { definition, manifest, mapping };
}
export const safeSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80"><g stroke="#000"><path d="M10 10 L90 70"/></g></svg>';
export const ercReport = (severity?: 'error' | 'warning' | 'exclusion') => JSON.stringify({ $schema: 'https://schemas.kicad.org/erc.v1.json', coordinate_units: 'mm', date: '2026-11-03T00:00:00+0000', kicad_version: '10.0.8', sheets: [{ path: '/', uuid_path: '/', violations: severity ? [{ type: 'pin_to_pin', severity, description: 'Synthetic ERC violation', items: [] }] : [] }] });
export const fixtureNetlist = '<?xml version="1.0" encoding="utf-8"?><export version="E"><nets><net code="1" name="Fixture A"><node ref="J1" pin="1"/><node ref="J2" pin="1"/></net><net code="2" name="Fixture B"><node ref="J1" pin="2"/><node ref="J2" pin="2"/></net></nets></export>';

