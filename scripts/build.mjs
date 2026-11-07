import { build } from 'esbuild';
import { mkdir, readdir, copyFile, writeFile, glob } from 'node:fs/promises';
import { stageNativeRuntime } from './native-runtime.mjs';

await mkdir('apps/extension/dist/schemas', { recursive: true });
const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node24', sourcemap: false, logLevel: 'info' };
const extension = await build({ ...common, entryPoints: ['apps/extension/src/extension.ts'], outfile: 'apps/extension/dist/extension.js', external: ['vscode'], metafile: true });
const companion = await build({ ...common, entryPoints: ['apps/companion/src/main.ts'], outfile: 'apps/extension/dist/companion.js', metafile: true });
const mcp = await build({ ...common, entryPoints: ['apps/companion/src/mcp-stdio.ts'], outfile: 'apps/extension/dist/mcp-stdio.js', metafile: true });
const agent = await build({ bundle: true, platform: 'browser', format: 'iife', target: 'es2022', entryPoints: ['packages/webviews/src/agent.tsx'], outfile: 'apps/extension/dist/agent.js', metafile: true, minify: true, logLevel: 'info', define: { 'process.env.NODE_ENV': '"production"' } });
const wiring = await build({ bundle: true, platform: 'browser', format: 'iife', target: 'es2022', entryPoints: ['packages/webviews/src/wiring.tsx'], outfile: 'apps/extension/dist/wiring.js', metafile: true, minify: true, logLevel: 'info', define: { 'process.env.NODE_ENV': '"production"' } });
const documents = await build({ bundle: true, platform: 'browser', format: 'iife', target: 'es2022', entryPoints: ['packages/webviews/src/documents.tsx'], outfile: 'apps/extension/dist/documents.js', metafile: true, minify: true, logLevel: 'info', define: { 'process.env.NODE_ENV': '"production"' } });
const documentWorker = await build({ ...common, entryPoints: ['packages/adapters/documents/src/worker.ts'], outfile: 'apps/extension/dist/documents-worker.cjs', external: ['pdfjs-dist/*', '@napi-rs/canvas'], metafile: true });
const telemetry = await build({ bundle: true, platform: 'browser', format: 'iife', target: 'es2022', entryPoints: ['packages/webviews/src/telemetry.tsx'], outfile: 'apps/extension/dist/telemetry.js', metafile: true, minify: true, logLevel: 'info', define: { 'process.env.NODE_ENV': '"production"' } });
const telemetryWorker = await build({ ...common, entryPoints: ['apps/companion/src/telemetry-worker.ts'], outfile: 'apps/extension/dist/telemetry-worker.cjs', metafile: true });
const engineering = await build({ bundle: true, platform: 'browser', format: 'iife', target: 'es2022', entryPoints: ['packages/webviews/src/engineering.tsx'], outfile: 'apps/extension/dist/engineering.js', metafile: true, minify: true, logLevel: 'info', define: { 'process.env.NODE_ENV': '"production"' } });
await copyFile('packages/adapters/cad/src/runner.py', 'apps/extension/dist/cad-runner.py');
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/bundle-inputs.json', JSON.stringify([...new Set([...Object.keys(extension.metafile.inputs), ...Object.keys(companion.metafile.inputs), ...Object.keys(mcp.metafile.inputs), ...Object.keys(agent.metafile.inputs), ...Object.keys(wiring.metafile.inputs), ...Object.keys(documents.metafile.inputs), ...Object.keys(documentWorker.metafile.inputs), ...Object.keys(telemetry.metafile.inputs), ...Object.keys(telemetryWorker.metafile.inputs), ...Object.keys(engineering.metafile.inputs)])], null, 2));
await build({ ...common, entryPoints: ['apps/extension/test/host.ts'], outfile: 'artifacts/host-tests.cjs', external: ['vscode'] });
const tests = [];
for await (const file of glob(['packages/**/test/*.test.ts', 'apps/**/test/*.test.ts'], { exclude: ['**/node_modules/**', '**/dist/**'] })) tests.push(file);
// Bound concurrent test linking to avoid exhausting Windows commit memory.
tests.sort();
const testBatchSize = 8;
for (let offset = 0; offset < tests.length; offset += testBatchSize) {
  await build({ ...common, entryPoints: tests.slice(offset, offset + testBatchSize), external: ['vscode'], outdir: 'artifacts/tests', outbase: '.', entryNames: '[dir]/[name]', outExtension: { '.js': '.cjs' } });
}
await copyFile('apps/extension/dist/telemetry-worker.cjs', 'artifacts/tests/apps/companion/test/telemetry-worker.cjs');
await copyFile('packages/adapters/cad/src/runner.py', 'artifacts/tests/apps/companion/test/cad-runner.py');
await build({ ...common, entryPoints: ['apps/companion/test/seed-telemetry.ts'], outfile: 'artifacts/task09-seed.cjs' });
await build({ ...common, entryPoints: ['apps/companion/test/seed-engineering.ts'], outfile: 'artifacts/task10-seed.cjs' });
const fixtures = [];
for await (const file of glob('packages/test-fixtures/**/crash-worker.ts')) fixtures.push(file);
if (fixtures.length) await build({ ...common, entryPoints: fixtures, outdir: 'artifacts/fixtures', entryNames: 'task02-crash', outExtension: { '.js': '.cjs' } });
for (const name of await readdir('contracts')) {
  if (name.endsWith('.schema.json')) await copyFile(`contracts/${name}`, `apps/extension/dist/schemas/${name}`);
}
await stageNativeRuntime();
