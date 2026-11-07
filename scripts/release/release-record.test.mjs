import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { artifact, localFile, sha256, sourceIdentity, validateReleaseRecord } from './release-record.mjs';

function fixture(t) {
  const parent = resolve('artifacts/task12-release-tests'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'synthetic-')); t.after(() => { assert.equal(dirname(realpathSync(root)), realpathSync(parent)); rmSync(root, { recursive: true, force: true }); });
  const write = (path, value) => { const full = join(root, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, typeof value === 'string' ? value : JSON.stringify(value)); return artifact(root, path); };
  const source = { sourceCommit: 'a'.repeat(40), sourceDigest: 'b'.repeat(64), sourceDigestScope: 'Explicit synthetic unit fixture; no release or compatibility claim.', sourceDirty: false };
  const environment = { platform: 'win32', release: 'synthetic', arch: 'x64' }, startedAt = '2026-11-04T01:00:00.000Z', endedAt = '2026-11-04T01:00:01.000Z';
  const classes = ['document', 'software', 'packaged-windows', 'real-hardware', 'live-provider', 'manual-ui'];
  const evidence = classes.map(evidenceClass => {
    const testId = `synthetic.${evidenceClass}`, ref = write(`verification/${evidenceClass}.json`, { testId, result: 'passed', evidenceClass, fixture: 'Explicit synthetic validator test only' });
    return { ...ref, testId, evidenceClass, runId: 'synthetic-run', sourceDigest: source.sourceDigest, appVersion: '0.1.0', environment, dependencyVersions: { fixture: '1' }, startedAt, endedAt, result: 'passed' };
  });
  const catalog = { tests: evidence.map(({ testId, evidenceClass }) => ({ testId, evidenceClass })) };
  const ledger = { requirements: [{ requirementId: 'REQ-HW-02', acceptanceCriteria: ['AC-D49-01'], implementationOwners: ['TASK-12'], implementationPaths: ['apps/extension/dist/companion.js'], testIds: evidence.map(row => row.testId), verificationStatus: 'passed', evidence }] };
  const context = { root, requirements: ['REQ-HW-02'], acceptance: ['AC-D49-01'], owners: ['TASK-12'], requiredEvidenceClasses: { 'REQ-HW-02': ['software', 'real-hardware'] }, releaseAcceptance: ['AC-D49-01'] };
  const nativeFiles = ['vendor/native/@serialport+bindings-cpp.node', 'vendor/native/skia.win32-x64-msvc.node'].map(path => ({ path, sha256: write(`apps/extension/dist/${path}`, `synthetic ${path}`).sha256 }));
  const native = { schemaVersion: 1, target: 'win32-x64', files: nativeFiles, packages: [{ name: 'synthetic-native', version: '1' }] };
  const runtimeNames = ['extension.js', 'companion.js', 'mcp-stdio.js', 'documents-worker.cjs', 'telemetry-worker.cjs', 'THIRD-PARTY-NOTICES.txt'];
  const runtimeArtifacts = runtimeNames.map(name => write(`apps/extension/dist/${name}`, `synthetic ${name}`));
  runtimeArtifacts.push(write('apps/extension/dist/native-runtime.json', native), ...nativeFiles.map(file => artifact(root, `apps/extension/dist/${file.path}`)));
  const vsix = write('artifacts/synthetic.vsix', 'Not a real ZIP; inspection is an explicitly injected synthetic unit fixture.');
  const inspection = { passed: true, sha256: vsix.sha256, target: 'win32-x64', extension: { version: '0.1.0', name: 'robotics-workbench', publisher: 'local-workbench' }, fixture: true };
  const policy = write('verification/vendor-support.json', { result: 'passed', vendorSupport: 'verified-supported', observed: { version: 'synthetic' }, sources: [{ url: 'https://nodejs.org/docs/latest-v24.x/api/process.html' }], fixture: 'Synthetic policy context only; this does not assert vendor support.' });
  const matrix = { schemaVersion: 1, releaseVersion: '0.1.0', target: 'win32-x64', runtimeStrategy: 'detected-external-node-24', locallyObserved: { platform: 'win32', arch: 'x64', node: 'v24.18.0', nodeModuleAbi: '137', napi: '10', sqlite: '3.53.1', executableSha256: 'c'.repeat(64), osRelease: 'synthetic' }, vendorSupport: { assessment: 'verified-supported', evidence: [policy] }, observations: ['initial-compatible-host-and-provider-paths', 'arduino', 'avr-gcc', 'native-engineering', 'codex', 'opencode'].map(role => ({ role, evidence: policy })) };
  Object.assign(matrix.observations[0], { versions: { vscode: 'synthetic-1' } });
  Object.assign(matrix.observations[1], { version: 'synthetic-1', cores: [{ id: 'synthetic', version: '1' }] });
  Object.assign(matrix.observations[2], { packageVersionFromRecordedExecutablePath: 'synthetic-1' });
  Object.assign(matrix.observations[3], { kicad: { version: 'synthetic-1' }, python: { python: 'synthetic-1', packages: { cadquery: 'synthetic-1' } } });
  for (const row of matrix.observations.slice(4)) row.versions = { provider: 'synthetic-1', protocolFingerprint: 'a'.repeat(64) };
  const licenses = [{ name: 'synthetic-native', version: '1', license: 'MIT', bundled: true, licenseText: 'Synthetic license text', licenseTextSha256: sha256(Buffer.from('Synthetic license text')) }];
  const report = { taskId: 'TASK-12', appVersion: '0.1.0', ...source, vsix, acceptance: ['AC-D49-01'], remainingGates: [], checks: evidence.map(row => ({ ...row, commandOrProcedure: 'Synthetic validator fixture', evidence: { path: row.path, sha256: row.sha256, sizeBytes: row.sizeBytes }, acceptanceCriteria: ['AC-D49-01'] })) };
  const record = { schemaVersion: 1, releaseVersion: '0.1.0', target: 'win32-x64', status: 'draft', createdAt: startedAt, ...source, vsix, vsixSha256: vsix.sha256,
    packageInspection: write('verification/inspection.json', inspection), compatibilityMatrix: write('verification/compatibility.json', matrix), licenseInventory: write('verification/licenses.json', licenses),
    testReport: write('verification/task-12.json', report), traceability: write('verification/traceability.json', ledger), testCatalog: write('verification/catalog.json', catalog), lockfile: write('package-lock.json', { version: '0.1.0' }), buildLicenseInventory: write('artifacts/license-inventory.json', licenses), runtimeArtifacts, migrationFrom: [], knownLimitations: ['Synthetic test only'] };
  const check = value => validateReleaseRecord(value, { root, context, source, inspection });
  return { root, write, record, check, source, report, matrix, ledger, licenses, inspection };
}

