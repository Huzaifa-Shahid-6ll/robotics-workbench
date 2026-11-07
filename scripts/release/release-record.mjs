import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { release, version } from 'node:os';
import { projectContext, validateTraceability } from '../verification/validate-evidence.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value) && Number.isFinite(Date.parse(value));

export function localFile(root, path) {
  if (typeof path !== 'string' || !path || path.length > 2048 || isAbsolute(path) || path.includes('\\') || /[:\x00-\x1f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw Error('Expected a normalized repository-relative artifact path.');
  const base = realpathSync(root), file = resolve(base, path), actual = relative(base, realpathSync(file));
  if (!actual || actual === '..' || actual.startsWith(`..${sep}`) || isAbsolute(actual)) throw Error('Artifact leaves the repository.');
  let current = base;
  for (const part of path.split('/')) { current = join(current, part); if (lstatSync(current).isSymbolicLink()) throw Error('Linked release artifacts are refused.'); }
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 512 * 1024 * 1024) throw Error('Release artifact must be a bounded ordinary file.');
  return file;
}
export function artifact(root, path) { const bytes = readFileSync(localFile(root, path)); return { path, sha256: sha256(bytes), sizeBytes: bytes.length }; }
export function json(root, path) { const file = localFile(root, path); if (lstatSync(file).size > 4 * 1024 * 1024) throw Error('Release JSON exceeds 4 MiB.'); return JSON.parse(readFileSync(file, 'utf8')); }

export function sourceIdentity(root) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
  const relevant = path => path && !/^(verification|artifacts|dist)\//.test(path);
  const paths = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(relevant))].sort();
  const source = createHash('sha256');
  for (const path of paths) source.update(path + '\0').update(readFileSync(localFile(root, path)));
  const changed = [...git(['diff', '--name-only', '-z', 'HEAD']).split('\0'), ...git(['ls-files', '-z', '--others', '--exclude-standard']).split('\0')].filter(relevant);
  // Evidence-only commits must not invalidate the implementation revision they describe.
  const sourceCommit = git(['log', '-1', '--format=%H', '--', '.', ':(exclude)verification', ':(exclude)artifacts', ':(exclude)dist']).trim();
  return { sourceCommit, sourceDigest: source.digest('hex'), sourceDirty: changed.length > 0,
    sourceDigestScope: 'Sorted tracked/nonignored working-tree files excluding verification/artifacts/dist; path NUL followed by exact bytes.' };
}

export function inspectPackage(root, path) {
  const python = join(root, '.venv-validation/Scripts/python.exe');
  return JSON.parse(execFileSync(python, [join(root, 'scripts/release/inspect-package.py'), localFile(root, path)], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 2 * 1024 * 1024 }));
}

