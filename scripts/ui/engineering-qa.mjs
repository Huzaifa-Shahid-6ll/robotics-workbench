import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { auditContrast } from './contrast.mjs';

const root = resolve(process.env.WORKBENCH_UI_ARTIFACT_ROOT || 'artifacts/task10-ui'), evidence = resolve(process.env.WORKBENCH_UI_EVIDENCE_ROOT || 'verification/evidence/task-10/ui');
await mkdir(root, { recursive: true }); await mkdir(evidence, { recursive: true }); await mkdir(resolve('artifacts/tmp'), { recursive: true });
process.env.TEMP = process.env.TMP = resolve('artifacts/tmp');
await build({ entryPoints: ['packages/webviews/src/engineering.tsx'], bundle: true, platform: 'browser', format: 'iife', target: 'es2022', minify: true, define: { 'process.env.NODE_ENV': '"production"' }, outfile: join(root, 'engineering.js') });
for (const name of ['engineering.js', 'engineering.css']) assert.deepEqual(await readFile(join(root, name)), await readFile(resolve('apps/extension/dist', name)), `QA ${name} must match production dist; run npm run build first`);
await build({ entryPoints: ['packages/test-fixtures/ui/engineering-state.ts', 'packages/webviews/src/engineering-protocol.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node24', outdir: root, outExtension: { '.js': '.cjs' } });
const require = createRequire(import.meta.url), { engineeringViewFixture, engineeringFixtureIds: ids } = require(join(root, 'test-fixtures/ui/engineering-state.cjs')), { isEngineeringRequest, isEngineeringState } = require(join(root, 'webviews/src/engineering-protocol.cjs'));
const fixture = engineeringViewFixture();
// Reuse the approved host-theme fixtures; these are test colors, never product tokens.
const documentQa = await readFile(resolve('scripts/ui/documents-qa.mjs'), 'utf8');
const theme = documentQa.match(/const theme = `([\s\S]*?)`;/)?.[1]; assert.ok(theme, 'Approved test theme fixture is available');
const server = createServer(async (request, response) => {
  try {
    if (request.url === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><html lang="en" data-theme="dark"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\'; img-src data:; connect-src \'none\'; frame-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\';"><link rel="stylesheet" href="/engineering.css"><link rel="stylesheet" href="/theme.css"><title>Engineering synthetic UI fixture</title></head><body><div id="root"></div><script src="/engineering.js"></script></body></html>'); return; }
    if (request.url === '/theme.css') { response.writeHead(200, { 'Content-Type': 'text/css' }).end(theme); return; }
    const name = request.url === '/engineering.js' ? 'engineering.js' : request.url === '/engineering.css' ? 'engineering.css' : null;
    if (!name) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': name.endsWith('.js') ? 'text/javascript' : 'text/css' }).end(await readFile(join(root, name)));
  } catch { response.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const record = { taskId: 'TASK-10', evidenceClass: 'synthetic-browser-ui', command: 'node scripts/ui/engineering-qa.mjs', startedAt: new Date().toISOString(), referenceLock: 'D41/D42 host-native VS Code + full Factory/Cursor styles; R10 Spline viewport/properties, R11 Factory source/evidence. Host fonts/colors, 4px controls, 12px sections, no shadows or marketing palette.', checks: ['production JavaScript/CSS byte-identical to extension dist'], screenshots: [], limitations: ['Synthetic generation receipts and preview SVG; no real CAD/KiCad tool execution, native application association, screen-reader or physical verification. Zoom is approximated by doubled host font and halved viewport.'] };
record.bundleSha256 = createHash('sha256').update(await readFile(join(root, 'engineering.js'))).digest('hex'); record.stylesheetSha256 = createHash('sha256').update(await readFile(join(root, 'engineering.css'))).digest('hex');
let browser, page;
try {
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true }); record.browser = await browser.version();
  const context = await browser.newContext({ viewport: { width: 1000, height: 768 }, reducedMotion: 'reduce' });
  await context.addInitScript(fixture => {
    window.__state = fixture; window.__requests = []; window.__acquisitions = 0;
    window.__push = state => { window.__state = structuredClone(state); window.postMessage({ schemaVersion: 1, type: 'state', state }, '*'); };
    window.acquireVsCodeApi = () => { window.__acquisitions++; return { postMessage: message => {
      window.__requests.push(message); const state = structuredClone(window.__state);
      if (message.type === 'screen') state.screen = message.payload.screen;
      setTimeout(() => { window.__ack = message.requestId; window.__push(state); }, 30);
    } }; };
  }, fixture);
  page = await context.newPage(); const errors = [], remote = [];
  record.pageErrors = errors;
  page.on('pageerror', error => errors.push(String(error))); page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:') && !request.url().startsWith('data:')) remote.push(request.url()); });
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.getByRole('heading', { name: 'Per-sheet preview', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__acquisitions), 1); await page.getByText('Check process completed', { exact: true }).waitFor(); await page.getByText('! Validation FAIL', { exact: true }).waitFor();
  await page.getByText('! Independent native edits — diverged', { exact: true }).waitFor(); assert.equal(await page.locator('svg,object,iframe').count(), 0); assert.equal(await page.evaluate(() => window.__svgExecuted), undefined);
  assert.ok(await page.getByAltText(/KiCad sheet Root sheet/).evaluate(image => image.complete && image.naturalWidth > 0));
  record.checks.push('single API acquisition; failing ERC distinct from completed check; native divergence and stale revision visible; hostile SVG only isolated img with no execution or network');
  await page.evaluate(() => { const state = structuredClone(window.__state); state.preview.dataUrl = 'data:image/svg+xml;base64,PHN2Zw=='; window.__push(state); });
  await page.getByText(/This sheet image could not render/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Open in KiCad', exact: true }).isEnabled(), true);
  await page.getByText('! Validation FAIL', { exact: true }).waitFor();
  await page.evaluate(value => window.__push(value), fixture);
  await page.getByAltText(/KiCad sheet Root sheet/).waitFor();
  record.checks.push('broken preview has an explicit native fallback and retains validation evidence; good image returns after refresh');
  await page.getByRole('button', { name: 'Open in KiCad', exact: true }).evaluate(button => { button.click(); button.click(); });
  await page.waitForFunction(() => window.__ack === window.__requests.at(-1)?.requestId);
  const open = await page.evaluate(() => window.__requests.filter(item => item.type === 'openSchematic')); assert.equal(open.length, 1); assert.deepEqual(open[0].payload, { generationId: ids.generation });
  await page.getByRole('button', { name: 'Scripted CAD', exact: true }).click(); await page.getByRole('heading', { name: 'Bracket (synthetic)', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Generate production model', exact: true }).isDisabled(), true); assert.equal(await page.getByRole('button', { name: 'Review STL export', exact: true }).isDisabled(), true);
  await page.getByText('! Operation failed', { exact: true }).waitFor(); await page.getByRole('heading', { name: 'Last successful geometry', exact: true }).waitFor();
  await page.getByText('Source design revision 3 · cadquery synthetic-fixture', { exact: true }).waitFor();
  await page.getByText('Exact output receipt, fingerprint & validation', { exact: true }).press('Enter');
  await page.getByText(fixture.cad.assets[0].lastGood.artifacts[0].sha256, { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Open parameters', exact: true }).focus(); await page.keyboard.press('Tab');
  assert.ok(await page.getByRole('region', { name: 'Bracket (synthetic) parameters' }).evaluate(region => document.activeElement === region && getComputedStyle(region).outlineStyle === 'solid'));
  record.checks.push('retained CAD output exposes its recorded revision and exact digest; keyboard focus is visible on the parameter table');
  await page.getByLabel('holeSpacing (mm)', { exact: true }).fill('12.5'); await page.getByRole('button', { name: 'Generate exploratory model', exact: true }).click();
  await page.waitForFunction(() => window.__ack === window.__requests.at(-1)?.requestId);
  const generate = await page.evaluate(() => window.__requests.find(item => item.type === 'generateCad')); assert.deepEqual(generate.payload, { assetId: ids.asset, mode: 'exploratory', assumptions: { holeSpacing: 12.5 } });
  assert.equal(await page.evaluate(() => window.__state.cad.assets[0].parameters.holeSpacing.value), null);
  await page.getByRole('button', { name: 'Open OCP viewer handoff', exact: true }).click(); await page.waitForFunction(() => window.__ack === window.__requests.at(-1)?.requestId);
  record.checks.push('duplicate native open intent admitted once with opaque generation ID; unknown fit-critical source stays null, explicit exploratory assumptions freeze numeric values; production export blocked; failed generation retains good geometry and separate viewer handoff');
  await page.evaluate(() => { const state = structuredClone(window.__state); state.cad.assets[0].issues = ['<img src=x onerror="window.bad=1">']; window.__push(state); });
  await page.getByText('<img src=x onerror="window.bad=1">', { exact: true }).waitFor(); assert.equal(await page.locator('img[src=x]').count(), 0); assert.equal(await page.evaluate(() => window.bad), undefined);
  await page.evaluate(() => window.postMessage({ schemaVersion: 1, type: 'state', state: { schemaVersion: 99 } }, '*')); assert.equal(await page.getByRole('heading', { name: 'Engineering artifacts', exact: true }).count(), 1);
  record.checks.push('source/log markup inert, malformed host messages ignored');
  for (const screen of ['schematic', 'cad']) for (const config of [{ theme: 'dark', width: 1000, height: 768, font: 13 }, { theme: 'light', width: 1000, height: 768, font: 13 }, { theme: 'contrast', width: 1000, height: 768, font: 13 }, { theme: 'dark', width: 320, height: 768, font: 13 }, { theme: 'light', width: 683, height: 384, font: 26 }]) {
    await page.setViewportSize({ width: config.width, height: config.height }); await page.evaluate(({ fixture, screen, config }) => { const state = structuredClone(fixture); state.screen = screen; window.__push(state); document.documentElement.dataset.theme = config.theme; document.documentElement.style.setProperty('--vscode-font-size', `${config.font}px`); }, { fixture, screen, config });
    await page.getByRole('heading', { name: screen === 'cad' ? 'Bracket (synthetic)' : 'Per-sheet preview', exact: true }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${screen} ${config.width} should reflow`);
    const name = `${screen}-${config.theme}-${config.width}${config.font === 26 ? '-font200' : ''}.png`; await page.screenshot({ path: join(evidence, name), fullPage: true }); record.screenshots.push(name);
    if (config.width === 1000) (record.contrast ??= []).push(await auditContrast(page, config.theme, screen === 'cad' ? 'S10-cad' : 'S16-schematic'));
  }
  record.checks.push('both surfaces dark/light/high-contrast, 320px single-column and approximate 200% zoom: no page horizontal overflow');
  await page.setViewportSize({ width: 1000, height: 768 });
  for (const scenario of ['loading', 'empty', 'unavailable', 'error', 'ready', 'stale']) {
    await page.evaluate(({ fixture, scenario }) => { const state = structuredClone(fixture); state.screen = 'schematic'; if (scenario === 'loading') state.loading = true; if (scenario === 'empty') { state.schematic.generations = []; state.preview = null; } if (scenario === 'unavailable') { state.trusted = false; state.schematic.readiness = { available: false, reason: 'Configure supported KiCad executable in settings.' }; } if (scenario === 'error') state.error = 'Synthetic regeneration failed; previous preview retained.'; if (scenario === 'ready') { state.schematic.generations[0].stale = false; state.preview.stale = false; state.schematic.source.diverged = false; } window.__push(state); }, { fixture, scenario });
    if (scenario === 'loading') await page.getByText(/Refreshing \/ action in progress/).waitFor();
    if (scenario === 'empty') await page.getByRole('heading', { name: 'No schematic generation', exact: true }).waitFor();
    if (scenario === 'unavailable') assert.equal(await page.getByRole('button', { name: 'Generate staged schematic', exact: true }).isDisabled(), true);
    if (scenario === 'error') { await page.getByRole('alert').waitFor(); assert.equal(await page.getByAltText(/KiCad sheet Root sheet/).count(), 1); }
    if (scenario === 'error') for (const theme of ['dark', 'light', 'contrast']) { await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme); (record.contrast ??= []).push(await auditContrast(page, theme, 'S16-error')); }
    const name = `schematic-state-${scenario}.png`; await page.screenshot({ path: join(evidence, name), fullPage: true }); record.screenshots.push(name);
  }
  await page.getByRole('button', { name: 'Refresh saved evidence', exact: true }).focus(); await page.keyboard.press('Tab');
  assert.ok(await page.evaluate(() => ['BUTTON', 'INPUT', 'SELECT', 'SUMMARY'].includes(document.activeElement.tagName)));
  assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
  record.checks.push('loading/empty/unavailable/error/ready presentations with retained stale preview, keyboard traversal and reduced motion');
  const requests = await page.evaluate(() => window.__requests); assert.ok(requests.every(item => isEngineeringRequest(item))); assert.ok(!requests.some(item => /upload|compile|execute|send/.test(item.type))); assert.deepEqual(errors, []); assert.deepEqual(remote, []);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.style.setProperty('--vscode-font-size', '13px'); });
  for (const scenario of ['ready', 'loading', 'empty', 'unavailable', 'error', 'stale']) {
    const value = structuredClone(fixture); value.screen = 'cad';
    if (scenario === 'loading') value.loading = true;
    if (scenario === 'empty') value.cad.assets = [];
    if (scenario === 'unavailable') { value.cad.capabilities.configured = false; value.cad.capabilities.pythonPath = null; }
    if (scenario === 'error') value.error = 'Synthetic CAD generation failure; last good geometry is retained.';
    if (scenario === 'ready') { value.cad.assets[0].stale = false; value.cad.assets[0].latestOperation = value.cad.assets[0].lastGood; }
    assert.ok(isEngineeringState(value)); await page.evaluate(state => window.__push(state), value);
    if (scenario === 'loading') await page.getByText(/Refreshing \/ action in progress/).waitFor();
    if (scenario === 'empty') await page.getByRole('heading', { name: 'No declared CAD assets', exact: true }).waitFor();
    if (scenario === 'unavailable') await page.getByText('· CAD unavailable', { exact: true }).waitFor();
    if (scenario === 'error') await page.getByRole('alert').waitFor();
    if (scenario === 'error') for (const theme of ['dark', 'light', 'contrast']) { await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme); (record.contrast ??= []).push(await auditContrast(page, theme, 'S10-error')); }
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    const name = `S10-${scenario}.png`; await page.screenshot({ path: join(evidence, name), fullPage: true }); record.screenshots.push(name);
  }
  record.checks.push('S10 validated ready/loading/empty/unavailable/error/stale screenshot fixtures');
  record.status = 'passed'; record.endedAt = new Date().toISOString(); record.bundleSha256 = createHash('sha256').update(await readFile(join(root, 'engineering.js'))).digest('hex'); record.stylesheetSha256 = createHash('sha256').update(await readFile(join(root, 'engineering.css'))).digest('hex');
  await writeFile(join(evidence, 'result.json'), JSON.stringify(record, null, 2) + '\n'); console.log(JSON.stringify({ status: record.status, checks: record.checks.length, screenshots: record.screenshots.length }));
} catch (error) { record.status = 'failed'; record.error = String(error?.stack ?? error); const stamp = record.startedAt.replaceAll(/[:.]/g, '-'); await page?.screenshot({ path: join(evidence, `failure-${stamp}.png`), fullPage: true }).catch(() => {}); await writeFile(join(evidence, `failed-${stamp}.json`), JSON.stringify(record, null, 2) + '\n'); await writeFile(join(evidence, 'result.json'), JSON.stringify(record, null, 2) + '\n'); console.error(JSON.stringify(record)); process.exitCode = 1; }
finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
