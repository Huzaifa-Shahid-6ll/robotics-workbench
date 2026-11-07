import { WorkbenchError, isRequestId, isComponentDefinition, isNumericFact, type ComponentDefinition, type LogicalPin, type NumericFact, type NumericRange, type WorkbenchManifest } from '@robotics-workbench/contracts';

function invalid(message: string): never { throw new WorkbenchError('INVALID_REQUEST', message); }
const units: Record<string, { dimension: string; factor: number }> = {
  V: { dimension: 'voltage', factor: 1 }, mV: { dimension: 'voltage', factor: 0.001 },
  A: { dimension: 'current', factor: 1 }, mA: { dimension: 'current', factor: 0.001 }, uA: { dimension: 'current', factor: 0.000001 },
  m: { dimension: 'length', factor: 1 }, cm: { dimension: 'length', factor: 0.01 }, mm: { dimension: 'length', factor: 0.001 },
  Hz: { dimension: 'frequency', factor: 1 }, kHz: { dimension: 'frequency', factor: 1000 }, MHz: { dimension: 'frequency', factor: 1000000 },
  ohm: { dimension: 'resistance', factor: 1 }, kohm: { dimension: 'resistance', factor: 1000 }
};
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; }
export const definitionKey = (definition: Pick<ComponentDefinition, 'definitionId' | 'definitionVersion'>): string => `${definition.definitionId}@${definition.definitionVersion}`;
export function canonicalPin(definition: ComponentDefinition, pinOrAlias: string): LogicalPin | undefined {
  const key = pinOrAlias.toLowerCase(); return definition.pins.find(pin => pin.pinId.toLowerCase() === key || pin.aliases.some(alias => alias.toLowerCase() === key));
}
export function findDefinition(catalog: readonly ComponentDefinition[], reference: WorkbenchManifest['components'][number]['definition']): ComponentDefinition | undefined {
  return reference ? catalog.find(item => item.definitionId === reference.definitionId && item.definitionVersion === reference.definitionVersion) : undefined;
}
export function convertFact(fact: NumericFact, targetUnit: string): NumericFact {
  if (!isNumericFact(fact)) invalid('Numeric fact has an invalid shape.');
  const source = Object.hasOwn(units, fact.unit) ? units[fact.unit] : undefined, target = Object.hasOwn(units, targetUnit) ? units[targetUnit] : undefined;
  if (!source || !target || source.dimension !== target.dimension) invalid('Unit conversion requires supported units of the same dimension.');
  const value = fact.value === null ? null : fact.value * source.factor / target.factor;
  if (value !== null && !Number.isFinite(value)) invalid('Converted quantity exceeds the supported finite range.');
  return { ...structuredClone(fact), value, unit: targetUnit, originalValue: fact.originalValue === undefined ? fact.value : fact.originalValue, originalUnit: fact.originalUnit ?? fact.unit };
}
export function validateDefinition(value: unknown): ComponentDefinition {
  if (!isComponentDefinition(value)) invalid('Component definition has an invalid, unsupported or oversized shape.');
  const result = structuredClone(value), sources = new Map(result.sources.map(source => [source.sourceId, source]));
  if (sources.size !== result.sources.length) invalid('Component source identities must be unique.');
  for (const source of result.sources) {
    let uri: URL; try { uri = new URL(source.uri); } catch { invalid('Source URI is invalid.'); }
    if (!['https:', 'http:', 'file:', 'urn:'].includes(uri.protocol) || uri.username || uri.password || source.reviewStatus === 'reviewed' && !source.reviewedBy?.trim()) invalid('Source URI or review provenance is invalid.');
  }
  const quantity = (fact: NumericFact): void => {
    const source = sources.get(fact.sourceId);
    if (!source || !fact.conditions.trim() || !fact.applicability.trim()) invalid('A quantity requires a source, conditions and applicability.');
    if (fact.value === null ? !fact.unknownReason?.trim() : fact.unknownReason !== null || !Number.isFinite(fact.value)) invalid('Unknown quantities require a reason; known values must be finite and explicitly classified.');
    if (fact.reviewStatus === 'reviewed' && source.reviewStatus !== 'reviewed') invalid('A reviewed fact cannot rely on an unreviewed source.');
    if (fact.classification === 'measured' && source.extractionMethod !== 'measured') invalid('A measured fact requires an attributed measurement source.');
    if ((fact.originalUnit === undefined) !== (fact.originalValue === undefined)) invalid('Converted facts retain both original value and unit.');
    if (fact.originalUnit !== undefined) {
      const original = { ...fact, value: fact.originalValue!, unit: fact.originalUnit };
      const converted = convertFact(original, fact.unit).value;
      if (converted === null ? fact.value !== null : fact.value === null || Math.abs(converted - fact.value) > Math.max(1, Math.abs(converted)) * 1e-12) invalid('Converted fact does not match its retained source value.');
    }
  };
  const range = (value: NumericRange): void => {
    quantity(value.minimum); quantity(value.maximum);
    if (units[value.minimum.unit]?.dimension !== 'voltage' || units[value.maximum.unit]?.dimension !== 'voltage') invalid('Pin voltage bounds require voltage units.');
    const minimum = convertFact(value.minimum, 'V').value, maximum = convertFact(value.maximum, 'V').value;
    if (minimum !== null && maximum !== null) {
      // Account only for floating-point conversion noise when units differ.
      const tolerance = value.minimum.unit === value.maximum.unit ? 0 : Math.max(1, Math.abs(minimum), Math.abs(maximum)) * Number.EPSILON * 8;
      if (minimum > maximum + tolerance || Math.abs(minimum - maximum) <= tolerance && (!value.minimumInclusive || !value.maximumInclusive)) invalid('Pin range bounds are reversed or empty.');
    }
  };
  const aliases = new Map<string, string>(), pinIds = new Set<string>();
  for (const pin of result.pins) {
    if (pinIds.has(pin.pinId.toLowerCase())) invalid('Logical pin identities must be unique.'); pinIds.add(pin.pinId.toLowerCase());
    for (const name of [pin.pinId, ...pin.aliases]) { const key = name.toLowerCase(); if (aliases.has(key) && aliases.get(key) !== pin.pinId) invalid('Pin aliases must resolve to exactly one logical resource.'); aliases.set(key, pin.pinId); }
    if (pin.sourceIds.some(id => !sources.has(id))) invalid('Pin references a missing source.');
    if (pin.voltageRange) range(pin.voltageRange);
    if (pin.driveVoltage) { quantity(pin.driveVoltage); if (units[pin.driveVoltage.unit]?.dimension !== 'voltage') invalid('Pin drive voltage requires voltage units.'); }
  }
  const connectorIds = new Set<string>();
  for (const connector of result.connectors) {
    if (connectorIds.has(connector.connectorId) || connector.pinIds.some(id => !result.pins.some(pin => pin.pinId === id))) invalid('Connector identity or logical pin reference is invalid.');
    connectorIds.add(connector.connectorId);
  }
  for (const fact of Object.values(result.facts)) quantity(fact);
  return freeze(result);
}
export function validateCatalog(value: unknown, previous: readonly ComponentDefinition[] = []): ComponentDefinition[] {
  let size = 0; try { size = new TextEncoder().encode(JSON.stringify(value)).byteLength; } catch { invalid('Catalog must contain finite JSON.'); }
  if (!Array.isArray(value) || value.length > 100 || size > 1024 * 1024) invalid('Catalog requires at most 100 versioned definitions within 1 MiB.');
  const catalog = value.map(validateDefinition), keys = new Set<string>();
  for (const definition of catalog) {
    const key = definitionKey(definition); if (keys.has(key)) invalid('Catalog repeats a definition version.'); keys.add(key);
    const prior = previous.find(item => definitionKey(item) === key);
    if (prior && stable(validateDefinition(prior)) !== stable(definition)) throw new WorkbenchError('REVISION_CONFLICT', 'An immutable definition version changed; create and review a new version.');
  }
  return catalog;
}
export function componentInstance(componentId: string, label: string, definition: ComponentDefinition | null, provisionalPins: { pinId: string; label: string }[] = []): WorkbenchManifest['components'][number] {
  if (!isRequestId(componentId) || !label.trim() || label.length > 256 || provisionalPins.length > 256 || provisionalPins.some(pin => !/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/.test(pin.pinId) || !pin.label.trim() || pin.label.length > 256) || new Set(provisionalPins.map(pin => pin.pinId.toLowerCase())).size !== provisionalPins.length) invalid('Component instance identity, label or provisional pins are invalid.');
  if (definition) validateDefinition(definition);
  return { componentId, label, definition: definition ? { definitionId: definition.definitionId, definitionVersion: definition.definitionVersion } : null, identityStatus: definition ? 'resolved' : 'unresolved', ...(!definition && provisionalPins.length ? { provisionalPins: structuredClone(provisionalPins) } : {}) };
}
export interface DefinitionMigration {
  from: { definitionId: string; definitionVersion: string }; to: { definitionId: string; definitionVersion: string };
  endpointMappings: { fromPinId: string; toPinId: string | null }[]; unresolvedPinIds: string[]; changedPinIds: string[];
}
export function definitionMigration(previous: ComponentDefinition, next: ComponentDefinition, pinMapping: Record<string, string> = {}): DefinitionMigration {
  const before = validateDefinition(previous), after = validateDefinition(next);
  validateCatalog([after], [before]);
  const explicit = new Map<string, string>();
  for (const [from, to] of Object.entries(pinMapping)) {
    const oldPin = canonicalPin(before, from), newPin = canonicalPin(after, to);
    if (!oldPin || !newPin || explicit.has(oldPin.pinId)) invalid('Definition migration maps an unknown or repeated pin.');
    explicit.set(oldPin.pinId, newPin.pinId);
  }
  const endpointMappings = before.pins.map(pin => ({ fromPinId: pin.pinId, toPinId: explicit.get(pin.pinId) ?? after.pins.find(item => item.pinId === pin.pinId)?.pinId ?? null }));
  const targets = endpointMappings.flatMap(item => item.toPinId === null ? [] : [item.toPinId]);
  if (new Set(targets).size !== targets.length) invalid('Definition migration cannot silently merge logical resources.');
  return { from: { definitionId: before.definitionId, definitionVersion: before.definitionVersion }, to: { definitionId: after.definitionId, definitionVersion: after.definitionVersion }, endpointMappings,
    unresolvedPinIds: endpointMappings.filter(item => item.toPinId === null).map(item => item.fromPinId),
    changedPinIds: endpointMappings.filter(item => item.toPinId !== item.fromPinId || stable(before.pins.find(pin => pin.pinId === item.fromPinId)) !== stable(after.pins.find(pin => pin.pinId === item.toPinId))).map(item => item.fromPinId) };
}

