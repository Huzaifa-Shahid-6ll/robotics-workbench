import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { auditContrast } from './contrast.mjs';

const root = resolve(process.env.WORKBENCH_UI_ARTIFACT_ROOT || 'artifacts/task08-ui'), evidence = resolve(process.env.WORKBENCH_UI_EVIDENCE_ROOT || 'verification/evidence/task-08/ui');
await mkdir(root, { recursive: true }); await mkdir(evidence, { recursive: true }); await mkdir(resolve('artifacts/tmp'), { recursive: true });
process.env.TEMP = process.env.TMP = resolve('artifacts/tmp');
await build({ entryPoints: ['packages/webviews/src/documents.tsx'], bundle: true, platform: 'browser', format: 'iife', target: 'es2022', minify: true, define: { 'process.env.NODE_ENV': '"production"' }, outfile: join(root, 'documents.js') });
for (const name of ['documents.js', 'documents.css']) assert.deepEqual(await readFile(join(root, name)), await readFile(resolve('apps/extension/dist', name)), `QA ${name} must match packaged production bytes; run npm run build first`);
await build({ entryPoints: ['packages/test-fixtures/ui/documents-state.ts', 'packages/webviews/src/document-protocol.ts', 'packages/adapters/documents/src/index.ts', 'packages/test-fixtures/documents/fixtures.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node24', outdir: root, outExtension: { '.js': '.cjs' } });
const require = createRequire(import.meta.url), { documentViewFixture, documentFixtureIds: ids } = require(join(root, 'test-fixtures/ui/documents-state.cjs'));
const { isDocumentViewRequest, isDocumentViewState } = require(join(root, 'webviews/src/document-protocol.cjs'));
const { pdfFixture } = require(join(root, 'test-fixtures/documents/fixtures.cjs')), { extractDocument, renderDocumentPage } = require(join(root, 'adapters/documents/src/index.cjs'));
const workerOptions = { workerPath: resolve('apps/extension/dist/documents-worker.cjs') };
const bytes = pdfFixture({ rotated: true, activeContent: true }), extraction = await extractDocument(bytes, 'application/pdf', workerOptions), image = await renderDocumentPage(bytes, 1, workerOptions);
const fixture = documentViewFixture(), page = extraction.pages[0];
fixture.documents[0].currentSha256 = extraction.artifactSha256; fixture.documents[0].versions = [{ artifactSha256: extraction.artifactSha256, extractorVersion: extraction.extractorVersion, pageCount: 1, status: extraction.status, mediaType: extraction.mediaType, attachedAt: '2026-11-03T08:00:00Z' }];
fixture.selection = { documentId: ids.document, artifactSha256: extraction.artifactSha256, extractorVersion: extraction.extractorVersion, page: 1 };
fixture.page = { citation: { documentId: ids.document, artifactSha256: extraction.artifactSha256, page: 1, printedPageLabel: page.printedPageLabel, text: page.text, method: extraction.method, extractorVersion: extraction.extractorVersion, applicability: 'unresolved', truncated: false }, pageCount: 1, rotation: page.rotation, text: page.text, regions: page.regions, image, limitations: extraction.limitations, sourceCurrent: true };
const theme = `:root{--vscode-font-family:system-ui;--vscode-font-size:13px;--vscode-editor-font-family:Consolas,monospace}
:root[data-theme=dark]{color-scheme:dark;--vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#d4d4d4;--vscode-descriptionForeground:#b0b0b0;--vscode-panel-border:#666;--vscode-input-background:#313131;--vscode-input-foreground:#fff;--vscode-input-border:#888;--vscode-focusBorder:#007fd4;--vscode-button-background:#0e639c;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#383838;--vscode-button-secondaryForeground:#fff;--vscode-textLink-foreground:#64b5f6;--vscode-errorForeground:#ff9999;--vscode-disabledForeground:#aaa}
:root[data-theme=light]{color-scheme:light;--vscode-editor-background:#fff;--vscode-editor-foreground:#333;--vscode-descriptionForeground:#595959;--vscode-panel-border:#909090;--vscode-input-background:#fff;--vscode-input-foreground:#333;--vscode-input-border:#707070;--vscode-focusBorder:#0066b8;--vscode-button-background:#0066b8;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#eee;--vscode-button-secondaryForeground:#333;--vscode-textLink-foreground:#005a9e;--vscode-errorForeground:#a1260d;--vscode-disabledForeground:#666}
:root[data-theme=contrast]{color-scheme:dark;--vscode-editor-background:#000;--vscode-editor-foreground:#fff;--vscode-descriptionForeground:#fff;--vscode-panel-border:#fff;--vscode-input-background:#000;--vscode-input-foreground:#fff;--vscode-input-border:#fff;--vscode-focusBorder:#ff0;--vscode-button-background:#000;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#000;--vscode-button-secondaryForeground:#fff;--vscode-textLink-foreground:#ff0;--vscode-errorForeground:#fff;--vscode-disabledForeground:#fff}`;
const server = createServer(async (request, response) => {
  try {
    if (request.url === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><html lang="en" data-theme="dark"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\'; img-src data:; connect-src \'none\';"><link rel="stylesheet" href="/documents.css"><link rel="stylesheet" href="/theme.css"><title>Document evidence synthetic fixture</title></head><body><div id="root"></div><script src="/documents.js"></script></body></html>'); return; }
    if (request.url === '/theme.css') { response.writeHead(200, { 'Content-Type': 'text/css' }).end(theme); return; }
    const name = request.url === '/documents.js' ? 'documents.js' : request.url === '/documents.css' ? 'documents.css' : null;
    if (!name) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': name.endsWith('.js') ? 'text/javascript' : 'text/css' }).end(await readFile(join(root, name)));
  } catch { response.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const record = { taskId: 'TASK-08', evidenceClass: 'synthetic-browser-ui', command: 'node scripts/ui/documents-qa.mjs', startedAt: new Date().toISOString(), referenceLock: 'D41/D42 host-native VSCode; R11 source reading beside assistant. Cursor compact 4px controls/12px panels; Attio thin dividers; Missive page navigation and Open original. No marketing fonts/colors.', checks: ['production JavaScript and CSS byte-identical to packaged dist', 'synthetic real PDF.js extraction/render with rotation, printed-page offset and inert PDF active content'], screenshots: [], limitations: ['Synthetic source PDF/citations; no manufacturer applicability, native document navigation, live provider, physical device or Windows screen reader is established.'] };
let browser, browserPage;
try {
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true }); record.browser = await browser.version();
  const context = await browser.newContext({ viewport: { width: 1000, height: 768 }, reducedMotion: 'reduce' });
  await context.addInitScript(({ fixture, ids }) => {
    window.__state = JSON.parse(sessionStorage.getItem('documents-backend') ?? 'null') ?? fixture; window.__requests = []; window.__acquisitions = 0;
    window.__push = state => { window.__state = structuredClone(state); sessionStorage.setItem('documents-backend', JSON.stringify(state)); window.postMessage({ schemaVersion: 1, type: 'state', state }, '*'); };
    window.acquireVsCodeApi = () => { window.__acquisitions++; return {
      getState: () => JSON.parse(sessionStorage.getItem('documents-ui') ?? 'null'), setState: value => sessionStorage.setItem('documents-ui', JSON.stringify(value)),
      postMessage: message => {
        window.__requests.push(message); const state = structuredClone(window.__state);
        if (message.type === 'search') { state.query = message.payload.query; state.results = [structuredClone(state.page.citation)]; }
        if (message.type === 'navigate' && message.payload.citation.region) { const block = state.page.regions.find(item => JSON.stringify(item.region) === JSON.stringify(message.payload.citation.region)); if (block) state.page.citation = { ...state.page.citation, region: block.region, text: block.text, truncated: false }; }
        if (message.type === 'page') { state.selection = structuredClone(fixture.selection); state.page = structuredClone(fixture.page); }
        if (message.type === 'selectDocument' && message.payload.documentId === ids.unindexed) { state.selection = null; state.page = null; }
        if (['ready', 'refresh', 'search', 'ask', 'openOriginal', 'selectDocument', 'navigate', 'page'].includes(message.type)) setTimeout(() => { window.__ack = message.requestId; window.__push(state); }, 20);
      }
    }; };
  }, { fixture, ids });
  browserPage = await context.newPage(); const errors = [], network = [];
  browserPage.on('pageerror', error => errors.push(String(error))); browserPage.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:') && !request.url().startsWith('data:')) network.push(request.url()); });
  await browserPage.goto(`http://127.0.0.1:${server.address().port}`); await browserPage.getByText('Matches saved source', { exact: false }).waitFor();
  assert.equal(await browserPage.evaluate(() => window.__acquisitions), 1); assert.equal(await browserPage.getByAltText(/Original physical page 1 · printed 10/).count(), 1);
  await browserPage.getByText('Physical page 1 · printed 10', { exact: true }).waitFor(); record.checks.push('single API acquisition, exact physical/printed page label and original PNG preview');
  await browserPage.evaluate(() => { const state = structuredClone(window.__state); state.selection = null; state.page = null; window.__push(state); });
  await browserPage.getByRole('button', { name: 'Show retained first page' }).press('Enter');
  await browserPage.waitForFunction(() => document.activeElement?.textContent === 'Physical page 1 · printed 10');
  assert.deepEqual(await browserPage.evaluate(() => window.__requests.find(request => request.type === 'page').payload), fixture.selection);
  const pageInput = browserPage.getByLabel('Physical page', { exact: true });
  await pageInput.fill('2'); await pageInput.press('Enter');
  assert.equal(await pageInput.getAttribute('aria-invalid'), 'true');
  await browserPage.getByText('Enter a whole page number from 1 to 1.', { exact: true }).waitFor();
  assert.equal(await browserPage.evaluate(() => window.__requests.filter(request => request.type === 'page').length), 1);
  await pageInput.fill('1'); await pageInput.press('Enter');
  await browserPage.waitForFunction(() => window.__requests.filter(request => request.type === 'page').length === 2 && window.__ack === window.__requests.at(-1)?.requestId);
  assert.equal(await pageInput.getAttribute('aria-invalid'), null);
  record.checks.push('retained first page has a keyboard action and focuses the revealed page; invalid page input explains the range and emits no request; Enter submits a valid page');
  await browserPage.getByRole('button', { name: 'Select excerpt 1', exact: true }).click(); await browserPage.getByRole('region', { name: 'Frozen citation' }).waitFor();
  const frozen = await browserPage.evaluate(() => JSON.parse(sessionStorage.getItem('documents-ui')).frozen);
  await browserPage.evaluate(() => { const next = structuredClone(window.__state); next.documents[0].currentSha256 = 'd'.repeat(64); next.page.sourceCurrent = false; next.page.text = 'Later extraction display'; window.__push(next); });
  await browserPage.getByText(/Historical source — saved file differs/).waitFor();
  await browserPage.getByRole('button', { name: 'Ask about citation', exact: true }).evaluate(button => { button.click(); button.click(); });
  await browserPage.waitForFunction(() => window.__requests.some(request => request.type === 'ask'));
  const ask = await browserPage.evaluate(() => window.__requests.filter(request => request.type === 'ask')); assert.equal(ask.length, 1); assert.deepEqual(ask[0].payload.citation, frozen);
  record.checks.push('frozen hash/page/region/excerpt survives later source and display changes; duplicate Ask admitted once without agent submission');
  await browserPage.getByLabel('Search selected document', { exact: true }).fill('Supply'); await browserPage.getByRole('button', { name: 'Search excerpts', exact: true }).click(); await browserPage.getByRole('heading', { name: 'Search results for “Supply”', exact: true }).waitFor();
  assert.equal(await browserPage.evaluate(() => window.__requests.find(request => request.type === 'search').payload.documentId), ids.document); record.checks.push('explicit document-scoped search and exact citation results');
  await browserPage.getByRole('button', { name: 'Open retained original', exact: true }).click(); await browserPage.waitForFunction(() => window.__requests.some(request => request.type === 'openOriginal'));
  await browserPage.waitForFunction(() => window.__ack === window.__requests.at(-1)?.requestId);
  assert.equal(await browserPage.evaluate(() => window.__requests.find(request => request.type === 'openOriginal').payload.artifactSha256), fixture.selection.artifactSha256); record.checks.push('Open original sends exact retained hash without frame-supplied paths');
  await browserPage.evaluate(() => { const state = structuredClone(window.__state); state.page.regions[0].text = '<img src=x onerror="window.bad=1">'; window.__push(state); });
  await browserPage.getByText('<img src=x onerror="window.bad=1">', { exact: true }).waitFor(); assert.equal(await browserPage.locator('img[src=x]').count(), 0); assert.equal(await browserPage.evaluate(() => window.bad), undefined);
  await browserPage.evaluate(() => window.postMessage({ schemaVersion: 1, type: 'state', state: { schemaVersion: 99 } }, '*')); assert.equal(await browserPage.getByRole('heading', { name: 'Documents & citations', exact: true }).count(), 1); record.checks.push('malicious extracted markup remains inert and malformed host state is ignored');
  await browserPage.evaluate(() => { const state = structuredClone(window.__state); state.trusted = false; window.__push(state); });
  assert.equal(await browserPage.getByRole('button', { name: 'Index saved source', exact: true }).isDisabled(), true); assert.equal(await browserPage.getByRole('button', { name: 'Ask about citation', exact: true }).isDisabled(), true);
  await browserPage.evaluate(() => { const state = structuredClone(window.__state); state.trusted = true; state.error = 'Synthetic extraction error; retained source is available.'; window.__push(state); }); await browserPage.getByRole('alert').waitFor(); record.checks.push('restricted trust disables indexing/agent handoff and extraction error preserves original access');
  await browserPage.getByLabel('Search selected document', { exact: true }).fill('Retained query draft'); await browserPage.reload(); await browserPage.getByLabel('Search selected document', { exact: true }).waitFor(); assert.equal(await browserPage.getByLabel('Search selected document', { exact: true }).inputValue(), 'Retained query draft');
  assert.deepEqual(await browserPage.evaluate(() => JSON.parse(sessionStorage.getItem('documents-ui')).frozen), frozen); record.checks.push('draft query and exact selected citation survive webview recreation');
  await browserPage.getByRole('button', { name: /Part notes/, exact: false }).click(); await browserPage.getByText('Not indexed. Indexing retains the saved original', { exact: false }).waitFor(); await browserPage.waitForFunction(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Index saved source')?.disabled === false); record.checks.push('unindexed manifest document remains selectable and explicit indexing is available');
  await browserPage.evaluate(fixture => window.__push(fixture), fixture);
  for (const configuration of [{ theme: 'dark', width: 1000, height: 768, font: 13 }, { theme: 'light', width: 1000, height: 768, font: 13 }, { theme: 'contrast', width: 1000, height: 768, font: 13 }, { theme: 'dark', width: 320, height: 768, font: 13 }, { theme: 'light', width: 683, height: 384, font: 26 }]) {
    await browserPage.setViewportSize({ width: configuration.width, height: configuration.height }); await browserPage.evaluate(configuration => { document.documentElement.dataset.theme = configuration.theme; document.documentElement.style.setProperty('--vscode-font-size', `${configuration.font}px`); }, configuration);
    assert.ok(await browserPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)); assert.ok(await browserPage.getByRole('button', { name: 'Index saved source', exact: true }).isVisible());
    const name = `${configuration.theme}-${configuration.width}${configuration.font === 26 ? '-font200' : ''}.png`; await browserPage.screenshot({ path: join(evidence, name), fullPage: true }); record.screenshots.push(name); record.checks.push(`${configuration.theme}/${configuration.width}/font${configuration.font}: no page-level horizontal overflow and primary actions reachable`);
    if (configuration.width === 1000) (record.contrast ??= []).push(await auditContrast(browserPage, configuration.theme, 'S11-documents'));
  }
  await browserPage.getByRole('button', { name: 'Index saved source', exact: true }).focus(); await browserPage.keyboard.press('Tab'); assert.ok(await browserPage.evaluate(() => ['BUTTON', 'INPUT', 'SELECT', 'SUMMARY'].includes(document.activeElement.tagName)));
  assert.equal(await browserPage.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true); record.checks.push('keyboard focus traversal and reduced-motion preference');
  const requests = await browserPage.evaluate(() => window.__requests); assert.ok(requests.every(request => isDocumentViewRequest(request))); assert.ok(!requests.some(request => /upload|compile|execute|send/.test(request.type))); assert.deepEqual(errors, []); assert.deepEqual(network, []);
  await browserPage.setViewportSize({ width: 1000, height: 768 }); await browserPage.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.style.setProperty('--vscode-font-size', '13px'); });
  for (const scenario of ['ready', 'loading', 'empty', 'unavailable', 'error', 'stale']) {
    const value = structuredClone(fixture);
    if (scenario === 'loading') value.loading = true;
    if (scenario === 'empty') { value.documents = []; value.selection = null; value.page = null; value.results = []; value.query = ''; }
    if (scenario === 'unavailable') { value.page.image = null; value.page.limitations = ['Synthetic page renderer unavailable; exact original remains retained.']; }
    if (scenario === 'error') value.error = 'Synthetic extraction failure; retained original remains available.';
    if (scenario === 'stale') { value.page.sourceCurrent = false; value.documents[0].currentSha256 = 'd'.repeat(64); }
    assert.ok(isDocumentViewState(value)); await browserPage.evaluate(state => window.__push(state), value);
    if (scenario === 'loading') await browserPage.getByText('Loading document evidence…', { exact: true }).waitFor();
    if (scenario === 'error') await browserPage.getByRole('alert').waitFor();
    if (scenario === 'unavailable') await browserPage.getByText(/Page image unavailable/).waitFor();
    if (scenario === 'stale') await browserPage.getByText(/Historical source — saved file differs/).waitFor();
    if (scenario === 'error') for (const theme of ['dark', 'light', 'contrast']) { await browserPage.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme); (record.contrast ??= []).push(await auditContrast(browserPage, theme, 'S11-error')); }
    await browserPage.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    const name = `S11-${scenario}.png`; await browserPage.screenshot({ path: join(evidence, name), fullPage: true }); record.screenshots.push(name);
  }
  record.checks.push('S11 validated ready/loading/empty/unavailable/error/stale screenshot fixtures');
  record.status = 'passed'; record.endedAt = new Date().toISOString(); record.bundleSha256 = createHash('sha256').update(await readFile(join(root, 'documents.js'))).digest('hex'); record.stylesheetSha256 = createHash('sha256').update(await readFile(join(root, 'documents.css'))).digest('hex');
  await writeFile(join(evidence, 'result.json'), JSON.stringify(record, null, 2) + '\n'); console.log(JSON.stringify({ status: record.status, checks: record.checks.length, screenshots: record.screenshots }));
} catch (error) { record.status = 'failed'; record.error = String(error?.stack ?? error); await browserPage?.screenshot({ path: join(evidence, 'failure.png'), fullPage: true }).catch(() => {}); await writeFile(join(evidence, 'result.json'), JSON.stringify(record, null, 2) + '\n'); console.error(JSON.stringify(record)); process.exitCode = 1; }
finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
