import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EngineeringApp, emptyEngineeringState } from '../src/engineering';
import { isEngineeringRequest, isEngineeringResponse, isEngineeringState } from '../src/engineering-protocol';
import { engineeringViewFixture, engineeringFixtureIds as ids } from '../../test-fixtures/ui/engineering-state';
const request = (type: string, payload: Record<string, unknown> = {}) => ({ schemaVersion: 1, requestId: ids.request, projectId: ids.project, type, payload });
const render = (state = engineeringViewFixture()) => renderToStaticMarkup(createElement(EngineeringApp, { state, send: () => {} }));
test('engineering intents bind existing identities and reject arbitrary paths, commands, cross-project scope and invalid assumptions', () => {
  assert.ok(isEngineeringState(engineeringViewFixture())); assert.ok(isEngineeringState(emptyEngineeringState));
  assert.ok(isEngineeringResponse({ schemaVersion: 1, type: 'state', state: engineeringViewFixture() }));
  assert.ok(isEngineeringRequest(request('previewSheet', { generationId: ids.generation, sheetId: ids.sheet }), ids.project));
  assert.equal(isEngineeringRequest(request('previewSheet', { generationId: ids.generation, sheetId: ids.sheet }), ids.asset), false);
  assert.equal(isEngineeringRequest(request('generateSchematic', { sourcePath: '../native.kicad_sch' })), false);
  assert.equal(isEngineeringRequest(request('executeCommand', { command: 'firmware.upload' })), false);
  assert.equal(isEngineeringRequest(request('exportCad', { assetId: ids.asset, operationId: ids.operation, format: 'stl', path: 'C:/secret' })), false);
  assert.equal(isEngineeringRequest(request('generateCad', { assetId: ids.asset, mode: 'exploratory', assumptions: { holeSpacing: Infinity } })), false);
  assert.ok(isEngineeringRequest(request('generateCad', { assetId: ids.asset, mode: 'exploratory', assumptions: { holeSpacing: 12 } })));
});
test('preview validation prevents source/sheet substitution and refuses non-image URLs', () => {
  for (const change of [{ sourceSha256: 'c'.repeat(64) }, { sheetId: ids.asset }, { projectRevision: 10 }, { dataUrl: 'https://example.invalid/preview.svg' }, { dataUrl: 'data:text/html,<script>alert(1)</script>' }]) {
    const state = engineeringViewFixture(); Object.assign(state.preview!, change); assert.equal(isEngineeringState(state), false);
  }
});
test('schematic view separates process success, failing ERC, equivalence, divergence and physical truth', () => {
  const html = render();
  assert.match(html, />Check process completed<\/p>/); assert.match(html, /Validation FAIL<\/p>/); assert.match(html, /matched intended endpoint sets/);
  assert.match(html, /Independent native edits — diverged/); assert.match(html, /Outdated/); assert.match(html, /revision 3/);
  assert.match(html, /<img /); assert.ok(!html.includes('<svg')); assert.ok(!html.includes('<script'));
  assert.match(html, /never overwrites native source/); assert.match(html, /does not verify connectivity/);
});
test('CAD unknown fit-critical inputs block production, failed regeneration retains good geometry and viewer handoff stays separate', () => {
  const state = engineeringViewFixture(); state.screen = 'cad';
  const html = render(state);
  assert.match(html, /Unknown fit-critical dimensions/); assert.match(html, /disabled=""[^>]*>Generate production model/);
  assert.match(html, /Operation failed/); assert.match(html, /Last successful geometry/); assert.match(html, /millimeters \(mm\)/);
  assert.match(html, /Viewer status: handoff-required/); assert.match(html, /Geometry checks do not establish physical fit/);
  assert.match(html, /Open Python source/); assert.match(html, /Review STEP export/);
});
test('loading, empty, unavailable, stale and error states remain explicit, markup inert and retained artifacts visible', () => {
  assert.match(render(emptyEngineeringState), /No project selected/);
  const state = engineeringViewFixture(); state.loading = true; state.error = '<img src=x onerror=upload()> tool unavailable'; state.schematic!.readiness = { available: false, reason: 'Configure supported KiCad path in settings.' };
  const html = render(state); assert.match(html, /Refreshing \/ action in progress/); assert.match(html, /Configure supported KiCad/); assert.match(html, /&lt;img src=x/); assert.match(html, /Per-sheet preview/); assert.ok(!html.includes('<img src=x'));
});
