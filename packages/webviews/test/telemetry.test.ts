import test from 'node:test';
import assert from 'node:assert/strict';
import { freezeTelemetrySelection, isTelemetryViewRequest, isTelemetryViewResponse, isTelemetryViewState } from '../src/telemetry-protocol';
import { telemetryViewFixture, telemetryFixtureIds as ids } from '../../test-fixtures/ui/telemetry-state';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TelemetryApp, alignedTelemetryData, contrastSeriesColor, savedTelemetryUi } from '../src/telemetry';

test('v1 telemetry boundary accepts bounded evidence, refuses paths, unknown fields, and non-finite values', () => {
  const state = telemetryViewFixture();
  assert.equal(isTelemetryViewState(state), true);
  assert.equal(isTelemetryViewResponse({ schemaVersion: 1, type: 'state', state }), true);
  assert.equal(isTelemetryViewState({ ...state, secret: 'unexpected' }), false);
  assert.equal(isTelemetryViewState({ ...state, window: { ...state.window, samples: [{ ...state.window!.samples[0], value: Infinity }] } }), false);
  assert.equal(isTelemetryViewState({ ...state, window: { ...state.window, configurationSha256: 'b'.repeat(64) } }), false);
  assert.equal(isTelemetryViewState({ ...state, recordings: [state.recordings[0], state.recordings[0]] }), false);
  const request = { schemaVersion: 1, requestId: ids.run, projectId: ids.project, type: 'selectRecording', payload: { recordingId: ids.recording } };
  assert.equal(isTelemetryViewRequest(request, ids.project), true);
  assert.equal(isTelemetryViewRequest({ ...request, payload: { recordingId: ids.recording, path: 'C:/private' } }), false);
  assert.equal(isTelemetryViewRequest(request, ids.secondRun), false);
  assert.equal(isTelemetryViewRequest({ ...request, type: 'judgeRun', payload: { experimentId: ids.run, outcome: 'pass' } }), false);
  assert.equal(isTelemetryViewRequest({ ...request, type: 'sendSerial', payload: {} }), false);
  assert.equal(isTelemetryViewRequest({ ...request, type: 'editProfiles', payload: {} }), true);
  assert.equal(isTelemetryViewRequest({ ...request, type: 'editProfiles', payload: { path: 'C:/private.json' } }), false);
  assert.equal(isTelemetryViewState({ ...state, live: { recordingId: ids.recording, text: 'partial raw preview', omittedBytes: null, captureActive: false } }), true);
});
test('frozen selection retains recording/channel/derivation/parser/clock/revision after live evidence changes', () => {
  const state = telemetryViewFixture(), frozen = freezeTelemetrySelection(state, 100, 300, ['range']);
  assert.ok(frozen); assert.equal(frozen.projectRevision, 12);
  state.window!.end = 9999; state.window!.derivationId = ids.secondRun; state.window!.channelIds.push('temperature'); state.project!.projectRevision++;
  assert.equal(frozen.end, 300); assert.equal(frozen.derivationId, ids.derivation); assert.deepEqual(frozen.channelIds, ['range']); assert.equal(frozen.projectRevision, 12);
  assert.equal(isTelemetryViewRequest({ schemaVersion: 1, requestId: ids.run, projectId: ids.project, type: 'ask', payload: { selection: frozen } }), true);
  assert.equal(isTelemetryViewRequest({ schemaVersion: 1, requestId: ids.run, projectId: ids.project, type: 'finishRun', payload: { experimentId: ids.run, selection: frozen } }), true);
  assert.equal(freezeTelemetrySelection(state, -1, 30, ['range']), null);
  assert.equal(freezeTelemetrySelection(state, 0, 30, ['unknown']), null);
  state.recordings[0].completion = 'active'; assert.equal(freezeTelemetrySelection(state, 0, 30, ['range']), null);
});
test('queries require an explicit clock epoch and unique bounded channel/run identities', () => {
  const base = { schemaVersion: 1, requestId: ids.run, projectId: ids.project, type: 'query', payload: { recordingId: ids.recording, profileId: ids.profile, channelIds: ['range'], timeBasis: 'device', start: 0, end: 30, deviceEpoch: 0 } };
  assert.equal(isTelemetryViewRequest(base), true);
  assert.equal(isTelemetryViewRequest({ ...base, payload: { ...base.payload, deviceEpoch: undefined } }), false);
  assert.equal(isTelemetryViewRequest({ ...base, payload: { ...base.payload, channelIds: ['range', 'range'] } }), false);
  assert.equal(isTelemetryViewRequest({ ...base, type: 'compare', payload: { experimentIds: [ids.run, ids.run] } }), false);
  assert.equal(isTelemetryViewRequest({ ...base, type: 'compare', payload: { experimentIds: [ids.run, ids.secondRun] } }), true);
});
test('read-only replay labels partial evidence, clock, parser, unknown firmware and downsampling honestly', () => {
  const state = telemetryViewFixture(); state.window!.downsampled = true; state.window!.totalSamples = 500;
  const markup = renderToStaticMarkup(createElement(TelemetryApp, { state, send: () => {} }));
  for (const text of ['Replay — read-only', 'partial', 'host-receive', 'Unknown association', 'downsampled display', 'Parser configuration and channel meanings', 'Exact displayed samples', 'Stop capture']) {
    if (text === 'Stop capture') assert.ok(!markup.includes(text)); else assert.ok(markup.includes(text), text);
  }
  assert.equal(savedTelemetryUi({ projectId: ids.project, frozen: null, styleKeys: [] })?.projectId, ids.project);
  assert.equal(savedTelemetryUi({ projectId: ids.project, frozen: null, styleKeys: [], execute: true }), undefined);
});
test('plot alignment breaks at capture gaps and discloses last-value duplicate timestamp reduction', () => {
  const state = telemetryViewFixture(), window = state.window!;
  const series = { seriesKey: 'range', channelId: 'range', label: 'Range', unit: 'mm', window, styleIndex: 0 };
  let data = alignedTelemetryData([series]); assert.ok(Array.from(data[1]).some(value => value === null)); assert.deepEqual(data[0], [0, 100, 200, 250, 300, 400]);
  window.samples.splice(1, 0, { ...window.samples[0], value: 999 }); data = alignedTelemetryData([series]); assert.equal(data[1][0], 999); assert.equal(window.samples.length, 6);
  const luminance = (rgb: number[]) => rgb.map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
  for (const background of [0, 30, 255]) for (let i = 0; i < 6; i++) { const color = contrastSeriesColor(i, `rgb(${background},${background},${background})`), values = color.match(/\d+/g)?.map(Number) ?? (color === 'white' ? [255, 255, 255] : [0, 0, 0]), a = luminance(values), b = luminance([background, background, background]); assert.ok((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 3); }
});
