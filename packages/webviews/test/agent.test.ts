import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentApp, emptyViewState, statusLabel } from '../src/agent';
import { isWorkbenchViewResponse } from '../src/protocol';
import { agentViewFixture } from '../../test-fixtures/ui/agent-state';

const render = (state = agentViewFixture(), draft = '') => renderToStaticMarkup(createElement(AgentApp, { state, draft, onDraft: () => {}, send: () => {} }));
test('agent UI keeps provider completion distinct from failed tool receipts', () => {
  const html = render();
  assert.match(html, /Provider turn: Succeeded/);
  assert.match(html, /Tool \/ hardware operations/);
  assert.match(html, /status-failed/);
  assert.match(html, /Actual wiring is unconfirmed/);
  assert.equal(statusLabel('outcome-unknown'), 'Outcome unknown');
});
test('provider prose and markup render as inert selectable text', () => {
  const state = agentViewFixture(); state.task!.messages[1].text = '<script>globalThis.injected=true</script><a href="command:upload">upload</a>';
  const html = render(state);
  assert.equal(html.includes('<script>'), false); assert.equal(html.includes('href="command:'), false);
  assert.match(html, /&lt;script&gt;/); assert.match(html, /command:upload/);
});
test('restricted and empty view retains useful explanation and draft with execution disabled', () => {
  const html = render(emptyViewState, 'User draft survives refresh');
  assert.match(html, /Restricted Mode/); assert.match(html, /User draft survives refresh/);
  assert.match(html, /<button class="primary" disabled="">Send<\/button>/);
  assert.equal(html.includes('0 tokens'), false);
});
test('fixture respects the shared bounded view contract and rejects malformed inbound state', () => {
  const state = agentViewFixture(); assert.equal(isWorkbenchViewResponse({ schemaVersion: 1, type: 'state', state }), true);
  const invalid = structuredClone(state) as unknown as Record<string, unknown>; invalid.task = { ...state.task!, status: 'complete' };
  assert.equal(isWorkbenchViewResponse({ schemaVersion: 1, type: 'state', state: invalid }), false);
  assert.equal(isWorkbenchViewResponse({ schemaVersion: 1, type: 'state', state, credentials: 'not-a-view-field' }), false);
});