export function compatibilityMatrix(root, releaseVersion, licenses) {
  const lock = json(root, 'package-lock.json'), extension = json(root, 'apps/extension/package.json');
  const observed = [], add = (path, select) => { if (existsSync(resolve(root, path))) { const record = json(root, path); observed.push({ evidence: artifact(root, path), recordResult: record.result ?? record.status, observedAt: record.endedAt ?? record.recordedAt, currentness: 'historical-not-reprobed', ...select(record) }); } };
  add('verification/task-00-completion.json', record => ({ role: 'initial-compatible-host-and-provider-paths', environment: record.environment, versions: record.dependencyVersions }));
  add('verification/evidence/task-11/hardware/62f27e38-44b2-46d9-8994-fd5f4b4f7800/result.json', record => ({ role: 'arduino', version: record.toolchain.version, executableSha256: record.toolchain.executableSha256, cores: record.toolchain.cores,
    scope: 'Tool identity observed during passing upload/contention subchecks; overall run later failed a human-step timeout.' }));
  const compilerCommands = 'verification/evidence/task-11/hardware/62f27e38-44b2-46d9-8994-fd5f4b4f7800/data/work/7e985b33-68f9-4a03-a72b-fd7a0719f164/c53446ce-2e8c-4014-bdeb-7e8a13c3119f/build/compile_commands.json';
  add(compilerCommands, commands => ({ role: 'avr-gcc', packageVersionFromRecordedExecutablePath: commands[0]?.arguments?.[0]?.match(/avr-gcc[\\/]([^\\/]+)/)?.[1] ?? null,
    observedAt: json(root, 'verification/evidence/task-11/hardware/62f27e38-44b2-46d9-8994-fd5f4b4f7800/result.json').build.finishedAt,
    scope: 'Compiler package identity from the retained actual compile command; no new compiler execution or current binary-version claim.' }));
  add('verification/evidence/task-11/complete/0e823e4f-73c4-486f-8f7c-74d341664237/result.json', record => ({ role: 'native-engineering', kicad: { version: record.kicadGeneration.tool.version, executableSha256: record.tools.kicadSha256 },
    python: { ...record.tools.environment, executableSha256: record.tools.pythonSha256 }, scope: 'Retained native generation/reopen plus resumed recording/archive workflow; physical fit remains unknown.' }));
  for (const provider of ['codex', 'opencode']) add(`verification/evidence/task11/providers/70601b9c-1b0e-4900-ad9f-d11d32b4b75d/${provider}-1.json`, record => ({ role: provider, versions: record.dependencyVersions, scope: 'One referenced run in a passing three-repetition/provider suite; no current account or provider reprobe.' }));
  return { schemaVersion: 1, releaseVersion, target: 'win32-x64', recordedAt: new Date().toISOString(), runtimeStrategy: 'detected-external-node-24',
    locallyObserved: { os: version(), osRelease: release(), platform: process.platform, arch: process.arch, node: process.version, nodeModuleAbi: process.versions.modules, napi: process.versions.napi, sqlite: process.versions.sqlite,
      executablePath: realpathSync(process.execPath), executableSha256: sha256(readFileSync(process.execPath)), scope: 'Observed process identity only; native load/compatibility is established by separate packaged tests.' },
    vendorSupport: { assessment: 'not-verified', limitation: 'Successful local Windows execution is separate from current vendor OS-support policy; no supported-host claim is inferred.',
      evidence: existsSync(resolve(root, 'verification/evidence/task-12/vendor-support/review.json')) ? [artifact(root, 'verification/evidence/task-12/vendor-support/review.json')] : [],
      reviewedTargetContext: { target: 'Windows 10 Education 22H2 / build 19045', ordinaryServicingEnded: '2025-10-14', esuEligibilityAndVendorExtendedSupport: 'not-verified', reviewedAt: '2026-11-04',
        scope: 'Root primary-source review: VS Code defers to supported Windows client versions; Node 24.18 lists Windows 10 but excludes end-of-life platforms. No ESU eligibility or extended-support interpretation was established.',
        sources: ['https://code.visualstudio.com/docs/supporting/requirements', 'https://learn.microsoft.com/en-us/windows/release-health/supported-versions-windows-client', 'https://github.com/nodejs/node/blob/v24.18.0/BUILDING.md'] } },
    declaredHostEngine: extension.engines.vscode, lockfile: artifact(root, 'package-lock.json'),
    lockedPackages: Object.entries(lock.packages).filter(([, pkg]) => pkg.version).map(([path, pkg]) => ({ path, version: pkg.version, ...(pkg.integrity ? { integrity: pkg.integrity } : {}), development: pkg.dev === true })),
    bundledPackages: licenses.map(({ name, version, license, licenseTextSha256 }) => ({ name, version, license, licenseTextSha256 })), observations: observed,
    limitations: ['External tool observations retain their original date, result and scope; versions were not rediscovered during record generation.', 'No provider credentials, process environment dump, source, raw serial or provider transcripts are copied.'],
    documentation: [{ source: 'https://nodejs.org/docs/latest-v24.x/api/process.html', queriedWith: 'Context7', scope: 'process identity and ABI fields; not vendor OS-support assessment' }] };
}

export function licenseInventory(root) {
  return json(root, 'artifacts/license-inventory.json').map(pkg => {
    const file = existsSync(resolve(root, pkg.licensePath)) ? pkg.licensePath : `apps/extension/dist/${pkg.licensePath}`;
    const text = readFileSync(localFile(root, file), 'utf8');
    return { ...pkg, licenseText: text, licenseTextSha256: sha256(Buffer.from(text)), sourceLicense: artifact(root, file) };
  });
}

