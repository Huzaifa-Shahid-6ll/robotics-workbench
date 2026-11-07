import { createHash } from 'node:crypto';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export function validateTraceability(ledger, catalog, context) {
  const errors = [], seen = new Set(), root = realpathSync(resolve(context.root));
  const metadata = value => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
  const fail = message => errors.push(message);
  const knownTests = new Map(catalog.tests.map(item => [item.testId, item]));
  if (knownTests.size !== catalog.tests.length) fail('Duplicate catalog test ID.');
  const local = path => {
    if (typeof path !== 'string' || isAbsolute(path)) return undefined;
    const full = resolve(root, path), scoped = relative(root, full);
    if (!scoped || scoped === '..' || scoped.startsWith(`..${sep}`) || isAbsolute(scoped) || !existsSync(full)) return undefined;
    const canonical = realpathSync(full), actual = relative(root, canonical);
    return actual && actual !== '..' && !actual.startsWith(`..${sep}`) && !isAbsolute(actual) ? canonical : undefined;
  };
  for (const row of ledger.requirements ?? []) {
    const id = row.requirementId;
    if (!context.requirements.includes(id) || seen.has(id)) fail(`Unknown or duplicate requirement: ${id}`);
    seen.add(id);
    if (!['not-run', 'blocked', 'failed', 'passed', 'not-applicable'].includes(row.verificationStatus)) fail(`${id}: invalid verification status.`);
    if (!row.acceptanceCriteria?.length || row.acceptanceCriteria.some(ac => !context.acceptance.includes(ac))) fail(`${id}: missing/unknown acceptance criterion.`);
    if (!row.implementationOwners?.length || row.implementationOwners.some(owner => !context.owners.includes(owner))) fail(`${id}: missing/unknown implementing task.`);
    if (!row.implementationPaths?.length || row.implementationPaths.some(path => !local(path))) fail(`${id}: missing implementation path.`);
    if (!row.testIds?.length || row.testIds.some(test => !knownTests.has(test))) fail(`${id}: missing/unknown test ID.`);
    if (row.verificationStatus === 'not-applicable' && !row.scopeDecision) fail(`${id}: not-applicable needs a scope decision.`);
    for (const evidence of row.evidence ?? []) {
      const full = local(evidence.path);
      if (!full) { fail(`${id}: evidence file missing/outside repository.`); continue; }
      if (evidence.sha256 && createHash('sha256').update(readFileSync(full)).digest('hex') !== evidence.sha256) fail(`${id}: evidence digest mismatch.`);
    }
    if (row.verificationStatus === 'passed') {
      if (!row.evidence?.length) fail(`${id}: success has no artifacts.`);
      for (const evidence of row.evidence ?? []) {
        if (!evidence.sha256 || !/^[a-f0-9]{64}$/.test(evidence.sha256) || !knownTests.has(evidence.testId) || !row.testIds.includes(evidence.testId) || !evidence.evidenceClass || knownTests.get(evidence.testId)?.evidenceClass !== evidence.evidenceClass || !evidence.runId || !/^[a-f0-9]{64}$/.test(evidence.sourceDigest ?? '') || !evidence.appVersion || !metadata(evidence.environment) || !metadata(evidence.dependencyVersions) || !Number.isFinite(Date.parse(evidence.startedAt)) || !Number.isFinite(Date.parse(evidence.endedAt)) || Date.parse(evidence.endedAt) < Date.parse(evidence.startedAt) || evidence.result !== 'passed') fail(`${id}: success evidence lacks required run metadata or changes its registered evidence class.`);
      }
      const classes = new Set(row.evidence?.map(item => item.evidenceClass));
      for (const required of context.requiredEvidenceClasses?.[id] ?? row.requiredEvidenceClasses ?? []) if (!classes.has(required)) fail(`${id}: missing ${required} evidence.`);
    }
  }
  for (const id of context.requirements) if (!seen.has(id)) fail(`Missing requirement: ${id}`);
  return errors;
}

export function projectContext(root = '.') {
  const docs = JSON.parse(readFileSync(resolve(root, 'doc-manifest.json'), 'utf8')).documents;
  const contents = docs.map(doc => readFileSync(resolve(root, doc.path), 'utf8'));
  const requirements = [...new Set([...contents[5].matchAll(/\| (REQ-[A-Z]+-\d+) \|/g)].map(m => m[1]))];
  const requiredEvidenceClasses = Object.fromEntries(requirements.map(id => [id, ['software']]));
  for (const id of ['REQ-HW-02', 'REQ-HW-08', 'REQ-PROD-04']) requiredEvidenceClasses[id].push('real-hardware');
  for (const id of ['REQ-PROD-02', 'REQ-AGENT-01', 'REQ-AGENT-02']) requiredEvidenceClasses[id].push('live-provider');
  for (const id of ['REQ-UX-01', 'REQ-UX-05']) requiredEvidenceClasses[id].push('manual-ui');
  for (const id of ['REQ-UX-06', 'REQ-PROD-05']) requiredEvidenceClasses[id].push('packaged-windows');
  requiredEvidenceClasses['REQ-PROD-06'] = ['software', 'real-hardware', 'live-provider', 'manual-ui', 'packaged-windows'];
  return { root, requirements, requiredEvidenceClasses, acceptance: [...new Set(contents.flatMap(text => [...text.matchAll(/\bAC-D\d+-\d+\b/g)].map(m => m[0])))], owners: JSON.parse(readFileSync(resolve(root, 'tasks/task-index.json'), 'utf8')).tasks.map(item => item.task_id) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const errors = validateTraceability(JSON.parse(readFileSync('verification/traceability.json', 'utf8')), JSON.parse(readFileSync('verification/test-catalog.json', 'utf8')), projectContext());
  console.log(JSON.stringify({ testId: 'verification.requirement-coverage', result: errors.length ? 'failed' : 'passed', errors, scope: 'Requirement links and evidence integrity only; no physical or complete-release claim.' }, null, 2));
  if (errors.length) process.exitCode = 1;
}
