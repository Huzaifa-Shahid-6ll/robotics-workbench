import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { auditContrast } from './contrast.mjs';

const root = resolve(process.env.WORKBENCH_UI_ARTIFACT_ROOT || 'artifacts/task07-ui'), evidence = resolve(process.env.WORKBENCH_UI_EVIDENCE_ROOT || 'verification/evidence/task-07/ui');
await mkdir(root, { recursive: true }); await mkdir(evidence, { recursive: true }); await mkdir(resolve('artifacts/tmp'), { recursive: true });
process.env.TEMP = process.env.TMP = resolve('artifacts/tmp');
await build({ entryPoints: ['packages/webviews/src/wiring.tsx'], bundle: true, platform: 'browser', format: 'iife', target: 'es2022', minify: true, define: { 'process.env.NODE_ENV': '"production"' }, outfile: join(root, 'wiring.js') });
for (const name of ['wiring.js', 'wiring.css']) assert.deepEqual(await readFile(join(root, name)), await readFile(resolve('apps/extension/dist', name)), `QA ${name} must match packaged bytes; run npm run build first`);
await build({ entryPoints: ['packages/test-fixtures/ui/wiring-state.ts', 'packages/webviews/src/wiring-protocol.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node24', outdir: root, outExtension: { '.js': '.cjs' } });
const require = createRequire(import.meta.url), { wiringViewFixture, wiringFixtureIds: ids } = require(join(root, 'test-fixtures/ui/wiring-state.cjs')), { isWiringViewRequest, isWiringViewState } = require(join(root, 'webviews/src/wiring-protocol.cjs'));
const theme = `:root{--vscode-font-family:system-ui;--vscode-font-size:13px;--vscode-editor-font-family:Consolas,monospace}
:root[data-theme=dark]{color-scheme:dark;--vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#d4d4d4;--vscode-descriptionForeground:#b0b0b0;--vscode-panel-border:#666;--vscode-input-background:#313131;--vscode-input-foreground:#fff;--vscode-input-border:#888;--vscode-focusBorder:#007fd4;--vscode-button-background:#0e639c;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#383838;--vscode-button-secondaryForeground:#fff;--vscode-textLink-foreground:#64b5f6;--vscode-errorForeground:#ff9999;--vscode-disabledForeground:#aaa}
:root[data-theme=light]{color-scheme:light;--vscode-editor-background:#fff;--vscode-editor-foreground:#333;--vscode-descriptionForeground:#595959;--vscode-panel-border:#909090;--vscode-input-background:#fff;--vscode-input-foreground:#333;--vscode-input-border:#707070;--vscode-focusBorder:#0066b8;--vscode-button-background:#0066b8;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#eee;--vscode-button-secondaryForeground:#333;--vscode-textLink-foreground:#005a9e;--vscode-errorForeground:#a1260d;--vscode-disabledForeground:#666}
:root[data-theme=contrast]{color-scheme:dark;--vscode-editor-background:#000;--vscode-editor-foreground:#fff;--vscode-descriptionForeground:#fff;--vscode-panel-border:#fff;--vscode-input-background:#000;--vscode-input-foreground:#fff;--vscode-input-border:#fff;--vscode-focusBorder:#ff0;--vscode-button-background:#000;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#000;--vscode-button-secondaryForeground:#fff;--vscode-textLink-foreground:#ff0;--vscode-errorForeground:#fff;--vscode-disabledForeground:#fff}`;
const server = createServer(async (request, response) => {
  try {
    if (request.url === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><html lang="en" data-theme="dark"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\'; style-src-attr \'unsafe-inline\';"><link rel="stylesheet" href="/wiring.css"><link rel="stylesheet" href="/theme.css"><title>Intended wiring synthetic fixture</title></head><body><div id="root"></div><script src="/wiring.js"></script></body></html>'); return; }
    if (request.url === '/theme.css') { response.writeHead(200, { 'Content-Type': 'text/css' }).end(theme); return; }
    const name = request.url === '/wiring.js' ? 'wiring.js' : request.url === '/wiring.css' ? 'wiring.css' : null;
    if (!name) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': name.endsWith('.js') ? 'text/javascript' : 'text/css' }).end(await readFile(join(root, name)));
  } catch { response.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const record = { taskId: 'TASK-07', evidenceClass: 'synthetic-browser-ui', command: 'node scripts/ui/wiring-qa.mjs', startedAt: new Date().toISOString(), referenceLock: 'D41 host-native VSCode; R04 aligned component rows, R05 pan/zoom/selection only. Lines represent intended unordered nets, not workflow execution or physical continuity.', checks: ['tested JavaScript and CSS byte-identical to packaged production dist'], screenshots: [], limitations: ['Synthetic part definitions, manifest, rule results and observations. No physical device, native source mutation, live provider, or Windows screen reader is exercised.'] };
let browser, page;
try {
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true }); record.browser = await browser.version();
  const context = await browser.newContext({ viewport: { width: 1000, height: 768 }, reducedMotion: 'reduce' });
  await context.addInitScript(fixture => {
    window.__state = JSON.parse(sessionStorage.getItem('wiring-backend') ?? 'null') ?? fixture; window.__requests = []; window.__acquisitions = 0; window.__operations = [];
    window.__push = state => { window.__state = structuredClone(state); sessionStorage.setItem('wiring-backend', JSON.stringify(state)); window.postMessage({ schemaVersion: 1, type: 'state', state }, '*'); };
    window.acquireVsCodeApi = () => { window.__acquisitions++; return {
      getState: () => JSON.parse(sessionStorage.getItem('wiring-ui') ?? 'null'), setState: value => sessionStorage.setItem('wiring-ui', JSON.stringify(value)),
      postMessage: message => {
        window.__requests.push(message); const state = structuredClone(window.__state);
        if (message.type === 'ready' || message.type === 'refresh') setTimeout(() => window.__push(state), 0);
        if (message.type === 'select') { state.selection = message.payload; window.__push(state); }
        if (message.type === 'propose') { window.__operations = structuredClone(message.payload.operations); state.preview = { previewId: crypto.randomUUID(), changes: window.__operations.map(operation => `Synthetic preview: ${operation.type}`), rules: state.rules, confirmationInvalidated: true }; window.__push(state); }
        if (message.type === 'discard') { state.preview = null; window.__push(state); }
        if (message.type === 'commit') {
          for (const operation of window.__operations) {
            if (operation.type === 'component.add') { state.manifest.components.push(operation.component); state.pins[operation.component.componentId] = (operation.component.provisionalPins ?? []).map(pin => ({ ...pin, aliases: [], modes: [], electricalType: 'unknown' })); }
            if (operation.type === 'component.rename') state.manifest.components.find(component => component.componentId === operation.componentId).label = operation.label;
            if (operation.type === 'net.set') { state.manifest.nets = state.manifest.nets.filter(net => net.netId !== operation.net.netId); state.manifest.nets.push(operation.net); }
            if (operation.type === 'net.remove') state.manifest.nets = state.manifest.nets.filter(net => net.netId !== operation.netId);
            if (operation.type === 'binding.set') state.manifest.codeBindings.push(operation.binding);
          }
          state.project.projectRevision++; state.manifest.projectRevision = state.project.projectRevision; state.project.manifestSha256 = 'c'.repeat(64); state.preview = null; state.rules.forEach(rule => { rule.projectRevision = state.project.projectRevision; }); state.confirmations.forEach(observation => { observation.applicability = 'stale'; }); window.__push(state);
        }
        if (message.type === 'layout') { state.layout = { revision: state.layout.revision + 1, sha256: 'd'.repeat(64), positions: message.payload.positions }; window.__push(state); }
      }
    }; };
  }, wiringViewFixture());
  page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.getByRole('heading', { name: 'Intended wiring', exact: true }).waitFor(); await page.getByText('Distance sensor fixture · revision 4', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__acquisitions), 1); record.checks.push('single API acquisition and bounded authoritative initial state');
  const initial = await page.evaluate(() => structuredClone(window.__state));
  await page.evaluate(() => { const state = structuredClone(window.__state); state.manifest.components[0].label = '<img src=x onerror="window.bad=1">'; window.__push(state); });
  await page.getByRole('button', { name: '<img src=x onerror="window.bad=1">', exact: true }).waitFor(); assert.equal(await page.locator('img[src=x]').count(), 0); assert.equal(await page.evaluate(() => window.bad), undefined);
  await page.evaluate(state => window.__push(state), initial); await page.evaluate(() => window.postMessage({ schemaVersion: 1, type: 'state', state: { schemaVersion: 99 } }, '*'));
  assert.equal(await page.getByRole('heading', { name: 'Intended wiring', exact: true }).count(), 1); record.checks.push('inert malicious labels and malformed incoming state rejection');
  await page.getByRole('button', { name: 'Front range module', exact: true }).click(); await page.getByText('Explicit source bindings', { exact: true }).click();
  await page.getByRole('button', { name: /DistanceProbe\.ino:7/ }).click(); assert.equal(await page.evaluate(() => window.__requests.at(-1).payload.bindingId), ids.binding);
  await page.getByRole('button', { name: 'Ask about selection', exact: true }).click(); assert.equal(await page.evaluate(() => window.__requests.at(-1).type), 'ask'); record.checks.push('table selection and explicit code/agent intents use stable IDs without submission');
  const filter = page.getByLabel('Filter components', { exact: true });
  await filter.fill('no such part');
  await page.getByRole('status').getByText('No components match this filter.').waitFor();
  await page.getByText('The selected component is hidden by the current filter.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Front range module', exact: true }).count(), 1);
  assert.equal(await page.getByRole('region', { name: 'Component rows' }).count(), 0);
  await filter.fill('  FRONT RANGE  ');
  assert.equal(await page.getByRole('region', { name: 'Component rows' }).locator('tbody tr[aria-selected=true]').count(), 1);
  await filter.fill('');
  record.checks.push('empty filter result explains hidden selection and clearing the filter preserves stable row identity');
  await page.setViewportSize({ width: 320, height: 768 });
  await filter.focus(); await page.keyboard.press('Tab');
  const componentRows = page.getByRole('region', { name: 'Component rows' });
  assert.equal(await componentRows.evaluate(region => document.activeElement === region && getComputedStyle(region).outlineStyle === 'solid'), true);
  const rowHeader = componentRows.getByRole('rowheader').first();
  const left = await rowHeader.evaluate(header => header.getBoundingClientRect().left);
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.activeElement?.scrollLeft > 0);
  assert.ok(Math.abs(await rowHeader.evaluate(header => header.getBoundingClientRect().left) - left) < 2);
  await page.setViewportSize({ width: 300, height: 768 });
  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  await page.getByRole('button', { name: 'Open connection table', exact: true }).press('Enter');
  await page.getByRole('region', { name: 'Connection rows' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Connections (1)', exact: true }).evaluate(button => document.activeElement === button), true);
  await page.setViewportSize({ width: 1000, height: 768 });
  await page.getByRole('button', { name: 'Components (3)', exact: true }).click();
  record.checks.push('keyboard scrolls narrow component rows with stable identity and opens the connection table when the canvas cannot fit');
  const discard = async () => { await page.getByRole('heading', { name: 'Review intended design changes', exact: true }).waitFor(); await page.getByRole('button', { name: 'Discard preview', exact: true }).click(); await page.getByRole('heading', { name: 'Review intended design changes', exact: true }).waitFor({ state: 'hidden' }); };
  const intentBaseline = await page.evaluate(() => JSON.stringify(window.__state.manifest));
  await page.getByLabel('Component name', { exact: true }).fill('Draft rename'); await page.getByRole('button', { name: 'Preview rename', exact: true }).click(); assert.equal(await page.evaluate(() => window.__operations[0].type), 'component.rename'); await discard();
  await page.getByRole('button', { name: 'Preview component removal', exact: true }).click(); assert.equal(await page.evaluate(() => window.__operations[0].removeBindings), true); await discard();
  await page.getByText('Reference definition and pin migration', { exact: true }).click(); await page.getByLabel('New reference definition', { exact: true }).selectOption('fixture:board@1'); await page.getByLabel('Explicit pin migration', { exact: true }).fill('trig=trig'); await page.getByRole('button', { name: 'Preview definition migration', exact: true }).click(); assert.equal(await page.evaluate(() => window.__operations[0].pinMapping.trig), 'trig'); await discard();
  await page.getByLabel('Source path', { exact: true }).fill('DistanceProbe.ino'); await page.getByLabel('Binding pin', { exact: true }).selectOption('echo'); await page.getByLabel('Symbol or expression', { exact: true }).fill('ECHO_PIN'); await page.getByLabel('Source line', { exact: true }).fill('9'); await page.getByRole('button', { name: 'Preview source binding', exact: true }).click(); assert.equal(await page.evaluate(() => window.__operations[0].binding.pinId), 'echo'); await discard();
  await page.getByRole('button', { name: 'Reference controller', exact: true }).click(); await page.getByText('Logical pins and selected modes', { exact: true }).click(); await page.getByLabel('Mode for D8', { exact: true }).selectOption('input'); assert.equal(await page.evaluate(() => window.__operations[0].type), 'pin.mode'); await discard();
  assert.equal(await page.evaluate(() => JSON.stringify(window.__state.manifest)), intentBaseline); record.checks.push('rename, removal, definition pin migration, explicit binding and pin-mode previews discard without mutation');
  const single = wiringViewFixture();
  single.manifest.components = single.manifest.components.filter(component => component.componentId === ids.board);
  single.manifest.nets = []; single.manifest.codeBindings = []; single.manifest.documents = [];
  single.rules = []; single.confirmations = []; single.selection = null;
  await page.evaluate(state => window.__push(state), single);
  await page.getByRole('button', { name: 'Components (1)', exact: true }).waitFor();
  const connectEndpoints = page.getByRole('button', { name: 'Connect endpoints', exact: true });
  await connectEndpoints.click();
  await page.getByLabel('First component', { exact: true }).selectOption(ids.board);
  await page.getByLabel('First logical pin', { exact: true }).selectOption('trig');
  await page.getByLabel('Second component', { exact: true }).selectOption(ids.board);
  await page.getByLabel('Second logical pin', { exact: true }).selectOption('sda');
  await page.getByRole('button', { name: 'Preview connection', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.__operations[0].net.members), [{ componentId: ids.board, pinId: 'trig' }, { componentId: ids.board, pinId: 'sda' }]);
  await discard();
  await connectEndpoints.click();
  single.pins[ids.board].pop();
  await page.evaluate(state => window.__push(state), single);
  await page.getByText('Connections require at least two logical pins.', { exact: true }).waitFor();
  assert.equal(await connectEndpoints.isDisabled(), true);
  await page.evaluate(state => window.__push(state), initial);
  await page.getByRole('button', { name: 'Components (3)', exact: true }).click();
  record.checks.push('single-part two-pin connection reaches canonical review and one-pin designs explain the disabled action');
  await page.evaluate(() => { const state = structuredClone(window.__state); state.trusted = false; window.__push(state); }); assert.equal(await page.getByRole('button', { name: 'Add component', exact: true }).isDisabled(), true); await page.getByText(/Restricted Mode:/).waitFor();
  await page.evaluate(() => { const state = structuredClone(window.__state); state.trusted = true; window.__push(state); }); record.checks.push('restricted workspace disables design mutations and labels trust state');
  await page.getByRole('button', { name: 'Add component', exact: true }).click(); await page.getByLabel('Component label', { exact: true }).fill('Extra unconfirmed module'); await page.getByLabel('Provisional pin IDs, comma separated', { exact: true }).fill('signal, ground');
  const beforeCount = await page.evaluate(() => window.__state.manifest.components.length), beforeProposes = await page.evaluate(() => window.__requests.filter(request => request.type === 'propose').length);
  await page.getByRole('button', { name: 'Preview component', exact: true }).evaluate(button => { button.click(); button.click(); }); await page.getByRole('heading', { name: 'Review intended design changes', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__state.manifest.components.length), beforeCount); assert.equal(await page.evaluate(() => window.__requests.filter(request => request.type === 'propose').length), beforeProposes + 1);
  assert.equal(await page.evaluate(() => window.__operations[0].component.definition), null); await page.getByRole('button', { name: 'Commit design', exact: true }).click(); await page.getByRole('button', { name: 'Extra unconfirmed module', exact: true }).waitFor(); record.checks.push('unresolved component preview is non-mutating and immediate duplicate clicks admit once');
  await page.getByRole('button', { name: 'Connect endpoints', exact: true }).click(); await page.getByLabel('First component', { exact: true }).selectOption(ids.board); await page.getByLabel('First logical pin', { exact: true }).selectOption('trig'); await page.getByLabel('Second component', { exact: true }).selectOption(ids.sensor); await page.getByLabel('Second logical pin', { exact: true }).selectOption('trig'); await page.getByLabel('New net label', { exact: true }).fill('Trigger fixture');
  await page.getByRole('button', { name: 'Preview connection', exact: true }).click(); await page.getByRole('heading', { name: 'Review intended design changes', exact: true }).waitFor(); assert.equal(await page.evaluate(() => window.__operations[0].net.members.length), 2);
  await page.getByRole('button', { name: 'Commit design', exact: true }).click(); await page.getByRole('button', { name: 'Trigger fixture', exact: true }).waitFor(); record.checks.push('keyboard connection form proposes explicit endpoint membership before commit');
  for (const name of ['Add component', 'Connect endpoints']) { const button = page.getByRole('button', { name, exact: true }); if (await button.getAttribute('aria-expanded') === 'true') await button.click(); }
  await page.getByRole('button', { name: 'Canvas', exact: true }).click(); await page.locator('.react-flow__node').nth(3).waitFor();
  assert.equal(await page.locator('.react-flow__edge').count(), 3); await page.locator(`.react-flow__node[data-id="${ids.board}"] strong`).click();
  assert.equal(await page.evaluate(() => window.__state.selection.id), ids.board);
  await page.locator(`.react-flow__node[data-id="${ids.board}"] .react-flow__handle[data-handleid="trig"]`).click(); await page.locator(`.react-flow__node[data-id="${ids.sensor}"] .react-flow__handle[data-handleid="echo"]`).click();
  await page.getByRole('heading', { name: 'Review intended design changes', exact: true }).waitFor(); assert.equal(await page.evaluate(() => window.__operations[0].net.members.length), 3); await discard(); record.checks.push('canvas handle gesture extends the same canonical net membership preview as the table');
  await page.locator(`.react-flow__node[data-id="${ids.board}"] strong`).click(); await page.waitForFunction(id => window.__state.selection.id === id, ids.board);
  const zoom = page.getByRole('button', { name: /zoom in/i }); const priorZoom = await page.evaluate(() => JSON.parse(sessionStorage.getItem('wiring-ui')).viewport?.zoom ?? 0); await zoom.click();
  await page.waitForFunction(previous => JSON.parse(sessionStorage.getItem('wiring-ui')).viewport?.zoom > previous, priorZoom); const transform = await page.locator('.react-flow__viewport').getAttribute('style');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; window.__push(window.__state); });
  assert.equal(await page.locator('.react-flow__viewport').getAttribute('style'), transform);
  await page.reload(); await page.locator('.react-flow__node').nth(3).waitFor(); assert.equal(await page.locator('.react-flow__viewport').getAttribute('style'), transform); record.checks.push('graph selection and pan/zoom survive theme/state refresh and view reload');
  const intentBefore = await page.evaluate(() => ({ revision: window.__state.project.projectRevision, nets: JSON.stringify(window.__state.manifest.nets) }));
  const node = page.locator(`.react-flow__node[data-id="${ids.board}"] strong`); await node.scrollIntoViewIfNeeded(); const box = await node.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 25, { steps: 8 }); await page.mouse.up();
  await page.waitForFunction(() => window.__requests.some(request => request.type === 'layout'));
  assert.deepEqual(await page.evaluate(() => ({ revision: window.__state.project.projectRevision, nets: JSON.stringify(window.__state.manifest.nets) })), intentBefore);
  await page.getByText('Keyboard layout position', { exact: true }).click(); await page.getByLabel('Layout X', { exact: true }).fill('120'); await page.getByLabel('Layout Y', { exact: true }).fill('40'); await page.getByRole('button', { name: 'Save layout only', exact: true }).click();
  await page.waitForFunction(id => window.__state.layout.positions[id].x === 120, ids.board); assert.deepEqual(await page.evaluate(() => ({ revision: window.__state.project.projectRevision, nets: JSON.stringify(window.__state.manifest.nets) })), intentBefore); record.checks.push('pointer and keyboard layout saves do not change design revision or nets');
  await page.evaluate(() => { const state = structuredClone(window.__state); state.preview = { previewId: crypto.randomUUID(), changes: ['Synthetic known conflict'], rules: [{ ruleId: 'direction', ruleVersion: '1', severity: 'error', outcome: 'fail', affectedIds: [], projectRevision: state.project.projectRevision, sourceFacts: [], explanation: 'Known incompatible driven outputs.' }], confirmationInvalidated: true }; window.__push(state); });
  assert.equal(await page.getByRole('button', { name: 'Commit design', exact: true }).isDisabled(), true); await page.getByRole('button', { name: 'Discard preview', exact: true }).click(); record.checks.push('known electrical errors block commit while unknown facts remain not-checked');
  await page.setViewportSize({ width: 1000, height: 768 }); await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; }); await page.screenshot({ path: join(evidence, 'canvas-dark.png'), fullPage: true }); record.screenshots.push('canvas-dark.png');
  for (const configuration of [{ theme: 'dark', width: 1000, height: 768, font: 13 }, { theme: 'light', width: 1000, height: 768, font: 13 }, { theme: 'contrast', width: 1000, height: 768, font: 13 }, { theme: 'dark', width: 320, height: 768, font: 13 }, { theme: 'light', width: 683, height: 384, font: 26 }]) {
    await page.getByRole('button', { name: /^Components \(/ }).click(); await page.setViewportSize({ width: configuration.width, height: configuration.height }); await page.evaluate(configuration => { document.documentElement.dataset.theme = configuration.theme; document.documentElement.style.setProperty('--vscode-font-size', `${configuration.font}px`); }, configuration);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)); assert.ok(await page.getByRole('button', { name: 'Connect endpoints', exact: true }).isVisible());
    const name = `${configuration.theme}-${configuration.width}${configuration.font === 26 ? '-font200' : ''}.png`; await page.screenshot({ path: join(evidence, name), fullPage: true }); record.screenshots.push(name); record.checks.push(`${configuration.theme}/${configuration.width}/font${configuration.font}: reflow with table-contained horizontal scroll`);
    if (configuration.width === 1000) for (const [screen, label] of [['S04-components', /^Components \(/], ['S05-table', /^Connections \(/], ['S05-canvas', /^Canvas$/]]) { await page.getByRole('button', { name: label }).click(); (record.contrast ??= []).push(await auditContrast(page, configuration.theme, screen)); }
  }
  await page.getByRole('button', { name: 'Add component', exact: true }).focus(); await page.keyboard.press('Tab'); assert.ok(await page.evaluate(() => ['BUTTON', 'INPUT', 'SELECT', 'SUMMARY'].includes(document.activeElement.tagName))); assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true); record.checks.push('keyboard focus traversal and reduced-motion preference');
  const requests = await page.evaluate(() => window.__requests); assert.ok(requests.every(request => isWiringViewRequest(request))); assert.ok(!requests.some(request => /upload|compile|send/.test(request.type))); assert.deepEqual(errors, []);
  await page.setViewportSize({ width: 1366, height: 768 }); await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.style.setProperty('--vscode-font-size', '13px'); });
  const large = wiringViewFixture();
  while (large.manifest.components.length < 100) { const component = { ...structuredClone(large.manifest.components[0]), componentId: randomUUID(), label: `Synthetic part ${large.manifest.components.length}` }; large.manifest.components.push(component); large.pins[component.componentId] = structuredClone(large.pins[large.manifest.components[0].componentId]); }
  assert.ok(isWiringViewState(large)); await page.evaluate(state => window.__push(state), large); await page.getByRole('button', { name: 'Components (100)', exact: true }).click(); await page.getByLabel('Filter components', { exact: true }).fill('');
  const timing = [];
  for (const component of large.manifest.components.slice(3, 33)) timing.push(await page.evaluate(async ({ id, label, revision }) => {
    const button = [...document.querySelectorAll('tbody button')].find(item => item.textContent === label), start = performance.now(); button.click();
    while (button.closest('tr').getAttribute('aria-selected') !== 'true') { if (performance.now() - start > 2000) throw Error('Selection feedback did not render'); await new Promise(requestAnimationFrame); }
    const feedbackMs = performance.now() - start;
    while (document.querySelector('.wiring-inspector h2')?.textContent !== label || !document.querySelector('.wiring-inspector').textContent.includes(id) || !document.querySelector('.project-header').textContent.includes(`revision ${revision}`)) { if (performance.now() - start > 2000) throw Error('Revision-bound selection did not render'); await new Promise(requestAnimationFrame); }
    await new Promise(requestAnimationFrame); return { feedbackMs, selectionMs: performance.now() - start };
  }, { id: component.componentId, label: component.label, revision: large.project.projectRevision }));
  const p95 = key => timing.map(item => item[key]).sort((a, b) => a - b)[Math.ceil(timing.length * .95) - 1];
  record.renderTiming = { workload: '100-component design; 30 warm row selections', sampling: 'Browser performance.now before local click until selected row/expected-ID inspector and matching revision render, then a rendering frame', samples: timing, p95FeedbackMs: p95('feedbackMs'), p95SelectionMs: p95('selectionMs'), budgets: { feedbackMs: 150, selectionMs: 250 }, limitation: 'Synthetic in-browser host responses; native IPC and actual provider latency separate.' };
  assert.ok(record.renderTiming.p95FeedbackMs <= 150); assert.ok(record.renderTiming.p95SelectionMs <= 250);
  for (const scenario of ['ready', 'loading', 'empty', 'unavailable', 'error', 'stale']) {
    const value = wiringViewFixture();
    if (scenario === 'loading') value.loading = true;
    if (scenario === 'empty') { value.manifest.components = []; value.manifest.nets = []; value.manifest.codeBindings = []; value.selection = null; value.rules = []; value.confirmations = []; }
    if (scenario === 'unavailable') value.trusted = false;
    if (scenario === 'error') value.error = 'Synthetic saved-manifest error; independent source remains preserved.';
    if (scenario === 'stale') value.confirmations.forEach(item => { item.applicability = 'stale'; });
    assert.ok(isWiringViewState(value)); await page.evaluate(state => window.__push(state), value);
    for (const [screen, label] of [['S04', /^Components \(/], ['S05-table', /^Connections \(/], ['S05-canvas', /^Canvas$/]]) {
      await page.getByRole('button', { name: label }).click();
      if (scenario === 'loading') await page.getByText('Refreshing or validating intent…', { exact: true }).waitFor();
      if (scenario === 'error') await page.getByRole('alert').waitFor();
      if (scenario === 'unavailable') await page.getByText(/Restricted Mode:/).waitFor();
      if (scenario === 'error') for (const theme of ['dark', 'light', 'contrast']) { await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme); (record.contrast ??= []).push(await auditContrast(page, theme, `${screen}-error`)); }
      await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
      const name = `${screen}-${scenario}.png`; await page.screenshot({ path: join(evidence, name), fullPage: true }); record.screenshots.push(name);
    }
  }
  record.checks.push('S04/S05 validated ready/loading/empty/unavailable/error/stale screenshots and 100-component rendered selection timing');
  record.status = 'passed'; record.endedAt = new Date().toISOString(); record.bundleSha256 = createHash('sha256').update(await readFile(join(root, 'wiring.js'))).digest('hex'); record.stylesheetSha256 = createHash('sha256').update(await readFile(join(root, 'wiring.css'))).digest('hex');
  await writeFile(join(evidence, 'result.json'), JSON.stringify(record, null, 2) + '\n'); console.log(JSON.stringify({ status: record.status, checks: record.checks.length, screenshots: record.screenshots }));
} catch (error) { record.status = 'failed'; record.error = String(error?.stack ?? error); await page?.screenshot({ path: join(evidence, 'failure.png'), fullPage: true }).catch(() => {}); await writeFile(join(evidence, 'result.json'), JSON.stringify(record, null, 2) + '\n'); console.error(JSON.stringify(record)); process.exitCode = 1; }
finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