export function validateReleaseRecord(record, { root, context, source, inspection }) {
  const errors = [], fail = message => errors.push(message), documents = {};
  const ref = (value, label, readJson = false) => {
    try {
      if (!object(value) || !digest(value.sha256) || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0) throw Error('Invalid artifact reference.');
      const actual = artifact(root, value.path);
      if (actual.sha256 !== value.sha256 || actual.sizeBytes !== value.sizeBytes) throw Error('Artifact digest or size mismatch.');
      if (readJson) return json(root, value.path);
    } catch (error) { fail(`${label}: ${error.message}`); }
  };
  if (!object(record)) return ['Release record must be an object.'];
  const keys = ['schemaVersion', 'releaseVersion', 'target', 'status', 'createdAt', 'sourceCommit', 'sourceDigest', 'sourceDigestScope', 'sourceDirty', 'vsix', 'vsixSha256', 'packageInspection', 'compatibilityMatrix', 'licenseInventory', 'buildLicenseInventory', 'testReport', 'traceability', 'testCatalog', 'lockfile', 'runtimeArtifacts', 'migrationFrom', 'knownLimitations', 'blockers'];
  if (Object.keys(record).some(key => !keys.includes(key))) fail('Unknown release record field.');
  if (record.schemaVersion !== 1 || record.target !== 'win32-x64' || !['draft', 'blocked', 'accepted'].includes(record.status) || !/^\d+\.\d+\.\d+$/.test(record.releaseVersion ?? '') || !iso(record.createdAt)) fail('Unsupported or malformed release identity.');
  if (!/^[a-f0-9]{40}$/.test(record.sourceCommit ?? '') || !digest(record.sourceDigest) || !record.sourceDigestScope || typeof record.sourceDirty !== 'boolean') fail('Missing source identity.');
  if (record.sourceCommit !== source.sourceCommit || record.sourceDigest !== source.sourceDigest || record.sourceDirty || source.sourceDirty) fail('Source identity differs or implementation worktree is dirty.');
  for (const key of ['packageInspection', 'compatibilityMatrix', 'licenseInventory', 'buildLicenseInventory', 'testReport', 'traceability', 'testCatalog', 'lockfile']) documents[key] = ref(record[key], key, true);
  ref(record.vsix, 'vsix');
  if (!record.vsix?.path?.endsWith('.vsix') || record.vsixSha256 !== record.vsix?.sha256) fail('VSIX checksum/identity is inconsistent.');
  if (!Array.isArray(record.migrationFrom) || record.migrationFrom.some(value => !Number.isSafeInteger(value) || value < 1) || !Array.isArray(record.knownLimitations) || record.knownLimitations.some(value => typeof value !== 'string' || !value)) fail('Invalid migration/limitation record.');
  const report = documents.testReport, checks = Array.isArray(report?.checks) ? report.checks : [];
  if (!object(report) || report.taskId !== 'TASK-12' || report.appVersion !== record.releaseVersion || !Array.isArray(report.checks) || !report.checks.length || report.checks.some(check => check?.result !== 'passed') || !Array.isArray(report.remainingGates) || report.remainingGates.length) fail('TASK-12 report is missing, incomplete, failed or has remaining gates.');
  if (report?.sourceDigest !== record.sourceDigest || report?.sourceCommit !== record.sourceCommit || report?.vsix?.sha256 !== record.vsixSha256) fail('TASK-12 report does not identify this exact source and VSIX.');
  const registered = new Map((Array.isArray(documents.testCatalog?.tests) ? documents.testCatalog.tests : []).filter(object).map(test => [test.testId, test]));
  const observedProof = (evidence, evidenceClass, testId) => {
    if (!['real-hardware', 'live-provider', 'manual-ui'].includes(evidenceClass)) return;
    try {
      if (!evidence.path.endsWith('.json')) throw Error('Observed evidence requires a structured result.');
      const body = json(root, evidence.path), proof = [...(Array.isArray(body.checks) ? body.checks : []), ...(Array.isArray(body.runs) ? body.runs : [])].find(check => check.testId === testId) ?? body;
      if ((proof.result ?? proof.status) !== 'passed' || (proof.evidenceClass ?? body.evidenceClass) !== evidenceClass || proof.simulated === true || proof.mocked === true || body.simulated === true || body.mocked === true) throw Error('Referenced result is not a passing observation of its registered class.');
    } catch (error) { fail(`${testId}: ${error.message}`); }
  };
  for (const check of checks) {
    if (!object(check)) { fail('Malformed TASK-12 check.'); continue; }
    const test = registered.get(check.testId);
    if (!test || test.evidenceClass !== check.evidenceClass || !check.commandOrProcedure || !check.runId || !digest(check.sourceDigest) || !check.appVersion || !object(check.environment) || !Object.keys(check.environment).length || !object(check.dependencyVersions) || !Object.keys(check.dependencyVersions).length || !iso(check.startedAt) || !iso(check.endedAt) || Date.parse(check.endedAt) < Date.parse(check.startedAt)) fail(`TASK-12 check ${check.testId ?? 'unknown'} lacks registered class/run/source/environment/time metadata.`);
    ref(check.evidence, `TASK-12 check ${check.testId ?? 'unknown'}`);
    observedProof(check.evidence, check.evidenceClass, check.testId);
  }
  for (const id of context.releaseAcceptance ?? []) if (!Array.isArray(report?.acceptance) || !report.acceptance.includes(id) || !checks.some(check => Array.isArray(check?.acceptanceCriteria) && check.acceptanceCriteria.includes(id))) fail(`${id}: TASK-12 acceptance has no explicit passing check.`);
  const classes = new Set(checks.map(check => check?.evidenceClass));
  for (const required of ['document', 'software', 'packaged-windows', 'real-hardware', 'live-provider', 'manual-ui']) if (!classes.has(required)) fail(`Release report lacks ${required} evidence.`);
  if (Array.isArray(documents.traceability?.requirements) && Array.isArray(documents.testCatalog?.tests)) {
    try { errors.push(...validateTraceability(documents.traceability, documents.testCatalog, context)); } catch { fail('Malformed traceability ledger/catalog.'); }
    for (const id of context.requirements) if (documents.traceability.requirements.find(row => row?.requirementId === id)?.verificationStatus !== 'passed') fail(`${id}: mandatory requirement is not passed.`);
    for (const row of documents.traceability.requirements) if (row?.verificationStatus === 'passed') for (const evidence of Array.isArray(row.evidence) ? row.evidence : []) observedProof(evidence, evidence?.evidenceClass, evidence?.testId);
  } else fail('Missing traceability ledger or test catalog.');
  const matrix = documents.compatibilityMatrix;
  if (matrix?.schemaVersion !== 1 || matrix.releaseVersion !== record.releaseVersion || matrix.target !== record.target || matrix.runtimeStrategy !== 'detected-external-node-24' || matrix.locallyObserved?.platform !== 'win32' || matrix.locallyObserved?.arch !== 'x64' || !/^v24\.\d+\.\d+$/.test(matrix.locallyObserved?.node ?? '') || Number(matrix.locallyObserved?.node?.split('.')[1]) < 18 || !matrix.locallyObserved?.nodeModuleAbi || !matrix.locallyObserved?.napi || !matrix.locallyObserved?.sqlite || !digest(matrix.locallyObserved?.executableSha256) || !matrix.locallyObserved?.osRelease || !Array.isArray(matrix.observations) || !matrix.observations.length) fail('Compatibility matrix lacks observed host/runtime/native ABI identity.');
  const observations = new Map((Array.isArray(matrix?.observations) ? matrix.observations : []).filter(object).map(item => [item.role, item]));
  for (const role of ['initial-compatible-host-and-provider-paths', 'arduino', 'avr-gcc', 'native-engineering', 'codex', 'opencode']) if (!observations.has(role)) fail(`Compatibility matrix lacks ${role} identity evidence.`);
  if (!observations.get('initial-compatible-host-and-provider-paths')?.versions?.vscode || !observations.get('arduino')?.version || !observations.get('arduino')?.cores?.length || !observations.get('avr-gcc')?.packageVersionFromRecordedExecutablePath || !observations.get('native-engineering')?.kicad?.version || !observations.get('native-engineering')?.python?.python || !observations.get('native-engineering')?.python?.packages?.cadquery) fail('Compatibility matrix lacks exact selected host/compiler/core/engineering versions.');
  for (const provider of ['codex', 'opencode']) if (!observations.get(provider)?.versions?.provider || !digest(observations.get(provider)?.versions?.protocolFingerprint)) fail(`Compatibility matrix lacks observed ${provider} version/fingerprint.`);
  if (matrix?.vendorSupport?.assessment !== 'verified-supported' || !Array.isArray(matrix.vendorSupport?.evidence) || !matrix.vendorSupport.evidence.length) fail('Current vendor support for the observed OS/runtime is not verified; local execution alone is insufficient.');
  for (const observation of Array.isArray(matrix?.observations) ? matrix.observations : []) ref(observation?.evidence, `Compatibility observation ${observation?.role}`);
  for (const evidence of Array.isArray(matrix?.vendorSupport?.evidence) ? matrix.vendorSupport.evidence : []) {
    const proof = ref(evidence, 'Vendor support evidence', true);
    if (proof?.result !== 'passed' || proof.vendorSupport !== 'verified-supported' || proof.observed?.version !== matrix?.locallyObserved?.osRelease || !Array.isArray(proof.sources) || !proof.sources.some(source => /^https:\/\/(?:code\.visualstudio\.com\/|nodejs\.org\/|github\.com\/nodejs\/node\/|learn\.microsoft\.com\/)/.test(source?.url ?? ''))) fail('Vendor support evidence is not a passing vendor support review for the observed OS.');
  }
  const licenses = Array.isArray(documents.licenseInventory) ? documents.licenseInventory : [];
  if (!licenses.length || new Set(licenses.map(pkg => `${pkg?.name}@${pkg?.version}`)).size !== licenses.length || licenses.some(pkg => !pkg?.name || !pkg.version || !pkg.license || pkg.bundled !== true || typeof pkg.licenseText !== 'string' || !pkg.licenseText || sha256(Buffer.from(pkg.licenseText)) !== pkg.licenseTextSha256)) fail('Bundled license inventory is missing, duplicated or lacks exact license text.');
  const builtLicenses = Array.isArray(documents.buildLicenseInventory) ? documents.buildLicenseInventory : [];
  if (!builtLicenses.length || builtLicenses.length !== licenses.length || builtLicenses.some(pkg => !licenses.some(license => license?.name === pkg?.name && license?.version === pkg?.version && license?.license === pkg?.license && license?.licensePath === pkg?.licensePath))) fail('Release licenses do not cover the exact generated bundled-code inventory.');
  const packaged = documents.packageInspection;
  if (!inspection || inspection.passed !== true || inspection.sha256 !== record.vsixSha256 || inspection.target !== record.target || inspection.extension?.version !== record.releaseVersion || inspection.extension?.name !== 'robotics-workbench' || inspection.extension?.publisher !== 'local-workbench' || JSON.stringify(packaged) !== JSON.stringify(inspection)) fail('Fresh exact-package inspection differs from the recorded package/extension identity.');
  const runtime = new Map();
  if (!Array.isArray(record.runtimeArtifacts)) fail('Missing runtime artifact inventory.');
  for (const item of Array.isArray(record.runtimeArtifacts) ? record.runtimeArtifacts : []) { if (!item?.path?.startsWith('apps/extension/dist/')) fail('Runtime artifact is outside packaged runtime.'); ref(item, 'Runtime artifact'); if (item?.path) { if (runtime.has(item.path)) fail('Duplicate runtime artifact path.'); runtime.set(item.path, item); } }
  const runtimeManifest = runtime.get('apps/extension/dist/native-runtime.json');
  let native; try { if (runtimeManifest) native = json(root, runtimeManifest.path); } catch (error) { fail(error.message); }
  for (const name of ['extension.js', 'companion.js', 'mcp-stdio.js', 'documents-worker.cjs', 'telemetry-worker.cjs', 'THIRD-PARTY-NOTICES.txt', 'native-runtime.json']) if (!runtime.has(`apps/extension/dist/${name}`)) fail(`Missing runtime artifact ${name}.`);
  const nativeFiles = Array.isArray(native?.files) ? native.files.filter(file => object(file) && typeof file.path === 'string') : [], nativePackages = Array.isArray(native?.packages) ? native.packages.filter(object) : [];
  if (native?.schemaVersion !== 1 || native.target !== record.target || !nativeFiles.some(file => file.path.endsWith('@serialport+bindings-cpp.node')) || !nativeFiles.some(file => file.path.endsWith('skia.win32-x64-msvc.node'))) fail('Native runtime inventory is incomplete.');
  for (const file of nativeFiles.filter(file => file.path.endsWith('.node'))) if (runtime.get(`apps/extension/dist/${file.path}`)?.sha256 !== file.sha256) fail(`Native binary checksum missing or inconsistent: ${file.path}`);
  for (const pkg of nativePackages) if (!licenses.some(license => license?.name === pkg.name && license.version === pkg.version)) fail(`Missing native license ${pkg.name}@${pkg.version}.`);
  if (documents.lockfile && documents.lockfile.version !== record.releaseVersion) fail('Lockfile version differs from release.');
  return [...new Set(errors)];
}

export function releaseContext(root, vsixPath) {
  const context = projectContext(root);
  context.releaseAcceptance = json(root, 'tasks/task-index.json').tasks.find(task => task.task_id === 'TASK-12').acceptance;
  return { root, context, source: sourceIdentity(root), inspection: inspectPackage(root, vsixPath) };
}