const pinoutId = 'arduino:uno-r3-pinout-2022-10-06', coreId = 'arduino:avr-standard-1.8.8';
const gpio: LogicalPin[] = Array.from({ length: 20 }, (_, index) => {
  const names: Record<number, string[]> = { 0: ['RX'], 1: ['TX'], 10: ['SS'], 11: ['MOSI', 'COPI'], 12: ['MISO', 'CIPO'], 13: ['SCK', 'LED_BUILTIN'], 18: ['SDA'], 19: ['SCL'] };
  return { pinId: `D${index}`, label: index < 14 ? `D${index}` : `D${index} / A${index - 14}`, aliases: [String(index), ...(index >= 14 ? [`A${index - 14}`] : []), ...(names[index] ?? [])], electricalType: 'bidirectional', modes: ['input', 'output', ...(index >= 14 ? ['analog-input' as const] : []), ...([3, 5, 6, 9, 10, 11].includes(index) ? ['pwm-output' as const] : []), ...(index >= 18 ? ['open-drain' as const] : [])], required: false, sourceIds: [pinoutId, coreId], voltageRange: null, driveVoltage: null, busKind: index >= 18 ? 'i2c' : index >= 10 && index <= 13 ? 'spi' : index <= 1 ? 'uart' : null };
});
const otherPin = (pinId: string, electricalType: LogicalPin['electricalType'], modes: LogicalPin['modes'], aliases: string[] = []): LogicalPin => ({ pinId, label: pinId, aliases, electricalType, modes, required: false, sourceIds: [pinoutId], voltageRange: null, driveVoltage: null, busKind: null });
export const referenceCatalog: readonly ComponentDefinition[] = freeze(validateCatalog([{
  schemaVersion: 1, definitionId: 'arduino:uno-r3-a000066', definitionVersion: '1', manufacturer: 'Arduino', model: 'UNO R3 A000066 reference', revision: 'R3 / A000066', package: 'Board; verify actual variant before selecting', classification: 'board',
  sources: [{ sourceId: pinoutId, uri: 'https://docs.arduino.cc/resources/pinouts/A000066-full-pinout.pdf', sha256: '088b4d7d776abf443cb050c31875221aa5fc7f0533470b33e035c249cf240007', documentVersion: 'A000066 full pinout, 2022-10-06', location: 'Page 1: external logical pin aliases and power direction labels', extractionMethod: 'manufacturer', reviewStatus: 'reviewed', reviewedBy: 'TASK-07 source review; no physical board identification' },
    { sourceId: coreId, uri: 'https://raw.githubusercontent.com/arduino/ArduinoCore-avr/1.8.8/variants/standard/pins_arduino.h', sha256: 'd313845f9916c1f21c8ba9848d40806f5caab52529ad510e81b3f15318441631', documentVersion: 'ArduinoCore-avr 1.8.8', location: 'PIN_A0..PIN_A5, PIN_SPI_*, PIN_WIRE_* and digitalPinHasPWM', extractionMethod: 'manufacturer', reviewStatus: 'reviewed', reviewedBy: 'TASK-07 source review; no physical board identification' }],
  pins: [...gpio, otherPin('GND', 'ground', ['ground'], ['GND1', 'GND2', 'GND3']), otherPin('5V', 'power-out', ['power'], ['+5V']), otherPin('3V3', 'power-out', ['power'], ['+3V3', '3.3V']), otherPin('VIN', 'power-in', ['power']), otherPin('RESET', 'unknown', ['unknown']), otherPin('AREF', 'unknown', ['unknown']), otherPin('IOREF', 'unknown', ['unknown']), otherPin('NC', 'unknown', ['unknown'])],
  connectors: [{ connectorId: 'digital', label: 'Digital/I2C logical resources; see pinout for physical positions', pinIds: [...gpio.slice(0, 14).map(pin => pin.pinId), 'D18', 'D19', 'GND', 'AREF'] }, { connectorId: 'analog', label: 'Analog logical resources', pinIds: gpio.slice(14).map(pin => pin.pinId) }, { connectorId: 'power', label: 'Power/control logical resources; shared GND is one resource', pinIds: ['NC', 'IOREF', 'RESET', '3V3', '5V', 'GND', 'VIN'] }],
  facts: { operatingVoltage: { value: null, unit: 'V', classification: 'recommended', conditions: 'No reviewed operating-range fact extracted in this reference.', applicability: 'Definition reference only; no actual-board voltage observation.', sourceId: pinoutId, reviewStatus: 'candidate', unknownReason: 'Pin labels are not a reviewed voltage operating range.' } }
}]));
