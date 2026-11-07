import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isComponentDefinition } from '@robotics-workbench/contracts';
import { canonicalPin, componentInstance, convertFact, definitionMigration, findDefinition, referenceCatalog, validateCatalog, validateDefinition } from '../src/components';
import { syntheticDefinition, syntheticFact } from '../../test-fixtures/components/synthetic';

test('source-reviewed Uno reference resolves physical aliases without identifying a user board', () => {
  const uno = referenceCatalog[0];
  assert.equal(canonicalPin(uno, 'A0')?.pinId, 'D14'); assert.equal(canonicalPin(uno, '14')?.pinId, 'D14'); assert.equal(canonicalPin(uno, 'SDA')?.pinId, 'D18');
  assert.equal(canonicalPin(uno, 'COPI')?.pinId, 'D11'); assert.equal(canonicalPin(uno, 'LED_BUILTIN')?.pinId, 'D13');
  assert.equal(canonicalPin(uno, 'A6'), undefined); assert.equal(canonicalPin(uno, 'A7'), undefined);
  assert.equal(uno.pins.filter(pin => /^D\d+$/.test(pin.pinId)).length, 20);
  assert.equal(uno.facts.operatingVoltage.value, null); assert.ok(uno.facts.operatingVoltage.unknownReason); assert.ok(uno.pins.every(pin => pin.voltageRange === null && pin.driveVoltage === null));
  assert.ok(Object.isFrozen(uno) && Object.isFrozen(uno.pins) && Object.isFrozen(uno.pins[0].aliases));
  assert.equal(findDefinition(referenceCatalog, { definitionId: uno.definitionId, definitionVersion: 'unknown-version' }), undefined);
});
test('aliases, pin references, definition shape and review provenance fail closed', () => {
  const valid = syntheticDefinition(); assert.equal(isComponentDefinition(valid), true); validateDefinition(valid);
  const alias = structuredClone(valid); alias.pins[1].aliases.push('sig'); assert.throws(() => validateDefinition(alias), /aliases/);
  const missingSource = structuredClone(valid); missingSource.pins[0].sourceIds = ['missing']; assert.throws(() => validateDefinition(missingSource), /source/);
  const missingPin = structuredClone(valid); missingPin.connectors[0].pinIds.push('missing'); assert.throws(() => validateDefinition(missingPin), /Connector/);
  const candidate = structuredClone(valid); candidate.sources[0].reviewStatus = 'candidate'; assert.throws(() => validateDefinition(candidate), /unreviewed source/);
  const unknownField = { ...valid, physicallyVerified: true }; assert.equal(isComponentDefinition(unknownField), false); assert.throws(() => validateDefinition(unknownField));
  const unsafeUri = structuredClone(valid); unsafeUri.sources[0].uri = 'javascript:alert(1)'; assert.throws(() => validateDefinition(unsafeUri), /Source URI/);
});
test('unknown quantities retain a reason and measured/typical facts cannot be promoted', () => {
  const definition = syntheticDefinition(); definition.facts.limit = syntheticFact(null); const stored = validateDefinition(definition); assert.equal(stored.facts.limit.value, null);
  const noReason = structuredClone(definition); noReason.facts.limit.unknownReason = null; assert.throws(() => validateDefinition(noReason), /Unknown quantities/);
  const zero = structuredClone(definition); zero.facts.limit = syntheticFact(0); assert.equal(validateDefinition(zero).facts.limit.value, 0);
  const measured = structuredClone(definition); measured.facts.limit = syntheticFact(5, { classification: 'measured' }); assert.throws(() => validateDefinition(measured), /measurement source/);
  const typical = convertFact(syntheticFact(3300, { unit: 'mV', classification: 'typical' }), 'V'); assert.equal(typical.classification, 'typical');
  const invalid = structuredClone(definition); invalid.facts.limit = syntheticFact(Number.NaN); assert.throws(() => validateDefinition(invalid));
});
test('unit conversion preserves original value, unknowns and incompatible dimensions', () => {
  const original = syntheticFact(3300, { unit: 'mV' }), converted = convertFact(original, 'V');
  assert.ok(Math.abs(converted.value! - 3.3) < 1e-12); assert.equal(converted.originalValue, 3300); assert.equal(converted.originalUnit, 'mV'); assert.equal(original.value, 3300); assert.equal(original.unit, 'mV');
  assert.ok(Math.abs(convertFact(converted, 'mV').value! - 3300) < 1e-9); assert.equal(convertFact(converted, 'mV').originalUnit, 'mV');
  const unknown = convertFact(syntheticFact(null), 'mV'); assert.equal(unknown.value, null); assert.ok(unknown.unknownReason);
  assert.throws(() => convertFact(original, 'A'), /same dimension/); assert.throws(() => convertFact(original, 'unverified-unit'));
  assert.throws(() => convertFact(syntheticFact(null, { unit: 'constructor' }), 'toString'), /supported units/);
  const definition = syntheticDefinition(); definition.facts.converted = { ...converted, value: 4 }; assert.throws(() => validateDefinition(definition), /retained source value/);
});
test('explicit voltage range bounds reject incompatible, reversed and empty intervals', () => {
  const definition = syntheticDefinition(); const range = definition.pins[0].voltageRange!;
  range.minimum = syntheticFact(1000, { unit: 'mV' }); range.maximum = syntheticFact(2); validateDefinition(definition);
  const incompatible = structuredClone(definition); incompatible.pins[0].voltageRange!.minimum.unit = 'A'; assert.throws(() => validateDefinition(incompatible), /voltage units/);
  const reversed = structuredClone(definition); reversed.pins[0].voltageRange!.minimum = syntheticFact(3); assert.throws(() => validateDefinition(reversed), /reversed/);
  const empty = structuredClone(definition); empty.pins[0].voltageRange!.minimum = syntheticFact(2); empty.pins[0].voltageRange!.minimumInclusive = false; assert.throws(() => validateDefinition(empty), /empty/);
  const equivalent = structuredClone(definition); equivalent.pins[0].voltageRange!.minimum = syntheticFact(3300, { unit: 'mV' }); equivalent.pins[0].voltageRange!.maximum = syntheticFact(3.3); validateDefinition(equivalent);
  equivalent.pins[0].voltageRange!.maximumInclusive = false; assert.throws(() => validateDefinition(equivalent), /empty/);
});

