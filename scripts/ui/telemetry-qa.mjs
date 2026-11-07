import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { platform, release } from 'node:os';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { auditContrast } from './contrast.mjs';

const root = resolve(process.env.WORKBENCH_UI_ARTIFACT_ROOT || 'artifacts/task09-ui'), evidence = resolve(process.env.WORKBENCH_UI_EVIDENCE_ROOT || 'verification/evidence/task-09/ui');
await mkdir(root, { recursive: true }); await mkdir(evidence, { recursive: true }); await mkdir(resolve('artifacts/tmp'), { recursive: true }); process.env.TEMP = process.env.TMP = resolve('artifacts/tmp');
await build({ entryPoints: ['packages/webviews/src/telemetry.tsx'], bundle: true, platform: 'browser', format: 'iife', target: 'es2022', minify: true, define: { 'process.env.NODE_ENV': '"production"' }, outfile: join(root, 'telemetry.js') });
for (const name of ['telemetry.js', 'telemetry.css']) assert.deepEqual(await readFile(join(root, name)), await readFile(resolve('apps/extension/dist', name)), `QA ${name} must match packaged production bytes; run npm run build first`);
await build({ entryPoints: ['packages/test-fixtures/ui/telemetry-state.ts', 'packages/webviews/src/telemetry-protocol.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node24', outdir: root, outExtension: { '.js': '.cjs' } });
const require = createRequire(import.meta.url), { telemetryViewFixture, telemetryFixtureIds: ids } = require(join(root, 'test-fixtures/ui/telemetry-state.cjs')), { isTelemetryViewRequest, isTelemetryViewState } = require(join(root, 'webviews/src/telemetry-protocol.cjs'));
const fixture = telemetryViewFixture(); assert.ok(isTelemetryViewState(fixture));
const theme = `:root{--vscode-font-family:system-ui;--vscode-font-size:13px;--vscode-editor-font-family:Consolas,monospace}
:root[data-theme=dark]{color-scheme:dark;--vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#d4d4d4;--vscode-descriptionForeground:#b0b0b0;--vscode-panel-border:#666;--vscode-input-background:#313131;--vscode-input-foreground:#fff;--vscode-input-border:#888;--vscode-focusBorder:#007fd4;--vscode-button-background:#0e639c;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#383838;--vscode-button-secondaryForeground:#fff;--vscode-textLink-foreground:#64b5f6;--vscode-errorForeground:#ff9999;--vscode-disabledForeground:#aaa}
:root[data-theme=light]{color-scheme:light;--vscode-editor-background:#fff;--vscode-editor-foreground:#333;--vscode-descriptionForeground:#595959;--vscode-panel-border:#909090;--vscode-input-background:#fff;--vscode-input-foreground:#333;--vscode-input-border:#707070;--vscode-focusBorder:#0066b8;--vscode-button-background:#0066b8;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#eee;--vscode-button-secondaryForeground:#333;--vscode-textLink-foreground:#005a9e;--vscode-errorForeground:#a1260d;--vscode-disabledForeground:#666}
:root[data-theme=contrast]{color-scheme:dark;--vscode-editor-background:#000;--vscode-editor-foreground:#fff;--vscode-descriptionForeground:#fff;--vscode-panel-border:#fff;--vscode-input-background:#000;--vscode-input-foreground:#fff;--vscode-input-border:#fff;--vscode-focusBorder:#ff0;--vscode-button-background:#000;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#000;--vscode-button-secondaryForeground:#fff;--vscode-textLink-foreground:#ff0;--vscode-errorForeground:#fff;--vscode-disabledForeground:#fff}`;
const server = createServer(async (request, response) => {
  try {
    if (request.url === '/') return response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><html lang="en" data-theme="dark"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'none\';"><link rel="stylesheet" href="/telemetry.css"><link rel="stylesheet" href="/theme.css"><title>Synthetic telemetry UI fixture</title></head><body><div id="root"></div><script src="/telemetry.js"></script></body></html>');
    if (request.url === '/theme.css') return response.writeHead(200, { 'Content-Type': 'text/css' }).end(theme);
    const name = request.url === '/telemetry.js' ? 'telemetry.js' : request.url === '/telemetry.css' ? 'telemetry.css' : null;
    if (!name) return response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': name.endsWith('.js') ? 'text/javascript' : 'text/css' }).end(await readFile(join(root, name)));
  } catch { response.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${server.address().port}`, record = { schemaVersion: 1, runId: randomUUID(), testId: 'task09.telemetry-browser', appVersion: '0.1.0', os: `${platform()} ${release()}`, runtime: process.version, uplotVersion: '1.6.32', fixture: 'S08-S09-synthetic-no-hardware', limitations: ['Synthetic browser state; no physical device, Windows screen reader, or actual VS Code webview integration proved. Font scaling plus 683px viewport approximates 200% zoom.'], startedAt: new Date().toISOString(), checks: [], screenshots: [], status: 'running' };
let browser, page; const errors = [], network = [];
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  page = await browser.newPage({ viewport: { width: 1366, height: 768 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(String(error))); page.on('request', request => { if (!request.url().startsWith(address)) network.push(request.url()); });
  await page.addInitScript(value => { window.__state = value; window.__requests = []; window.__saved = undefined; window.acquireVsCodeApi = () => ({ getState: () => window.__saved, setState: v => { window.__saved = v; }, postMessage: request => { window.__requests.push(request); setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: { schemaVersion: 1, type: 'state', state: structuredClone(window.__state) } })), 0); } }); }, fixture);
  await page.goto(address); await page.getByRole('heading', { name: 'Channels · host-receive elapsed milliseconds' }).waitFor(); assert.equal(await page.locator('canvas').count(), 1);
  await page.getByText('Exact displayed samples (5 of 5)', { exact: true }).click(); await page.getByRole('cell', { name: '198', exact: true }).waitFor();
  await page.getByLabel('Start (ms)', { exact: true }).fill('100'); await page.getByLabel('End (ms)', { exact: true }).fill('300'); await page.getByRole('button', { name: 'Freeze interval', exact: true }).click();
  await page.evaluate(() => { window.__state.window.end = 9999; window.__state.window.derivationId = '33333333-3333-8333-8333-333333333334'; window.__state.project.projectRevision = 14; window.dispatchEvent(new MessageEvent('message', { data: { schemaVersion: 1, type: 'state', state: structuredClone(window.__state) } })); });
  await page.getByRole('button', { name: 'Ask about interval', exact: true }).click();
  const ask = await page.evaluate(() => window.__requests.findLast(r => r.type === 'ask')); assert.equal(ask.payload.selection.start, 100); assert.equal(ask.payload.selection.end, 300); assert.equal(ask.payload.selection.derivationId, ids.derivation); assert.equal(ask.payload.selection.projectRevision, 12); assert.deepEqual(ask.payload.selection.channelIds, ['range']);
  record.checks.push('Frozen interval retains exact recording/channel/derivation/parser/time/revision after later data and source revisions; Ask prepares context only');
  await page.getByRole('button', { name: 'Export underlying interval', exact: true }).click();
  await page.getByRole('button', { name: 'Runs & comparison', exact: true }).click(); await page.getByText('Incompatible evidence — formal improvement conclusion blocked.', { exact: true }).waitFor();
  const seriesLabels = await page.locator('.telemetry-legend li').allTextContents();
  assert.equal(seriesLabels.filter(label => label.includes('· range · mm ·')).length, 2); assert.equal(seriesLabels.filter(label => label.includes('· power · mW ·')).length, 2);
  assert.equal(new Set(seriesLabels.map(label => label.split('·').at(-1).trim())).size, 4, 'Every run/channel pair must retain a distinct line pattern in this four-series comparison.');
  assert.match(await page.getByRole('img').getAttribute('aria-label'), /range, mm.*power, mW/);
  record.checks.push('Multichannel comparison uses each channel statistic unit (range mm, power mW), separate axes and distinct stable run/channel patterns; accessible chart labels expose channel identities');
  const plotSeries = page.getByLabel('Plot series', { exact: true });
  await plotSeries.focus(); await plotSeries.press('End');
  assert.deepEqual(await page.locator('.telemetry-legend li').allTextContents(), [seriesLabels[3]]);
  assert.equal(await plotSeries.evaluate(el => document.activeElement === el), true);
  await plotSeries.press('Home');
  assert.deepEqual(await page.locator('.telemetry-legend li').allTextContents(), seriesLabels);

  const sameProcedure = structuredClone(fixture);
  for (const run of sameProcedure.runs) { run.title = 'Same procedure'; run.procedureVersion = 1; }
  for (const series of sameProcedure.comparison.series) series.label = 'Same procedure';
  assert.ok(isTelemetryViewState(sameProcedure));
  await page.evaluate(({ runs, comparison }) => { Object.assign(window.__state, { runs, comparison }); window.dispatchEvent(new MessageEvent('message', { data: { schemaVersion: 1, type: 'state', state: structuredClone(window.__state) } })); }, sameProcedure);
  for (const id of [ids.run, ids.secondRun]) {
    const label = `Same procedure · ${id.slice(-8)}`;
    await page.getByRole('checkbox', { name: label, exact: true }).waitFor();
    assert.equal(await plotSeries.getByRole('option', { name: `${label} · range · mm · host-receive`, exact: true }).count(), 1);
    assert.equal(await page.getByRole('columnheader', { name: label, exact: true }).count(), 1);
    assert.equal(await page.getByRole('heading', { name: label, exact: true }).count(), 1);
  }
  await plotSeries.press('End');
  assert.match(await page.locator('.telemetry-legend').textContent(), /Same procedure · aaaaaaab · power/);
  await plotSeries.press('Home');
  record.checks.push('Runs from the same procedure remain distinguishable by stable short IDs in the picker, plot, and tables');

  const mixedClocks = structuredClone(fixture.comparison);
  const deviceWindow = mixedClocks.series[1].window;
  deviceWindow.timeBasis = 'device'; deviceWindow.deviceEpoch = 1;
  deviceWindow.samples = deviceWindow.samples.map(sample => ({ ...sample, deviceTimeMs: sample.hostReceiveMs, deviceEpoch: 1 }));
  assert.ok(isTelemetryViewState({ ...fixture, comparison: mixedClocks }));
  await page.evaluate(comparison => { window.__state.comparison = comparison; window.dispatchEvent(new MessageEvent('message', { data: { schemaVersion: 1, type: 'state', state: structuredClone(window.__state) } })); }, mixedClocks);
  await page.getByText('Device-clock series require explicit alignment before overlay.', { exact: false }).waitFor();
  assert.equal(await page.locator('canvas').count(), 0);
  assert.equal(await page.getByText('Exact displayed samples (10 of 10)', { exact: true }).count(), 2);
  await plotSeries.focus(); await plotSeries.press('End');
  await page.locator('canvas').waitFor(); assert.match(await page.locator('.telemetry-legend').textContent(), /power · mW · device/);
  await plotSeries.press('Home');
  await page.evaluate(({ runs, comparison }) => { Object.assign(window.__state, { runs, comparison }); window.dispatchEvent(new MessageEvent('message', { data: { schemaVersion: 1, type: 'state', state: structuredClone(window.__state) } })); }, fixture);
  await page.getByText('Device-clock series require explicit alignment before overlay.', { exact: false }).waitFor({ state: 'hidden' });
  record.checks.push('Keyboard series isolation preserves focus and stable style; mixed clocks leave exact tables readable and require selecting one series before plotting');
  assert.equal(await page.locator('canvas').count(), 1); await page.getByLabel('Range baseline (synthetic)', { exact: true }).check(); await page.getByLabel('Candidate (synthetic)', { exact: true }).check(); await page.getByRole('button', { name: 'Compare selected runs', exact: true }).click();
  assert.ok(await page.getByRole('region', { name: 'Run parameter differences' }).isVisible()); record.checks.push('S09 selected runs, exploratory overlay, explicit procedure/firmware/parser/time/unit differences and blocked unsupported improvement');
  for (const configuration of [{ theme: 'dark', width: 1366, font: 13 }, { theme: 'light', width: 1366, font: 13 }, { theme: 'contrast', width: 1366, font: 13 }, { theme: 'dark', width: 320, font: 13 }, { theme: 'light', width: 683, font: 26 }]) {
    await page.setViewportSize({ width: configuration.width, height: 768 }); await page.evaluate(c => { document.documentElement.dataset.theme = c.theme; document.documentElement.style.setProperty('--vscode-font-size', `${c.font}px`); }, configuration);
    await page.getByRole('button', { name: 'Refresh evidence' }).scrollIntoViewIfNeeded(); await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `overflow ${JSON.stringify(configuration)}`);
    const name = `S09-${configuration.theme}-${configuration.width}-${configuration.font}.png`; await page.screenshot({ path: join(evidence, name), fullPage: true }); record.screenshots.push(name);
    if (configuration.width === 1366) (record.contrast ??= []).push(await auditContrast(page, configuration.theme, 'S09-comparison'));
    await page.getByRole('button', { name: 'Recording detail', exact: true }).click(); await page.getByRole('button', { name: 'Freeze interval', exact: true }).scrollIntoViewIfNeeded(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false);
    const detailName = `S08-${configuration.theme}-${configuration.width}-${configuration.font}.png`; await page.screenshot({ path: join(evidence, detailName), fullPage: true }); record.screenshots.push(detailName);
    if (configuration.width === 1366) (record.contrast ??= []).push(await auditContrast(page, configuration.theme, 'S08-recording'));
    await page.getByRole('button', { name: 'Runs & comparison', exact: true }).click();
    record.checks.push(`${configuration.theme}/${configuration.width}/font${configuration.font}: S08/S09 no page overflow; actions reachable`);
  }
  await page.setViewportSize({ width: 1366, height: 768 }); await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.style.setProperty('--vscode-font-size', '13px'); });
  await page.getByRole('button', { name: 'Recording detail', exact: true }).click();
  await page.evaluate(() => { window.__state.revealedSelection = { ...window.__saved.frozen, start: 0, end: 100 }; window.dispatchEvent(new MessageEvent('message', { data: { schemaVersion: 1, type: 'state', state: structuredClone(window.__state) } })); });
  await page.getByRole('button', { name: 'Use current parser source', exact: true }).waitFor(); assert.equal(await page.getByLabel('Start (ms)', { exact: true }).inputValue(), '0'); assert.equal(await page.getByLabel('End (ms)', { exact: true }).inputValue(), '100');
  await page.getByRole('button', { name: 'Ask about interval', exact: true }).click(); assert.equal((await page.evaluate(() => window.__requests.findLast(r => r.type === 'ask'))).payload.selection.end, 100); record.checks.push('Native historical reveal replaces exact frozen interval and fields without implicit parser substitution; current parser source requires explicit action');
  await page.evaluate(() => { window.__state.revealedSelection = null; window.__state.recordings[0].completion = 'active'; window.__state.live = { recordingId: window.__state.selectedRecordingId, text: 'raw:100\n<script>window.__executed=true</script>', omittedBytes: 42, captureActive: true }; window.dispatchEvent(new MessageEvent('message', { data: { schemaVersion: 1, type: 'state', state: structuredClone(window.__state) } })); });
  await page.getByRole('button', { name: 'Pause display', exact: true }).click(); await page.evaluate(() => { window.__state.live.text = 'new bytes after pause'; window.dispatchEvent(new MessageEvent('message', { data: { schemaVersion: 1, type: 'state', state: structuredClone(window.__state) } })); });
  await page.getByText('Display paused; capture continues independently.', { exact: true }).waitFor(); assert.ok(await page.getByText('raw:100', { exact: false }).isVisible()); assert.equal(await page.getByRole('button', { name: 'Freeze interval', exact: true }).isDisabled(), true); assert.equal(await page.evaluate(() => window.__executed), undefined);
  await page.getByRole('button', { name: 'Stop capture', exact: true }).click(); assert.equal((await page.evaluate(() => window.__requests.filter(r => r.type === 'stopCapture'))).length, 1);
  await page.evaluate(() => { window.__state.recordings[0].completion = 'complete'; window.__state.live.captureActive = false; window.dispatchEvent(new MessageEvent('message', { data: { schemaVersion: 1, type: 'state', state: structuredClone(window.__state) } })); }); assert.equal(await page.getByRole('button', { name: 'Freeze interval', exact: true }).isDisabled(), true); record.checks.push('Live parsed/raw display pause preserves display while capture continues; active or paused provisional evidence cannot freeze even after finalization; raw script text remains inert; capture stop is distinct intent');
  await page.getByText('Display paused; capture finalized. Resume display to inspect retained derivation.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Resume display', exact: true }).press('Enter');
  await page.waitForFunction(() => document.activeElement === document.querySelector('[aria-label="Recording provenance"] h2'));
  await page.evaluate(() => { window.__state.live.recordingId = '33333333-3333-8333-8333-333333333334'; window.__state.live.captureActive = true; window.dispatchEvent(new MessageEvent('message', { data: { schemaVersion: 1, type: 'state', state: structuredClone(window.__state) } })); });
  await page.getByRole('region', { name: 'Raw serial text preview' }).waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: 'Stop capture', exact: true }).count(), 0);
  record.checks.push('Resuming a finalized display restores focus to the recording heading; an unrelated live snapshot cannot supply bytes or a Stop capture action');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); }); await page.waitForTimeout(50); assert.equal(await page.locator('canvas').count(), 0);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); }); await page.waitForTimeout(50); assert.equal(await page.locator('canvas').count(), 1); record.checks.push('Synthetic visibility transition disposes and recreates canvas resources without a capture intent');
  for (const variant of ['ready', 'loading', 'error', 'stale', 'unavailable', 'empty']) {
    const value = structuredClone(fixture); if (variant === 'loading') value.loading = true; if (variant === 'error') value.error = 'Raw artifact unavailable; preserved metadata remains readable.'; if (variant === 'stale') value.stale = true; if (variant === 'unavailable') { value.recordings[0].completion = 'unavailable'; value.window = null; } if (variant === 'empty') { value.recordings = []; value.runs = []; value.profiles = []; value.selectedRecordingId = value.selectedProfileId = value.window = value.comparison = null; }
    assert.ok(isTelemetryViewState(value)); await page.evaluate(s => { window.__state = s; window.dispatchEvent(new MessageEvent('message', { data: { schemaVersion: 1, type: 'state', state: structuredClone(s) } })); }, value);
    for (const [screen, tab] of [['S08', 'Recording detail'], ['S09', 'Runs & comparison']]) { await page.getByRole('button', { name: tab, exact: true }).click(); if (variant === 'error') for (const theme of ['dark', 'light', 'contrast']) { await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme); (record.contrast ??= []).push(await auditContrast(page, theme, `${screen}-error`)); } const name = `${screen}-${variant}.png`; await page.screenshot({ path: join(evidence, name), fullPage: true }); record.screenshots.push(name); }
    const raw = structuredClone(value); raw.window = null; raw.selectedProfileId = null; raw.revealedSelection = null; raw.comparison = null;
    raw.live = raw.selectedRecordingId && variant !== 'unavailable' ? { recordingId: raw.selectedRecordingId, text: 'Synthetic retained raw line 1\nSynthetic retained raw line 2\n', omittedBytes: 0, captureActive: variant === 'ready' } : null;
    if (variant === 'ready') {
      raw.recordings[0].completion = 'active';
      raw.recordings[0].device = 'Simulated connected recording device';
      raw.recordings[0].limitations = [];
    }
    assert.ok(isTelemetryViewState(raw)); await page.evaluate(s => { window.__state = s; window.dispatchEvent(new MessageEvent('message', { data: { schemaVersion: 1, type: 'state', state: structuredClone(s) } })); }, raw);
    await page.getByRole('button', { name: 'Recording detail', exact: true }).click(); const rawName = `S07-${variant}.png`; await page.screenshot({ path: join(evidence, rawName), fullPage: true }); record.screenshots.push(rawName);
  }
  await page.getByRole('button', { name: 'Refresh evidence' }).focus(); await page.keyboard.press('Tab'); assert.ok(await page.evaluate(() => ['BUTTON', 'INPUT', 'SELECT', 'SUMMARY'].includes(document.activeElement.tagName))); assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
  const requests = await page.evaluate(() => window.__requests); assert.ok(requests.every(r => isTelemetryViewRequest(r))); assert.ok(!requests.some(r => /upload|compile|write|sendSerial/.test(r.type))); assert.deepEqual(errors, []); assert.deepEqual(network, []); record.checks.push('Validated intents only; no serial-write/compile/upload intent; offline CSP no remote requests; keyboard focus, reduced motion, loading/error/stale/unavailable/empty states');
  await page.setViewportSize({ width: 1366, height: 768 }); await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.style.setProperty('--vscode-font-size', '13px'); });
  const large = structuredClone(fixture); large.recordings[0].completion = 'active'; large.live = { recordingId: large.selectedRecordingId, text: Array.from({ length: 10000 }, (_, index) => `${index % 10}\n`).join(''), omittedBytes: 0, captureActive: true };
  assert.ok(isTelemetryViewState(large)); await page.evaluate(s => { window.__state = s; window.dispatchEvent(new MessageEvent('message', { data: { schemaVersion: 1, type: 'state', state: structuredClone(s) } })); }, large); await page.getByRole('button', { name: 'Recording detail', exact: true }).click(); await page.getByRole('button', { name: 'Pause display', exact: true }).waitFor();
  const rawPreview = page.getByRole('region', { name: 'Raw serial text preview' });
  await rawPreview.focus(); await rawPreview.press('PageDown');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Raw serial text preview' && document.activeElement.scrollTop > 0);
  record.checks.push('Bounded raw serial text scrolls with the keyboard while retaining focus');
  const timing = [];
  for (let index = 0; index < 30; index++) timing.push(await page.evaluate(async index => {
    const before = index % 2 ? 'Resume display' : 'Pause display', after = index % 2 ? 'Pause display' : 'Resume display';
    const button = [...document.querySelectorAll('button')].find(item => item.textContent === before), start = performance.now(); button.click();
    while (button.textContent !== after) { if (performance.now() - start > 2000) throw Error('Display control feedback did not render'); await new Promise(requestAnimationFrame); }
    await new Promise(requestAnimationFrame); return performance.now() - start;
  }, index));
  record.renderTiming = { workload: '10,000 generated raw log rows in bounded 20,000-character preview; 30 warm display pause/resume controls', sampling: 'Browser performance.now before local click until matching rendered control label plus rendering frame', samplesMs: timing, p95FeedbackMs: [...timing].sort((a, b) => a - b)[Math.ceil(timing.length * .95) - 1], budgetMs: 150, limitation: 'Synthetic browser display; capture storage, real serial and 30-minute stability are separate evidence.' };
  assert.ok(record.renderTiming.p95FeedbackMs <= 150); assert.equal(await page.evaluate(() => window.__state.live.captureActive), true);
  await page.screenshot({ path: join(evidence, 'S07-10000-rows-ready.png'), fullPage: true }); record.screenshots.push('S07-10000-rows-ready.png');
  record.checks.push('S08/S09 validated state screenshot matrix; 10,000-row live raw display rendered-feedback samples preserve capture state');
  record.status = 'passed'; record.endedAt = new Date().toISOString(); record.bundleSha256 = createHash('sha256').update(await readFile(join(root, 'telemetry.js'))).digest('hex'); record.stylesheetSha256 = createHash('sha256').update(await readFile(join(root, 'telemetry.css'))).digest('hex'); await writeFile(join(evidence, 'result.json'), JSON.stringify(record, null, 2) + '\n'); console.log(JSON.stringify({ status: record.status, checks: record.checks.length, screenshots: record.screenshots }));
} catch (error) { record.status = 'failed'; record.error = String(error?.stack ?? error); await page?.screenshot({ path: join(evidence, 'failure.png'), fullPage: true }).catch(() => {}); await writeFile(join(evidence, 'result.json'), JSON.stringify(record, null, 2) + '\n'); console.error(JSON.stringify(record)); process.exitCode = 1; }
finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