test('explicit synthetic complete evidence context passes without accepting or publishing anything', t => {
  const f = fixture(t); assert.deepEqual(f.check(f.record), []); assert.equal(f.record.status, 'draft');
});

test('source identity survives evidence commits and detects implementation changes', t => {
  const f = fixture(t);
  const git = args => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', 'user.name=Release fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: f.root, windowsHide: true, encoding: 'utf8' });
  git(['init', '-q']); git(['add', '.']); git(['commit', '-qm', 'Synthetic implementation']);
  const first = sourceIdentity(f.root); assert.equal(first.sourceDirty, false);
  f.write('verification/extra-evidence.json', { synthetic: true }); git(['add', '.']); git(['commit', '-qm', 'Synthetic evidence']);
  assert.deepEqual(sourceIdentity(f.root), first);
  f.write('implementation.ts', 'export const changed = true;');
  const dirty = sourceIdentity(f.root); assert.equal(dirty.sourceDirty, true); assert.notEqual(dirty.sourceDigest, first.sourceDigest);
  git(['add', '.']); git(['commit', '-qm', 'Synthetic implementation change']);
  assert.notEqual(sourceIdentity(f.root).sourceCommit, first.sourceCommit);
});

test('missing requirements, remaining gates and declared but unbacked acceptance cannot pass', t => {
  const f = fixture(t);
  const checkReport = report => f.check({ ...f.record, testReport: f.write('verification/task-12.json', report) });
  assert.ok(checkReport({ ...f.report, remainingGates: ['Narrator unverified'] }).some(error => /remaining gates/.test(error)));
  assert.ok(checkReport({ ...f.report, checks: f.report.checks.filter(check => check.evidenceClass !== 'manual-ui') }).some(error => /manual-ui/.test(error)));
  assert.ok(checkReport({ ...f.report, acceptance: [] }).some(error => /AC-D49-01/.test(error)));
  const blocked = structuredClone(f.ledger); blocked.requirements[0].verificationStatus = 'not-run';
  assert.ok(f.check({ ...f.record, traceability: f.write('verification/traceability.json', blocked) }).some(error => /mandatory requirement/.test(error)));
});

