import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeNets, componentPins, validateWiring } from '../src/wiring';
import { definition, fact, ids, pin, wiringFixture } from '../../test-fixtures/wiring/fixtures';

test('canonical unordered nets resolve aliases and resource conflicts cannot hide behind aliases', () => {
  const { manifest, catalog } = wiringFixture(), before = structuredClone(manifest);
  const canonical = canonicalizeNets(manifest, catalog);
  assert.equal(canonical[0].members.find(endpoint => endpoint.componentId === ids.a)!.pinId, 'signal');
  manifest.nets[0].members.reverse(); assert.deepEqual(canonicalizeNets(manifest, catalog), canonical);
  manifest.nets.push({ netId: ids.otherNet, members: [{ componentId: ids.a, pinId: 'signal' }, { componentId: ids.c, pinId: 'input' }] });
  assert.ok(validateWiring(manifest, catalog).some(result => result.ruleId === 'wiring.resource-allocation' && result.outcome === 'fail'));
  assert.equal(before.nets.length, 1); assert.equal(before.nets[0].members[1].pinId, 'SIG');
});
test('shared open-drain multiendpoint bus is allowed without inventing pull-up or address validation', () => {
  const { manifest } = wiringFixture(); const bus = definition('fixture:bus', [pin('data', 'open-drain', { busKind: 'i2c' })]);
  manifest.components = manifest.components.map(component => ({ ...component, definition: { definitionId: bus.definitionId, definitionVersion: '1' } }));
  manifest.codeBindings = []; manifest.nets = [{ netId: ids.net, members: [ids.a, ids.b, ids.c].map(componentId => ({ componentId, pinId: 'data' })) }];
  const results = validateWiring(manifest, [bus]);
  assert.equal(results.some(result => result.outcome === 'fail'), false);
  const checked = results.find(result => result.ruleId === 'wiring.bus')!;
  assert.equal(checked.outcome, 'pass'); assert.match(checked.explanation, /remain unchecked/);
});
test('known output and voltage incompatibilities fail with source references, typical limits cannot pass', () => {
  const { manifest, catalog } = wiringFixture();
  assert.equal(validateWiring(manifest, catalog).find(result => result.ruleId === 'wiring.voltage')!.outcome, 'pass');
  catalog[1].pins[0].voltageRange!.maximum = fact(3.3);
  const exceeded = validateWiring(manifest, catalog).find(result => result.ruleId === 'wiring.voltage')!;
  assert.equal(exceeded.outcome, 'fail'); assert.ok(exceeded.sourceFacts.includes('fixture:receiver@1:synthetic'));
  catalog[1].pins[0].voltageRange!.maximum = fact(5, 'typical');
  assert.equal(validateWiring(manifest, catalog).find(result => result.ruleId === 'wiring.voltage')!.outcome, 'not-checked');
  manifest.components[1].definition = { definitionId: 'fixture:driver', definitionVersion: '1' }; manifest.nets[0].members[0].pinId = 'signal';
  assert.equal(validateWiring(manifest, catalog).find(result => result.ruleId === 'wiring.signal-direction')!.outcome, 'fail');
});
test('unknown identity and limits stay not-checked; explicit crossings and layout produce no connections', () => {
  const { manifest, catalog } = wiringFixture();
  manifest.components[1] = { componentId: ids.b, label: 'Unresolved', definition: null, identityStatus: 'unresolved', provisionalPins: [{ pinId: 'input', label: 'input' }] };
  const results = validateWiring(manifest, catalog);
  assert.equal(results.find(result => result.ruleId === 'wiring.voltage')!.outcome, 'not-checked');
  assert.equal(results.find(result => result.ruleId === 'wiring.signal-direction')!.outcome, 'not-checked');
  assert.equal(componentPins(manifest.components[1], catalog)[0].driveVoltage, null);
  manifest.nets = []; assert.equal(canonicalizeNets(manifest, catalog).length, 0);
  assert.equal(validateWiring(manifest, catalog).some(result => result.ruleId === 'wiring.voltage' && result.outcome === 'pass'), false);
});
test('required endpoints and conflicting selected modes produce attributed failures', () => {
  const { manifest, catalog } = wiringFixture(); catalog[1].pins[0].required = true;
  assert.ok(validateWiring(manifest, catalog).some(result => result.ruleId === 'wiring.required-connections' && result.affectedIds.includes(ids.c) && result.outcome === 'fail'));
  manifest.components[0].properties!.pinModes = { signal: 'output', SIG: 'input' };
  assert.ok(validateWiring(manifest, catalog).some(result => result.ruleId === 'wiring.pin-mode' && result.outcome === 'fail'));
  const binding = validateWiring(manifest, catalog).find(result => result.ruleId === 'wiring.code-binding')!;
  assert.equal(binding.outcome, 'not-checked'); assert.match(binding.explanation, /not inferred/);
});
test('unit conversion roundoff respects inclusive bounds without treating absolute maxima as recommendations', () => {
  const { manifest, catalog } = wiringFixture(); catalog[0].pins[0].driveVoltage = fact(3.3);
  catalog[1].pins[0].voltageRange!.minimum = { ...fact(3300), unit: 'mV' };
  assert.equal(validateWiring(manifest, catalog).find(rule => rule.ruleId === 'wiring.voltage')!.outcome, 'pass');
  catalog[1].pins[0].voltageRange!.minimumInclusive = false;
  assert.equal(validateWiring(manifest, catalog).find(rule => rule.ruleId === 'wiring.voltage')!.outcome, 'fail');
  catalog[1].pins[0].voltageRange = { minimum: fact(0, 'absolute-maximum'), maximum: fact(5, 'absolute-maximum'), minimumInclusive: true, maximumInclusive: true };
  assert.equal(validateWiring(manifest, catalog).find(rule => rule.ruleId === 'wiring.voltage')!.outcome, 'not-checked');
});
test('candidate electrical metadata never becomes a passing direction or voltage claim', () => {
  const { manifest, catalog } = wiringFixture(); catalog[0].sources[0].reviewStatus = 'candidate'; catalog[0].sources[0].reviewedBy = null; catalog[0].pins[0].driveVoltage = null;
  manifest.components[0].properties!.pinModes = { signal: 'output' };
  assert.equal(componentPins(manifest.components[0], catalog)[0].electricalType, 'unknown');
  const results = validateWiring(manifest, catalog);
  assert.equal(results.find(rule => rule.ruleId === 'wiring.signal-direction')!.outcome, 'not-checked');
  assert.equal(results.find(rule => rule.ruleId === 'wiring.voltage')!.outcome, 'not-checked');
  assert.equal(results.find(rule => rule.ruleId === 'wiring.pin-mode')!.outcome, 'not-checked');
});
