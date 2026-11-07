import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWiring, isWiringOperations } from '../src/wiring/index';
import { canonicalizeNets } from '@robotics-workbench/domain';
import { ids, wiringFixture } from '../../test-fixtures/wiring/fixtures';
import type { WorkbenchManifest, ComponentDefinition } from '@robotics-workbench/contracts';

const intent = (manifest: WorkbenchManifest, catalog: ComponentDefinition[]) => ({ ...manifest, projectRevision: 1, nets: canonicalizeNets(manifest, catalog), codeBindings: manifest.codeBindings.map(binding => binding.pinId === 'SIG' ? { ...binding, pinId: 'signal' } : binding) });
test('table and canvas endpoint order generate one canonical transaction; no-op does not change revision', () => {
  const { manifest, catalog } = wiringFixture(); const net = { ...manifest.nets[0], members: [...manifest.nets[0].members, { componentId: ids.c, pinId: 'input' }] };
  const table = planWiring(manifest, 1, [{ type: 'net.set', net }], catalog);
  const canvas = planWiring(manifest, 1, [{ type: 'net.set', net: { ...net, members: [...net.members].reverse() } }], catalog);
  assert.deepEqual(table.next.nets, canvas.next.nets); assert.equal(table.next.projectRevision, 2); assert.equal(table.confirmationInvalidated, true);
  assert.deepEqual(table.next.extensions, manifest.extensions); assert.equal(manifest.projectRevision, 1); assert.equal(manifest.nets[0].members.length, 2);
  const unchanged = planWiring(manifest, 1, [{ type: 'net.set', net: { ...manifest.nets[0], members: [...manifest.nets[0].members].reverse() } }], catalog);
  assert.equal(unchanged.next.projectRevision, 1); assert.equal(unchanged.confirmationInvalidated, false); assert.deepEqual(unchanged.inverseOperations, []);
});
test('stable rename and explicit source bindings preserve identities, unknown expression remains unchecked', () => {
  const { manifest, catalog } = wiringFixture();
  const planned = planWiring(manifest, 1, [{ type: 'component.rename', componentId: ids.a, label: 'Renamed' }, { type: 'binding.set', binding: { ...manifest.codeBindings[0], symbol: '(PIN_BASE + OFFSET)' } }], catalog);
  assert.equal(planned.next.components[0].componentId, ids.a); assert.deepEqual(planned.next.components[0].properties, manifest.components[0].properties);
  assert.equal(planned.next.codeBindings[0].bindingId, ids.binding); assert.equal(planned.next.codeBindings[0].pinId, 'signal');
  assert.equal(planned.rules.find(rule => rule.ruleId === 'wiring.code-binding')!.outcome, 'not-checked');
  assert.deepEqual(intent(planWiring(planned.next, 2, planned.inverseOperations, catalog).next, catalog), intent(manifest, catalog));
});
test('removal previews coherent endpoint/binding/document effects and its inverse preserves historical IDs', () => {
  const { manifest, catalog } = wiringFixture();
  manifest.codeBindings.push({ ...manifest.codeBindings[0], bindingId: '11000000-0000-4000-8000-000000000010', componentId: ids.b, pinId: 'input', symbol: 'OTHER_PIN' }, { ...manifest.codeBindings[0], bindingId: '11000000-0000-4000-8000-000000000011', symbol: 'LAST_PIN' });
  assert.throws(() => planWiring(manifest, 1, [{ type: 'component.remove', componentId: ids.a, removeBindings: false }], catalog));
  const removed = planWiring(manifest, 1, [{ type: 'component.remove', componentId: ids.a, removeBindings: true }], catalog);
  assert.equal(removed.next.components.some(component => component.componentId === ids.a), false); assert.equal(removed.next.nets.length, 0); assert.equal(removed.next.codeBindings.length, 1);
  assert.deepEqual(removed.next.documents[0].componentIds, [ids.b]); assert.match(removed.changes[0], /historical evidence are retained/);
  const restored = planWiring(removed.next, 2, removed.inverseOperations, catalog);
  assert.equal(restored.next.projectRevision, 3); assert.deepEqual(intent(restored.next, catalog), intent(manifest, catalog));
});

