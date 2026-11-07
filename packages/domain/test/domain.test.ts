import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertManifestSemantics, assertRevision, assertTransition } from '../src/index';
import { validateManifest, type WorkbenchManifest, type OperationStatus } from '@robotics-workbench/contracts';
import fixture from '../../../examples/workbench.valid.json';

const manifest = (): WorkbenchManifest => structuredClone(validateManifest(fixture));
const componentId = '22222222-2222-4222-8222-222222222222';

test('semantic validation preserves ordinary identities and rejects duplicate/missing references', () => {
  const value = manifest();
  assert.doesNotThrow(() => assertManifestSemantics(value));
  value.targets.push({ ...value.targets[0] });
  assert.throws(() => assertManifestSemantics(value), { code: 'INVALID_REQUEST' });
  const missing = manifest();
  missing.sketches[0].targetId = componentId;
  assert.throws(() => assertManifestSemantics(missing), { code: 'INVALID_REQUEST' });
  const binding = manifest();
  binding.codeBindings.push({ bindingId: componentId, componentId, path: 'RangeSensor/RangeSensor.ino' });
  assert.throws(() => assertManifestSemantics(binding), { code: 'INVALID_REQUEST' });
});

test('unresolved provisional pins remain design intent with referential checks', () => {
  const value = manifest();
  value.components.push({ componentId, label: 'Unresolved sensor', definition: null, identityStatus: 'unresolved',
    provisionalPins: [{ pinId: 'vcc', label: 'VCC' }, { pinId: 'gnd', label: 'GND' }] });
  value.nets.push({ netId: '33333333-3333-4333-8333-333333333333', members: [{ componentId, pinId: 'vcc' }, { componentId, pinId: 'gnd' }] });
  assert.doesNotThrow(() => assertManifestSemantics(value));
  value.components[0].label = 'Renamed sensor';
  assert.doesNotThrow(() => assertManifestSemantics(value));
  value.nets[0].members[1].pinId = 'missing';
  assert.throws(() => assertManifestSemantics(value), { code: 'INVALID_REQUEST' });
  value.nets[0].members[1].pinId = 'gnd';
  value.components[0].provisionalPins!.push({ pinId: 'vcc', label: 'alias' });
  assert.throws(() => assertManifestSemantics(value), { code: 'INVALID_REQUEST' });
});

test('resolved pin checks use supplied immutable definition facts', () => {
  const value = manifest();
  value.components.push({ componentId, label: 'Sensor', definition: { definitionId: 'fixture:sensor', definitionVersion: '1' } });
  value.codeBindings.push({ bindingId: '33333333-3333-4333-8333-333333333333', componentId, pinId: 'trig', path: 'RangeSensor/a.h' });
  const definitions = new Map([['fixture:sensor@1', new Set(['trig'])]]);
  assert.doesNotThrow(() => assertManifestSemantics(value, definitions));
  value.codeBindings[0].pinId = 'other';
  assert.throws(() => assertManifestSemantics(value, definitions), { code: 'INVALID_REQUEST' });
});

test('revision checks detect manual edits under unchanged project revision', () => {
  const value = manifest();
  const hash = 'a'.repeat(64);
  assert.doesNotThrow(() => assertRevision(value, 1, hash, hash));
  assert.throws(() => assertRevision(value, 2, hash, hash), { code: 'REVISION_CONFLICT' });
  assert.throws(() => assertRevision(value, 1, hash, 'b'.repeat(64)), { code: 'REVISION_CONFLICT' });
  assert.throws(() => assertRevision(value, 1, '', ''), { code: 'REVISION_CONFLICT' });
});

test('operation transitions preserve terminal outcomes including uncertainty', () => {
  assert.doesNotThrow(() => assertTransition('queued', 'running'));
  assert.doesNotThrow(() => assertTransition('running', 'outcome-unknown'));
  const states: OperationStatus[] = ['queued', 'running', 'awaiting-input', 'succeeded', 'failed', 'cancelled', 'outcome-unknown'];
  for (const terminal of ['succeeded', 'failed', 'cancelled', 'outcome-unknown'] as const) {
    for (const next of states) assert.throws(() => assertTransition(terminal, next), { code: 'INVALID_REQUEST' });
  }
  assert.throws(() => assertTransition('queued', 'succeeded'), { code: 'INVALID_REQUEST' });
});
