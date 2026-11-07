import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WiringApp, connectionOperations, savedWiringUi, wiringEdges } from '../src/wiring';
import { isWiringOperation, isWiringViewRequest, isWiringViewResponse, isWiringViewState } from '../src/wiring-protocol';
import { wiringViewFixture, wiringFixtureIds as ids } from '../../test-fixtures/ui/wiring-state';

test('wiring fixture and strict messages reject hostile scope, status and path data', () => {
  const state = wiringViewFixture(); assert.equal(isWiringViewState(state), true); assert.equal(isWiringViewResponse({ schemaVersion: 1, type: 'state', state }), true);
  const request = { schemaVersion: 1, requestId: ids.binding, projectId: ids.project, type: 'propose', payload: { operations: [{ type: 'component.rename', componentId: ids.sensor, label: 'Front sensor' }] } };
  assert.equal(isWiringViewRequest(request, ids.project), true); assert.equal(isWiringViewRequest(request, ids.board), false);
  assert.equal(isWiringViewRequest({ ...request, payload: { ...request.payload, shell: 'arbitrary' } }), false);
  assert.equal(isWiringOperation({ type: 'binding.set', binding: { bindingId: ids.binding, componentId: ids.sensor, path: '../private' } }), false);
  assert.equal(isWiringOperation({ type: 'component.replace', component: state.manifest!.components[0] }), false, 'Inverse-only operations never originate in renderer.');
  const bad = structuredClone(state); bad.rules[0].outcome = 'safe' as never; assert.equal(isWiringViewState(bad), false);
  assert.equal(isWiringViewRequest({ schemaVersion: 1, requestId: ids.binding, projectId: ids.project, type: 'layout', payload: { positions: { [ids.board]: { x: Infinity, y: 1 } } } }), false);
});
test('table and canvas connection helper merges endpoint nets without changing manifest', () => {
  const state = wiringViewFixture(), manifest = structuredClone(state.manifest!); const before = JSON.stringify(manifest);
  manifest.nets.push({ netId: ids.binding, members: [{ componentId: ids.sensor, pinId: 'trig' }, { componentId: ids.board, pinId: 'trig' }] });
  const first = { componentId: ids.sensor, pinId: 'trig' }, second = { componentId: ids.second, pinId: 'sda' };
  const table = connectionOperations(manifest, first, second, ids.document), canvas = connectionOperations(manifest, first, second, ids.document);
  assert.deepEqual(table, canvas); assert.equal(table.length, 2); assert.equal(table[0].type, 'net.set'); assert.equal(table[1].type, 'net.remove');
  assert.equal(table[0].type === 'net.set' && table[0].net.netId, ids.net); assert.equal(table[0].type === 'net.set' && table[0].net.members.length, 5);
  assert.equal(JSON.stringify(state.manifest), before); assert.deepEqual(connectionOperations(manifest, first, first, ids.document), []);
});
test('multiendpoint star geometry retains one net identity and has no directional arrows', () => {
  const state = wiringViewFixture(), edges = wiringEdges(state); assert.equal(edges.length, 2);
  assert.ok(edges.every(edge => edge.data?.netId === ids.net && edge.markerEnd === undefined && edge.markerStart === undefined));
  const baseline = JSON.stringify(state.manifest!.nets); state.layout.positions[ids.board] = { x: 999, y: -100 };
  assert.deepEqual(wiringEdges(state), edges); assert.equal(JSON.stringify(state.manifest!.nets), baseline);
});
test('renderer labels unknown and historical evidence and escapes untrusted component text', () => {
  const state = wiringViewFixture(); state.manifest!.components[0].label = '<script>window.bad=1</script>';
  const html = renderToStaticMarkup(createElement(WiringApp, { state, send: () => {} }));
  assert.match(html, /Intended wiring/); assert.match(html, /Unresolved identity/); assert.match(html, /Stale report/); assert.match(html, /Unknown/); assert.ok(!html.includes('<script>window.bad'));
  assert.match(html, /Source line/); assert.match(html, /Computed pin expressions are not inferred/); assert.match(html, /Ask about selection/);
});
test('invalid persisted draft and viewport cannot become executable or malformed UI state', () => {
  assert.equal(savedWiringUi({ tab: 'bad', draft: {}, addOpen: false, connectOpen: false }), undefined);
  assert.equal(savedWiringUi({ tab: 'canvas', draft: { label: {} }, addOpen: false, connectOpen: false }), undefined);
  assert.equal(savedWiringUi({ tab: 'canvas', draft: {}, addOpen: false, connectOpen: false, viewport: { x: 0, y: 0, zoom: Infinity } }), undefined);
  assert.equal(savedWiringUi({ tab: 'components', draft: { label: 'Retained draft' }, addOpen: true, connectOpen: false })?.draft?.label, 'Retained draft');
});