test('merge and split retain explicit net identities in previews and inverse history', () => {
  const { manifest, catalog } = wiringFixture();
  const merged = planWiring(manifest, 1, [{ type: 'net.set', net: { ...manifest.nets[0], members: [...manifest.nets[0].members, { componentId: ids.c, pinId: 'input' }] } }], catalog);
  const split = planWiring(merged.next, 2, [
    { type: 'net.set', net: manifest.nets[0] },
    { type: 'net.set', net: { netId: ids.otherNet, members: [{ componentId: ids.b, pinId: 'input' }, { componentId: ids.c, pinId: 'input' }] } }
  ], catalog);
  assert.deepEqual(split.next.nets.map(net => net.netId), [ids.net, ids.otherNet]);
  assert.ok(split.changes.some(change => change.includes(ids.otherNet)));
  assert.ok(split.rules.some(rule => rule.ruleId === 'wiring.resource-allocation' && rule.outcome === 'fail'));
  const restored = planWiring(split.next, 3, split.inverseOperations, catalog);
  assert.deepEqual(intent(restored.next, catalog), intent(merged.next, catalog));
  assert.deepEqual(intent(planWiring(merged.next, 2, merged.inverseOperations, catalog).next, catalog), intent(manifest, catalog));
});
test('definition migration previews exact pin changes and preserves properties/modes through undo', () => {
  const { manifest, catalog } = wiringFixture(); manifest.components[0].properties!.pinModes = { signal: 'output' };
  const version = structuredClone(catalog[0]); version.definitionVersion = '2'; version.pins[0].pinId = 'new-signal'; version.pins[0].aliases = ['NEWSIG']; catalog.push(version);
  assert.throws(() => planWiring(manifest, 1, [{ type: 'component.resolve', componentId: ids.a, definition: { definitionId: version.definitionId, definitionVersion: '2' } }], catalog));
  const migrated = planWiring(manifest, 1, [{ type: 'component.resolve', componentId: ids.a, definition: { definitionId: version.definitionId, definitionVersion: '2' }, pinMapping: { signal: 'new-signal' } }], catalog);
  assert.equal(migrated.next.codeBindings[0].pinId, 'new-signal'); assert.deepEqual(migrated.next.components[0].properties!.pinModes, { 'new-signal': 'output' });
  assert.ok(migrated.changes.some(change => change.includes('signal -> new-signal')));
  const restored = planWiring(migrated.next, 2, migrated.inverseOperations, catalog); assert.deepEqual(intent(restored.next, catalog), intent(manifest, catalog));
});
test('unresolved identity stays useful, and resolving or clearing it is a reviewed reversible change', () => {
  const { manifest, catalog } = wiringFixture();
  const unresolved = planWiring(manifest, 1, [{ type: 'component.resolve', componentId: ids.a, definition: null }], catalog);
  assert.equal(unresolved.next.components[0].definition, null); assert.deepEqual(unresolved.next.components[0].provisionalPins, [{ pinId: 'signal', label: 'signal' }]);
  assert.ok(unresolved.rules.some(rule => rule.ruleId === 'wiring.voltage' && rule.outcome === 'not-checked'));
  assert.deepEqual(intent(planWiring(unresolved.next, 2, unresolved.inverseOperations, catalog).next, catalog), intent(manifest, catalog));
});
test('chosen pin modes use canonical resource and keep unknown user properties', () => {
  const { manifest, catalog } = wiringFixture();
  const planned = planWiring(manifest, 1, [{ type: 'pin.mode', componentId: ids.a, pinId: 'SIG', mode: 'output' }], catalog);
  assert.deepEqual(planned.next.components[0].properties, { preserved: { user: true }, pinModes: { signal: 'output' } });
  assert.deepEqual(intent(planWiring(planned.next, 2, planned.inverseOperations, catalog).next, catalog), intent(manifest, catalog));
  assert.throws(() => planWiring(manifest, 1, [{ type: 'pin.mode', componentId: ids.a, pinId: 'signal', mode: 'unsupported' }], catalog));
});
test('stale/invalid patches fail atomically and cannot smuggle layout, paths or unknown operation fields', () => {
  const { manifest, catalog } = wiringFixture(), before = structuredClone(manifest);
  assert.throws(() => planWiring(manifest, 2, [{ type: 'component.rename', componentId: ids.a, label: 'Changed' }], catalog), { code: 'REVISION_CONFLICT' });
  assert.throws(() => planWiring(manifest, 1, [{ type: 'component.rename', componentId: ids.a, label: 'Changed' }, { type: 'net.set', net: { netId: ids.otherNet, members: [{ componentId: ids.a, pinId: 'signal' }, { componentId: ids.target, pinId: 'missing' }] } }], catalog));
  for (const path of ['../outside.ino', 'C:/outside.ino', 'folder\\source.ino', 'CON.ino', 'folder./source.ino']) assert.throws(() => planWiring(manifest, 1, [{ type: 'binding.set', binding: { ...manifest.codeBindings[0], path } }], catalog));
  assert.equal(isWiringOperations([{ type: 'layout', positions: {} }]), false);
  assert.equal(isWiringOperations([{ type: 'component.rename', componentId: ids.a, label: 'Renamed', execute: 'shell' }]), false);
  assert.equal(isWiringOperations([]), false); assert.deepEqual(manifest, before);
});
