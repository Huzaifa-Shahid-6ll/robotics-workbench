import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';

const root = resolve('artifacts/task10-cad-actual/13494b10-37aa-4bcc-b868-f3230c0da1d6');
const source = JSON.parse(await readFile(join(root, 'evidence.json'))), operation = source.good;
assert.ok(operation); const artifact = operation.artifacts.find(item => item.mediaType === 'model/step'); assert.ok(artifact);
const step = join(root, 'data', artifact.relativePath), sha = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha(await readFile(step)), artifact.sha256);
const runId = randomUUID(), evidence = resolve(`verification/evidence/task-10/viewer/${runId}`); await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } }), errors = [], remoteRequests = [];
page.on('pageerror', error => errors.push(String(error))); page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:3949/') && !request.url().startsWith('data:')) remoteRequests.push(request.url()); });
try {
  await page.goto('http://127.0.0.1:3949/', { waitUntil: 'networkidle', timeout: 60000 });
  await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 60000 });
  const python = resolve('artifacts/task10-tools/viewer-env/Scripts/python.exe');
  const code = 'import sys,json,importlib.metadata\nimport cadquery as cq\nfrom ocp_viewer import show,save_screenshot,Camera\nshape=cq.importers.importStep(sys.argv[1])\nassert shape.val().isValid()\nshow(shape,port=3949,reset_camera=Camera.RESET,names=["Retained TASK-10 design-choice box"])\nsave_screenshot(sys.argv[2],port=3949,timeout_s=30)\nprint(json.dumps({"ocp_viewer":importlib.metadata.version("ocp_viewer"),"cadquery":cq.__version__,"shapeValid":True}))';
  const result = await promisify(execFile)(python, ['-I', '-c', code, step, join(evidence, 'model.png')], { windowsHide: true, timeout: 300000, maxBuffer: 1024*1024, env: { ...process.env, USERPROFILE: resolve('artifacts/task10-tools/viewer-profile'), TEMP: resolve('artifacts/tmp'), TMP: resolve('artifacts/tmp') } });
  await writeFile(join(evidence, 'python.log'), result.stdout + result.stderr);
  assert.ok((await stat(join(evidence, 'model.png'))).size > 1000); assert.equal(errors.length, 0);
  await page.screenshot({ path: join(evidence, 'viewer.png') });
  const report = { schemaVersion: 1, runId, status: 'passed', evidenceClass: 'actual-independent-public-viewer', sourceOperationId: operation.operationId, stepSha256: artifact.sha256, workflow: 'OCP Viewer documented standalone CLI and Python show/save_screenshot, not a private VS Code command', remoteRequests, pageErrors: errors, pngSha256: sha(await readFile(join(evidence,'model.png'))), limitations: ['Viewer display proves rendering of these exact STEP bytes, not physical fit, strength or manufacturability.', 'Standalone viewer environment reads pinned CAD environment dependencies through an explicit local .pth; no global Python environment or VS Code viewer extension was changed.'] };
  await writeFile(join(evidence, 'result.json'), JSON.stringify(report,null,2)+'\n'); console.log(evidence);
} catch(error) { await writeFile(join(evidence, 'failure.json'), JSON.stringify({status:'failed',error:String(error),errors,remoteRequests},null,2)); throw error; }
finally { await browser.close(); }