test('mocked or failed result cannot be relabeled physical/manual/live proof', t => {
  const f = fixture(t), path = 'verification/real-hardware.json';
  for (const body of [{ result: 'passed', evidenceClass: 'software' }, { result: 'passed', evidenceClass: 'real-hardware', mocked: true }, { result: 'failed', evidenceClass: 'real-hardware' }]) {
    const changed = f.write(path, body), report = structuredClone(f.report), ledger = structuredClone(f.ledger);
    const check = report.checks.find(check => check.evidenceClass === 'real-hardware'); check.evidence = changed;
    Object.assign(ledger.requirements[0].evidence.find(row => row.evidenceClass === 'real-hardware'), changed);
    assert.ok(f.check({ ...f.record, testReport: f.write('verification/task-12.json', report), traceability: f.write('verification/traceability.json', ledger) }).some(error => /passing observation/.test(error)));
  }
});

test('checks require registered classes, run/version/environment/time metadata and exact artifacts', t => {
  const f = fixture(t);
  for (const mutate of [report => { report.checks[0].evidenceClass = 'real-hardware'; }, report => { delete report.checks[0].dependencyVersions; }, report => { report.checks[0].endedAt = 'invalid'; }, report => { report.checks[0].testId = 'invented'; }, report => { report.checks[0].evidence.sha256 = 'd'.repeat(64); }]) {
    const report = structuredClone(f.report); mutate(report);
    assert.ok(f.check({ ...f.record, testReport: f.write('verification/task-12.json', report) }).length);
  }
});

test('source/package/native/license identity changes block release', t => {
  const f = fixture(t);
  for (const record of [{ ...f.record, sourceDirty: true }, { ...f.record, sourceCommit: 'e'.repeat(40) }, { ...f.record, vsixSha256: 'e'.repeat(64) }, { ...f.record, runtimeArtifacts: [] }, { ...f.record, runtimeArtifacts: [...f.record.runtimeArtifacts, f.record.runtimeArtifacts[0]] }, { ...f.record, runtimeArtifacts: f.record.runtimeArtifacts.filter(row => !row.path.endsWith('.node')) }]) assert.ok(f.check(record).length);
  const licenses = structuredClone(f.licenses); licenses[0].licenseText += 'tamper';
  assert.ok(f.check({ ...f.record, licenseInventory: f.write('verification/tampered-licenses.json', licenses) }).some(error => /license/.test(error)));
  f.write('apps/extension/dist/companion.js', 'changed after packaging'); assert.ok(f.check(f.record).some(error => /digest/.test(error)));
});

test('observed Windows execution does not prove vendor support or current-version compatibility', t => {
  const f = fixture(t), matrix = structuredClone(f.matrix); matrix.vendorSupport = { assessment: 'not-verified' };
  assert.ok(f.check({ ...f.record, compatibilityMatrix: f.write('verification/compatibility.json', matrix) }).some(error => /vendor support/.test(error)));
  matrix.vendorSupport = f.matrix.vendorSupport; matrix.locallyObserved.node = 'v22.0.0';
  assert.ok(f.check({ ...f.record, compatibilityMatrix: f.write('verification/compatibility.json', matrix) }).some(error => /runtime/.test(error)));
  matrix.locallyObserved.node = 'v24.18.0'; matrix.vendorSupport = { assessment: 'verified-supported', evidence: [f.write('verification/blocked-vendor-support.json', { result: 'blocked', vendorSupport: 'not-verified', observed: { version: 'synthetic' }, sources: [{ url: 'https://nodejs.org/docs/latest-v24.x/api/process.html' }] })] };
  assert.ok(f.check({ ...f.record, compatibilityMatrix: f.write('verification/compatibility.json', matrix) }).some(error => /passing vendor support review/.test(error)));
});

test('malformed JSON shapes fail closed instead of crashing the validator', t => {
  const f = fixture(t);
  for (const value of [null, [], {}, { ...f.record, runtimeArtifacts: {} }, { ...f.record, compatibilityMatrix: f.write('verification/malformed-matrix.json', { ...f.matrix, observations: { some: 1 } }) }, { ...f.record, testReport: f.write('verification/malformed-report.json', { ...f.report, checks: [null] }) }, { ...f.record, licenseInventory: f.write('verification/malformed-license.json', [null]) }, { ...f.record, testCatalog: f.write('verification/malformed-catalog.json', { tests: [null] }) }]) assert.ok(f.check(value).length);
});

test('repository-relative artifact boundary refuses traversal, absolute paths and links', t => {
  const f = fixture(t);
  for (const path of ['../outside', '/absolute', 'C:/absolute', 'verification/../task-12.json', 'verification\\task-12.json']) assert.throws(() => localFile(f.root, path));
  const target = join(f.root, 'verification'), link = join(f.root, 'linked');
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); assert.throws(() => localFile(f.root, 'linked/task-12.json'), /Linked/);
});
