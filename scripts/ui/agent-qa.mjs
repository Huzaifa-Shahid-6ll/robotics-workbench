import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { auditContrast } from './contrast.mjs';

const artifactRoot = resolve(process.env.WORKBENCH_UI_ARTIFACT_ROOT || 'artifacts/task06-ui');
const evidenceRoot = resolve(process.env.WORKBENCH_UI_EVIDENCE_ROOT || 'verification/evidence/task-06/ui');
await mkdir(artifactRoot, { recursive: true }); await mkdir(evidenceRoot, { recursive: true });
await build({ entryPoints: ['packages/webviews/src/agent.tsx'], bundle: true, platform: 'browser', format: 'iife', target: 'es2022', minify: true, define: { 'process.env.NODE_ENV': '"production"' }, outfile: join(artifactRoot, 'agent.js') });
for (const name of ['agent.js', 'agent.css']) assert.deepEqual(await readFile(join(artifactRoot, name)), await readFile(resolve('apps/extension/dist', name)), `UI QA must exercise the packaged ${name} bytes; run npm run build first.`);
await build({ entryPoints: ['packages/test-fixtures/ui/agent-state.ts', 'packages/webviews/src/protocol.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node24', outdir: artifactRoot, outExtension: { '.js': '.cjs' } });
const require = createRequire(import.meta.url);
const { agentViewFixture } = require(join(artifactRoot, 'test-fixtures/ui/agent-state.cjs'));
const { isWorkbenchViewRequest, isWorkbenchViewState } = require(join(artifactRoot, 'webviews/src/protocol.cjs'));
const fixture = agentViewFixture();
const themeCss = `
:root { --vscode-font-family: system-ui; --vscode-font-size: 13px; --vscode-editor-font-family: Consolas, monospace; }
:root[data-theme=dark] { color-scheme: dark; --vscode-editor-background:#1e1e1e; --vscode-editor-foreground:#d4d4d4; --vscode-descriptionForeground:#b0b0b0; --vscode-panel-border:#555555; --vscode-input-background:#313131; --vscode-input-foreground:#ffffff; --vscode-input-border:#888888; --vscode-focusBorder:#007fd4; --vscode-button-background:#0e639c; --vscode-button-foreground:#ffffff; --vscode-button-secondaryBackground:#383838; --vscode-button-secondaryForeground:#ffffff; --vscode-textLink-foreground:#64b5f6; --vscode-errorForeground:#ff9999; --vscode-disabledForeground:#aaaaaa; }
:root[data-theme=light] { color-scheme:light; --vscode-editor-background:#ffffff; --vscode-editor-foreground:#333333; --vscode-descriptionForeground:#595959; --vscode-panel-border:#909090; --vscode-input-background:#ffffff; --vscode-input-foreground:#333333; --vscode-input-border:#707070; --vscode-focusBorder:#0066b8; --vscode-button-background:#0066b8; --vscode-button-foreground:#ffffff; --vscode-button-secondaryBackground:#eeeeee; --vscode-button-secondaryForeground:#333333; --vscode-textLink-foreground:#005a9e; --vscode-errorForeground:#a1260d; --vscode-disabledForeground:#666666; }
:root[data-theme=contrast] { color-scheme:dark; --vscode-editor-background:#000000; --vscode-editor-foreground:#ffffff; --vscode-descriptionForeground:#ffffff; --vscode-panel-border:#ffffff; --vscode-input-background:#000000; --vscode-input-foreground:#ffffff; --vscode-input-border:#ffffff; --vscode-focusBorder:#ffff00; --vscode-button-background:#000000; --vscode-button-foreground:#ffffff; --vscode-button-secondaryBackground:#000000; --vscode-button-secondaryForeground:#ffffff; --vscode-textLink-foreground:#ffff00; --vscode-errorForeground:#ffffff; --vscode-disabledForeground:#ffffff; }
`;
const server = createServer(async (request, response) => {
  try {
    if (request.url === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><html lang="en" data-theme="dark"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\';"><link rel="stylesheet" href="/agent.css"><link rel="stylesheet" href="/theme.css"><title>Robotics agent synthetic fixture</title></head><body><div id="root"></div><script src="/agent.js"></script></body></html>'); return; }
    if (request.url === '/theme.css') { response.writeHead(200, { 'Content-Type': 'text/css' }).end(themeCss); return; }
    const filename = request.url === '/agent.js' ? 'agent.js' : request.url === '/agent.css' ? 'agent.css' : null;
    if (!filename) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': filename.endsWith('.js') ? 'text/javascript' : 'text/css' }).end(await readFile(join(artifactRoot, filename)));
  } catch { response.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const record = { taskId: 'TASK-06', evidenceClass: 'synthetic-browser-ui', startedAt: new Date().toISOString(), referenceLock: 'D41 native VS Code with Factory/Cursor compact panel, R02 conversation, R03 grouped context, R06 native diff review.', command: 'node scripts/ui/agent-qa.mjs', checks: [], screenshots: [], limitations: ['Synthetic project/provider/operation facts; this does not exercise actual provider execution, native editor diff, physical hardware or a Windows screen reader.'] };
let browser, page;
try {
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  record.browser = await browser.version();
  const context = await browser.newContext({ viewport: { width: 440, height: 768 }, colorScheme: 'dark' });
  await context.addInitScript(state => {
    window.__fixtureState = state; window.__requests = []; window.__acquisitions = 0; window.__mode = 'normal';
    window.__push = next => { window.__fixtureState = structuredClone(next); window.postMessage({ schemaVersion: 1, type: 'state', state: next }, '*'); };
    window.acquireVsCodeApi = () => {
      window.__acquisitions++;
      return {
        getState: () => JSON.parse(sessionStorage.getItem('workbench-view') ?? '{"draft":"Retained local draft"}'),
        setState: value => sessionStorage.setItem('workbench-view', JSON.stringify(value)),
        postMessage: message => {
          window.__requests.push(message);
          if (message.type === 'ready') setTimeout(() => window.__push(window.__fixtureState), 0);
          if (message.type === 'send') {
            const next = structuredClone(window.__fixtureState); next.loading = true; next.error = null; window.__push(next);
            if (window.__mode === 'hold') return;
            setTimeout(() => {
              const accepted = structuredClone(window.__fixtureState); accepted.loading = false;
              if (window.__mode === 'error') accepted.error = 'Synthetic provider unavailable. The draft was preserved.';
              else { accepted.task.messages.push({ messageId: crypto.randomUUID(), role: 'user', text: message.payload.userText, artifactRef: null, complete: true }); accepted.task.status = 'running'; accepted.task.providerOutcome = null; }
              window.__push(accepted);
            }, 150);
          }
        }
      };
    };
  }, fixture);
  page = await context.newPage(); const pageErrors = []; page.on('pageerror', error => pageErrors.push(String(error)));
  await page.goto(url); await page.getByRole('heading', { name: 'Agent', exact: true, level: 1 }).waitFor();
  await page.getByText('Distance sensor fixture · revision 4', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__acquisitions), 1);
  assert.equal(await page.getByLabel('Task or follow-up').inputValue(), 'Retained local draft');
  record.checks.push('single API acquisition and retained draft');

  await page.getByLabel('Task or follow-up').fill('Draft and focus survive observed updates'); await page.getByLabel('Task or follow-up').focus();
  await page.evaluate(() => { const next = structuredClone(window.__fixtureState); next.task.messages[1].text += '\nObserved response update.'; window.__push(next); });
  await page.waitForFunction(() => document.activeElement?.id === 'agent-message');
  assert.equal(await page.getByLabel('Task or follow-up').inputValue(), 'Draft and focus survive observed updates');
  await page.evaluate(() => { const invalid = structuredClone(window.__fixtureState); invalid.task.status = 'complete'; invalid.project.name = 'INVALID STATE'; window.postMessage({ schemaVersion: 1, type: 'state', state: invalid }, '*'); });
  assert.equal(await page.getByText('INVALID STATE', { exact: false }).count(), 0);
  await page.evaluate(() => { const next = structuredClone(window.__fixtureState); next.task.messages[1].text = '<img src=x onerror="window.__injected=true"><script>window.__injected=true</script>'; window.__push(next); });
  await page.getByText('<img src=x onerror="window.__injected=true"><script>window.__injected=true</script>', { exact: true }).waitFor();
  assert.equal(await page.locator('main script, main img').count(), 0); assert.equal(await page.evaluate(() => window.__injected ?? false), false);
  await page.evaluate(state => window.__push(state), fixture);
  record.checks.push('validated incoming state, inert malicious prose, retained focus and draft');

  await page.getByRole('button', { name: 'Context (3)', exact: true }).click();
  for (const name of ['Pinned', 'Supplied this turn', 'Observed retrieval', 'Available', 'Stale / unresolved']) await page.getByRole('heading', { name, exact: true }).waitFor();
  await page.getByRole('button', { name: 'Front range sensor', exact: true }).first().click();
  await page.getByRole('button', { name: 'Unpin', exact: true }).first().click();
  await page.screenshot({ path: join(evidenceRoot, 'context-dark.png'), fullPage: true }); record.screenshots.push('context-dark.png');
  await page.getByRole('button', { name: 'Changes (2)', exact: true }).click();
  await page.getByRole('button', { name: 'Keep edits', exact: true }).click();
  await page.getByRole('button', { name: 'Apply proposal', exact: true }).click();
  assert.equal((await page.evaluate(() => window.__requests)).some(item => item.type === 'authorizeUpload'), false);
  await page.screenshot({ path: join(evidenceRoot, 'review-dark.png'), fullPage: true }); record.screenshots.push('review-dark.png');
  record.checks.push('context facets and stable source/pin intents; proposed versus written review without upload');

  await page.getByRole('button', { name: 'Conversation', exact: true }).click();
  await page.getByLabel('Task or follow-up').fill('First line'); await page.getByLabel('Task or follow-up').press('Enter');
  assert.equal(await page.getByLabel('Task or follow-up').inputValue(), 'First line\n');
  assert.equal((await page.evaluate(() => window.__requests)).filter(item => item.type === 'send').length, 0);
  await page.evaluate(() => {
    const next = structuredClone(window.__fixtureState); next.task.status = 'awaiting-input';
    next.task.pendingApprovals = [{ approvalId: '77777777-7777-4777-8777-777777777777', providerRequestId: 'synthetic-approval', turn: { clientTurnId: '88888888-8888-4888-8888-888888888888', session: { providerId: 'codex', projectId: next.project.projectId, taskId: next.task.taskId, providerSessionId: 'synthetic-session', workspaceUri: 'file:///C:/synthetic/' }, providerTurnId: 'synthetic-turn' }, action: 'Read fixture', targetSummary: 'C:/synthetic/Probe.ino', expectedProjectRevision: next.project.projectRevision, deviceId: null, artifactSha256: null, permittedScopes: ['once'], expiresAt: new Date(Date.now() + 60000).toISOString() }];
    window.__push(next);
  });
  await page.getByRole('button', { name: 'Allow once', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Deny', exact: true }).click();
  assert.ok((await page.evaluate(() => window.__requests)).some(item => item.type === 'approval' && item.payload.decision === 'deny'));
  await page.evaluate(() => { const next = structuredClone(window.__fixtureState); next.task.pendingApprovals[0].expectedProjectRevision--; window.__push(next); });
  await page.getByText('Revision 3 · one-time response · expired or stale', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Allow once', exact: true }).isDisabled(), true);
  await page.evaluate(state => { state.task.status = 'running'; state.providers[0].capabilities = []; window.__push(state); }, fixture);
  await page.waitForFunction(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Stop agent')?.disabled === true);
  assert.equal(await page.getByRole('button', { name: 'Stop agent', exact: true }).isDisabled(), true);
  await page.evaluate(state => { state.task.status = 'running'; state.providers[0].capabilities = ['interrupt']; window.__push(state); }, fixture);
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Stop agent' && !button.disabled));
  await page.getByRole('button', { name: 'Stop agent', exact: true }).focus();
  await page.evaluate(state => window.__push(state), fixture);
  await page.waitForFunction(() => document.activeElement === document.querySelector('.task-details summary'));
  record.checks.push('Enter remains multiline, approval and interruption remain capability-scoped, and focus recovers after Stop disappears');
  await page.locator('.route-settings > summary').click();
  await page.getByLabel('Model', { exact: true }).fill('fixture-model');
  await page.getByLabel('Task or follow-up').fill('Only one logical request');
  await page.getByRole('button', { name: 'Send', exact: true }).evaluate(button => { button.click(); button.click(); });
  await page.waitForFunction(() => window.__requests.filter(item => item.type === 'send').length === 1);
  await page.waitForFunction(() => document.getElementById('agent-message').value === '');
  assert.equal((await page.evaluate(() => window.__requests)).filter(item => item.type === 'send').length, 1);
  await page.evaluate(state => { window.__mode = 'error'; window.__push(state); }, fixture);
  await page.getByLabel('Task or follow-up').fill('Failure preserves this draft');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('Synthetic provider unavailable. The draft was preserved.', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Task or follow-up').inputValue(), 'Failure preserves this draft');
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Send' && !button.disabled));
  record.checks.push('double submission suppressed; accepted draft clears only after attribution; failed send preserves draft');
  await page.evaluate(state => { window.__mode = 'normal'; window.__push(state); }, fixture);
  await page.evaluate(() => { window.__mode = 'hold'; });
  const repeatedPrompt = fixture.task.messages[0].text;
  await page.getByLabel('Task or follow-up').fill(repeatedPrompt); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('Refreshing retained state…', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Task or follow-up').inputValue(), repeatedPrompt);
  await page.evaluate(text => { const next = structuredClone(window.__fixtureState); next.loading = false; next.task.messages.push({ messageId: crypto.randomUUID(), role: 'user', text, artifactRef: null, complete: true }); window.__push(next); }, repeatedPrompt);
  await page.waitForFunction(() => document.getElementById('agent-message').value === '');
  await page.evaluate(state => { window.__mode = 'normal'; window.__push(state); }, fixture);
  await page.evaluate(() => { window.__mode = 'hold'; });
  await page.getByLabel('Task or follow-up').fill('Submitted first');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('Refreshing retained state…', { exact: true }).waitFor();
  await page.getByLabel('Task or follow-up').fill('Follow-up written during submission');
  await page.evaluate(() => {
    const next = structuredClone(window.__fixtureState);
    next.loading = false;
    next.task.messages.push({ messageId: crypto.randomUUID(), role: 'user', text: 'Submitted first', artifactRef: null, complete: true });
    window.__push(next);
  });
  await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Task or follow-up').inputValue(), 'Follow-up written during submission');
  await page.evaluate(state => { window.__mode = 'normal'; window.__push(state); }, fixture);
  await page.getByLabel('Task or follow-up').fill('Failure preserves this draft');
  record.checks.push('repeated prompt waits for a new attributable message and acknowledgment preserves a newer draft');

  const taskDetails = page.getByText('Task details and actions', { exact: true });
  const tools = page.locator('.task-tools');
  await taskDetails.click();
  assert.equal(await tools.evaluate(element => getComputedStyle(element).animationDuration), '0.12s');
  await taskDetails.click();
  await page.evaluate(() => document.body.classList.add('vscode-reduce-motion'));
  await taskDetails.click();
  assert.equal(await tools.evaluate(element => getComputedStyle(element).animationName), 'none');
  await page.evaluate(() => document.body.classList.remove('vscode-reduce-motion'));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await tools.evaluate(element => getComputedStyle(element).animationName), 'none');
  await taskDetails.click();
  record.checks.push('task disclosure uses a brief transition and honors host and browser reduced motion');

  const screenshots = async (theme, width = 440, height = 768, zoom = false) => {
    await page.setViewportSize({ width, height }); await page.emulateMedia({ colorScheme: theme === 'light' ? 'light' : 'dark', forcedColors: theme === 'contrast' ? 'active' : 'none', reducedMotion: 'reduce' });
    await page.evaluate(({ theme, zoom }) => { document.documentElement.dataset.theme = theme; document.documentElement.style.setProperty('--vscode-font-size', zoom ? '26px' : '13px'); document.querySelector('.route-settings').open = false; document.querySelector('.agent-app').scrollTop = 0; document.querySelector('.content').scrollTop = 0; window.scrollTo(0, 0); }, { theme, zoom });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${theme} ${width}px horizontal overflow`);
    const filename = `${theme}-${width}${zoom ? '-font200' : ''}.png`; await page.screenshot({ path: join(evidenceRoot, filename), fullPage: true }); record.screenshots.push(filename);
    if (width === 440 && !zoom) for (const [screen, label] of [['S02-agent', /^Conversation$/], ['S03-context', /^Context \(/], ['S06-review', /^Changes \(/]]) { await page.getByRole('button', { name: label }).click(); (record.contrast ??= []).push(await auditContrast(page, theme, screen)); }
    const colors = await page.evaluate(() => { const body = getComputedStyle(document.body), meta = getComputedStyle(document.querySelector('.meta')); return { background: body.backgroundColor, foreground: body.color, secondary: meta.color }; });
    const luminance = color => { const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => { const v = value / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722; };
    const contrast = color => { const a = luminance(color), b = luminance(colors.background); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); };
    assert.ok(contrast(colors.foreground) >= 4.5); assert.ok(contrast(colors.secondary) >= 4.5); record.checks.push(`${theme}/${width}${zoom ? '/font200' : ''}: reflow and primary/secondary text contrast >=4.5`);
  };
  await screenshots('dark'); await screenshots('light'); await screenshots('contrast'); await screenshots('dark', 320); await screenshots('light', 683, 384, true);
  await page.setViewportSize({ width: 440, height: 768 });
  await page.evaluate(() => { document.documentElement.style.setProperty('--vscode-font-size', '13px'); });
  await page.getByRole('button', { name: 'Refresh', exact: true }).focus();
  await page.keyboard.press('Tab');
  assert.ok(await page.evaluate(() => document.activeElement?.tagName !== 'BODY'));
  const focus = await page.evaluate(() => { const style = getComputedStyle(document.activeElement); return { width: style.outlineWidth, style: style.outlineStyle }; });
  assert.equal(focus.width, '2px'); assert.equal(focus.style, 'solid');
  assert.ok(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches));
  record.checks.push('keyboard focus outline and reduced-motion preference');
  const requests = await page.evaluate(() => window.__requests); assert.ok(requests.every(request => isWorkbenchViewRequest(request)));
  record.requestCounts = Object.fromEntries([...new Set(requests.map(request => request.type))].map(type => [type, requests.filter(request => request.type === type).length]));
  await page.getByRole('button', { name: /^Context \(/ }).click();
  await page.reload(); await page.getByText('Distance sensor fixture · revision 4', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Task or follow-up').inputValue(), 'Failure preserves this draft');
  await page.getByRole('heading', { name: 'Context inspector', exact: true }).waitFor();
  record.checks.push('agent view and composer draft restore after webview reload');
  await page.evaluate(state => window.__push(state), fixture);
  const timing = [];
  for (let index = 0; index < 30; index++) {
    await page.getByRole('button', { name: 'Conversation', exact: true }).click();
    timing.push(await page.evaluate(async () => {
      const button = [...document.querySelectorAll('.tabs button')].find(item => item.textContent.startsWith('Context ('));
      const start = performance.now(); button.click();
      while (button.getAttribute('aria-current') !== 'page') { if (performance.now() - start > 2000) throw Error('Context feedback did not render'); await new Promise(requestAnimationFrame); }
      const feedbackMs = performance.now() - start;
      while (document.querySelector('.content h2')?.textContent !== 'Context inspector' || !document.querySelector('.project-header').textContent.includes('revision 4')) { if (performance.now() - start > 2000) throw Error('Revision-bound context did not render'); await new Promise(requestAnimationFrame); }
      await new Promise(requestAnimationFrame);
      return { feedbackMs, contextMs: performance.now() - start };
    }));
  }
  const p95 = key => timing.map(item => item[key]).sort((a, b) => a - b)[Math.ceil(timing.length * .95) - 1];
  record.renderTiming = { workload: '30 warm local context-tab activations; three cached evidence items; expected revision 4', sampling: 'Browser performance.now before click until matching DOM/next rendering frame, excludes automation transport time', samples: timing, p95FeedbackMs: p95('feedbackMs'), p95ContextMs: p95('contextMs'), budgets: { feedbackMs: 150, contextMs: 250 }, limitation: 'Synthetic browser fixture; native host/provider/IPC latency is separate.' };
  assert.ok(record.renderTiming.p95FeedbackMs <= 150); assert.ok(record.renderTiming.p95ContextMs <= 250);
  await page.setViewportSize({ width: 1000, height: 768 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.style.setProperty('--vscode-font-size', '13px'); });
  for (const scenario of ['ready', 'loading', 'empty', 'unavailable', 'error', 'stale']) {
    const value = structuredClone(fixture);
    if (scenario === 'loading') value.loading = true;
    if (scenario === 'empty') { value.tasks = []; value.task = null; value.context = []; value.changes = []; value.operations = []; }
    if (scenario === 'unavailable') { value.trusted = false; value.providers.forEach(item => { item.readiness = 'unavailable'; }); }
    if (scenario === 'error') value.error = 'Synthetic provider failure; retained transcript and edits remain available.';
    if (scenario === 'stale') { value.task.problem = 'Historical source and evidence require reconciliation.'; value.context.forEach(item => { if (!item.facets.includes('stale')) item.facets.push('stale'); }); value.changes[0].effect = 'conflicted'; value.changes[0].summary = 'Independent user edit preserved; compare retained versions before acceptance.'; }
    assert.ok(isWorkbenchViewState(value)); await page.evaluate(state => window.__push(state), value);
    for (const [screen, label, heading] of [['S02', /^Conversation$/, 'Conversation'], ['S03', /^Context \(/, 'Context inspector'], ['S06', /^Changes \(/, 'Task changes']]) {
      await page.getByRole('button', { name: label }).click(); await page.getByRole('heading', { name: heading, exact: true }).waitFor();
      if (scenario === 'loading') await page.getByText('Refreshing retained state…', { exact: true }).waitFor();
      if (scenario === 'error') await page.getByRole('alert').waitFor();
      if (scenario === 'unavailable') await page.getByText(/Restricted Mode:/).waitFor();
      if (scenario === 'error') for (const theme of ['dark', 'light', 'contrast']) { await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme); (record.contrast ??= []).push(await auditContrast(page, theme, `${screen}-error`)); }
      await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
      const name = `${screen}-${scenario}.png`; await page.screenshot({ path: join(evidenceRoot, name), fullPage: true }); record.screenshots.push(name);
    }
  }
  record.checks.push('S02/S03/S06 validated ready/loading/empty/unavailable/error/stale fixtures retained as screenshots; 30 warm rendered-feedback/context samples');
  assert.deepEqual(pageErrors, []); record.status = 'passed'; record.endedAt = new Date().toISOString();
  record.bundleSha256 = createHash('sha256').update(await readFile(join(artifactRoot, 'agent.js'))).digest('hex');
  record.stylesheetSha256 = createHash('sha256').update(await readFile(join(artifactRoot, 'agent.css'))).digest('hex');
} catch (error) {
  record.status = 'failed'; record.error = error.stack ?? String(error); process.exitCode = 1;
  if (page) await page.screenshot({ path: join(evidenceRoot, 'failure.png'), fullPage: true }).catch(() => {});
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); await writeFile(join(evidenceRoot, 'result.json'), JSON.stringify(record, null, 2) + '\n'); }
console.log(JSON.stringify({ status: record.status, checks: record.checks.length, error: record.error, screenshots: record.screenshots }));