test('definition and catalog boundaries reject excessive counts and payload sizes', () => {
  const definition = syntheticDefinition();
  const tooManyAliases = structuredClone(definition); tooManyAliases.pins[0].aliases = Array.from({ length: 65 }, (_, index) => `alias${index}`); assert.throws(() => validateDefinition(tooManyAliases));
  const oversizedLabel = structuredClone(definition); oversizedLabel.model = 'x'.repeat(257); assert.throws(() => validateDefinition(oversizedLabel));
  assert.throws(() => validateCatalog(Array.from({ length: 101 }, () => definition)));
  assert.throws(() => validateCatalog(['x'.repeat(1024 * 1024)]));
});
test('catalog versions are immutable while new versions remain explicit', () => {
  const initial = validateDefinition(syntheticDefinition()), changed = structuredClone(initial); changed.model = 'Silently replaced model';
  assert.throws(() => validateCatalog([changed], [initial]), { code: 'REVISION_CONFLICT' });
  changed.definitionVersion = '2'; assert.equal(validateCatalog([initial, changed], [initial]).length, 2);
  assert.throws(() => validateCatalog([initial, initial]));
  const reordered = Object.fromEntries(Object.entries(initial).reverse()); assert.equal(validateCatalog([reordered], [initial]).length, 1);
});
test('definition migration records unmapped endpoints rather than guessing or merging resources', () => {
  const previous = syntheticDefinition(), next = structuredClone(previous); next.definitionVersion = '2'; next.pins[0].pinId = 'sense'; next.connectors[0].pinIds[0] = 'sense';
  const unresolved = definitionMigration(previous, next); assert.deepEqual(unresolved.unresolvedPinIds, ['signal']);
  const mapped = definitionMigration(previous, next, { SIG: 'sense' }); assert.deepEqual(mapped.endpointMappings, [{ fromPinId: 'signal', toPinId: 'sense' }, { fromPinId: 'gnd', toPinId: 'gnd' }]); assert.deepEqual(mapped.changedPinIds, ['signal']);
  assert.throws(() => definitionMigration(previous, next, { missing: 'sense' }));
  assert.throws(() => definitionMigration(previous, next, { signal: 'sense', GND: 'sense' }), /merge logical resources/);
});
test('instances share exact definitions but retain separate identity and unresolved candidates', () => {
  const definition = validateDefinition(syntheticDefinition()), first = componentInstance(randomUUID(), 'Front sensor', definition), second = componentInstance(randomUUID(), 'Rear sensor', definition);
  assert.notEqual(first.componentId, second.componentId); assert.deepEqual(first.definition, second.definition); first.label = 'Renamed front'; assert.equal(second.label, 'Rear sensor');
  assert.equal(findDefinition([definition], first.definition), definition);
  const unknown = componentInstance(randomUUID(), 'Unidentified module', null, [{ pinId: 'SIG', label: 'User-entered SIG' }]); assert.equal(unknown.definition, null); assert.equal(unknown.identityStatus, 'unresolved'); assert.equal('facts' in unknown, false);
  assert.throws(() => componentInstance('Front sensor', 'Not a UUID', definition));
});
