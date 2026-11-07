import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, relative, sep, isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { artifact, compatibilityMatrix, json, licenseInventory, releaseContext, validateReleaseRecord } from './release-record.mjs';

const { values } = parseArgs({ options: { output: { type: 'string' }, vsix: { type: 'string' }, 'test-report': { type: 'string', default: 'verification/task-12.json' }, 'compatibility-matrix': { type: 'string' } } });
const root = realpathSync('.'), output = values.output;
if (!output?.startsWith('verification/') || output.includes('\\') || output.split('/').some(part => !part || part === '.' || part === '..' || /[:\x00-\x1f]/.test(part))) throw Error('Choose a new normalized directory under verification/.');
const destination = resolve(root, output), scoped = relative(root, destination);
if (!scoped || scoped.startsWith(`..${sep}`) || isAbsolute(scoped) || existsSync(destination)) throw Error('Release output must be a new repository-local directory; existing files are preserved.');
let ancestor = destination; while (!existsSync(ancestor)) ancestor = resolve(ancestor, '..');
if (realpathSync(ancestor) !== ancestor || lstatSync(ancestor).isSymbolicLink()) throw Error('Release output cannot traverse links.');
const extension = json(root, 'apps/extension/package.json'), vsix = values.vsix ?? `artifacts/robotics-workbench-${extension.version}.vsix`;
const context = releaseContext(root, vsix), licenses = licenseInventory(root), matrix = values['compatibility-matrix'] ? json(root, values['compatibility-matrix']) : compatibilityMatrix(root, extension.version, licenses);
const native = json(root, 'apps/extension/dist/native-runtime.json');
const runtime = ['extension.js', 'companion.js', 'mcp-stdio.js', 'documents-worker.cjs', 'telemetry-worker.cjs', 'THIRD-PARTY-NOTICES.txt', 'native-runtime.json', ...native.files.filter(file => file.path.endsWith('.node')).map(file => file.path)];
mkdirSync(destination, { recursive: true });
for (const [name, body] of [['inspection.json', context.inspection], ['compatibility.json', matrix], ['licenses.json', licenses]]) writeFileSync(resolve(destination, name), JSON.stringify(body, null, 2) + '\n', { flag: 'wx' });
const record = { schemaVersion: 1, releaseVersion: extension.version, target: 'win32-x64', status: 'draft', createdAt: new Date().toISOString(), ...context.source,
  vsix: artifact(root, vsix), vsixSha256: context.inspection.sha256, packageInspection: artifact(root, `${output}/inspection.json`), compatibilityMatrix: artifact(root, `${output}/compatibility.json`), licenseInventory: artifact(root, `${output}/licenses.json`),
  testReport: existsSync(resolve(root, values['test-report'])) ? artifact(root, values['test-report']) : null,
  traceability: artifact(root, 'verification/traceability.json'), testCatalog: artifact(root, 'verification/test-catalog.json'), lockfile: artifact(root, 'package-lock.json'), buildLicenseInventory: artifact(root, 'artifacts/license-inventory.json'),
  runtimeArtifacts: runtime.map(name => artifact(root, `apps/extension/dist/${name}`)), migrationFrom: [],
  knownLimitations: ['This generated draft is not complete-release acceptance.', ...matrix.limitations ?? [], 'Vendor support and manual accessibility remain separate from observed local execution.'] };
record.blockers = validateReleaseRecord(record, context); record.status = record.blockers.length ? 'blocked' : 'draft';
writeFileSync(resolve(destination, 'release.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ record: `${output}/release.json`, status: record.status, blockers: record.blockers }, null, 2));
