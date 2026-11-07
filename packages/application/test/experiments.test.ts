import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkbenchStore } from '@robotics-workbench/persistence';
import type { ExperimentRun, RecordingSelection } from '@robotics-workbench/contracts';
import { ExperimentRepository, reopenExperimentExport } from '../src/experiments/index';
import { hash, procedure, syntheticDerivation, unknownAssociations } from '../../test-fixtures/experiments/fixtures';

function setup() {
  const parent = join(process.cwd(), 'artifacts', 'task09', 'experiment-tests'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'run-')), projectId = randomUUID(), root = join(directory, 'project'); mkdirSync(root);
  const store = new WorkbenchStore(join(directory, 'data')); store.registerProject({ projectId, root, projectRevision: 1, manifestSha256: hash('manifest') });
  const repository = new ExperimentRepository(store, 'local-host');
  const input = { projectId, projectRevision: 1, procedureBytes: Buffer.from(JSON.stringify(procedure, null, 2)), parameters: { target: { value: 2, unit: 'mm' } }, setup: 'Synthetic fixture; no real board.', associations: unknownAssociations() };
  const raw = store.storeArtifact(projectId, Buffer.from('range:1\nrange:2\nrange:3\n'), 'application/jsonl');
  const data = syntheticDerivation(raw.sha256); repository.retainDerivation(projectId, data, [raw], { status: 'completed', serial: { baudRate: 9600 } });
  const selection: RecordingSelection = { schemaVersion: 1, recordingId: data.recordingId, derivationId: data.derivationId, parserVersion: data.parserVersion, configurationSha256: data.configurationSha256, projectRevision: 1, channelIds: ['range'], timeBasis: 'host-receive', start: 0, end: 20 };
  const draft = () => repository.create(input);
  const start = (): ExperimentRun => { let run = draft(); run = repository.transition(projectId, run.experimentId, run.revisionId, 'ready'); return repository.transition(projectId, run.experimentId, run.revisionId, 'running'); };
  const finish = (): ExperimentRun => { let run = start(); run = repository.attachSelection(projectId, run.experimentId, run.revisionId, selection); return repository.transition(projectId, run.experimentId, run.revisionId, 'completed'); };
  return { directory, root, projectId, store, repository, input, raw, data, selection, draft, start, finish };
}

test('run lifecycle freezes procedure/configuration, retains correction revisions and refuses stale or invalid transitions', () => {
  const s = setup(), draft = s.draft();
  assert.equal(draft.lifecycle, 'draft'); assert.equal(draft.judgment.outcome, 'not-evaluated');
  assert.throws(() => s.repository.create({ ...s.input, procedureBytes: Buffer.from(JSON.stringify({ ...procedure, purpose: 'Changed under the same version.' })) }), { code: 'REVISION_CONFLICT' });
  assert.throws(() => s.repository.transition(s.projectId, draft.experimentId, draft.revisionId, 'completed'), { code: 'INVALID_REQUEST' });
  let run = s.repository.transition(s.projectId, draft.experimentId, draft.revisionId, 'ready');
  run = s.repository.transition(s.projectId, run.experimentId, run.revisionId, 'running');
  assert.ok(run.frozenConfigurationSha256); const frozen = run.frozenConfigurationSha256;
  s.input.procedureBytes.fill(0); s.input.parameters.target.value = 999;
  assert.equal(s.repository.get(s.projectId, run.experimentId).parameters.target.value, 2);
  assert.equal(s.repository.get(s.projectId, run.experimentId).procedure.purpose, procedure.purpose);
  assert.throws(() => s.repository.note(s.projectId, run.experimentId, draft.revisionId, { author: 'operator', reason: 'correction', text: 'new note' }), { code: 'REVISION_CONFLICT' });
  run = s.repository.note(s.projectId, run.experimentId, run.revisionId, { author: 'operator', reason: 'Correct fixture setup description.', text: 'No physical sensor was used.' });
  run = s.repository.changeSegment(s.projectId, run.experimentId, run.revisionId, 'Changed a fixture parameter.', 'target=3 mm');
  assert.equal(run.comparable, false); assert.equal(run.frozenConfigurationSha256, frozen); assert.equal(run.parameters.target.value, 2);
  assert.equal(s.repository.history(s.projectId, run.experimentId)[0].notes.length, 0);
  s.store.close();
});

test('explicit unknown associations are retained and missing reasons fail before persistence', () => {
  const s = setup(); assert.equal(s.draft().associations.buildId.id, null);
  assert.throws(() => s.repository.create({ ...s.input, associations: { ...s.input.associations, buildId: { id: null, reason: null } } }), { code: 'INVALID_REQUEST' });
  assert.throws(() => s.repository.create({ ...s.input, parameters: { speed: { value: Number.NaN, unit: null } } }), { code: 'INVALID_REQUEST' });
  s.store.close();
});

test('exact selection and deterministic metrics never substitute a later recording or zero-fill gaps', () => {
  const s = setup(), first = s.repository.metrics(s.projectId, s.selection);
  assert.deepEqual(first[0], { formulaVersion: 'sample-statistics-v1', channelId: 'range', unit: 'mm', count: 3, min: 1, max: 3, mean: 2, missingData: 'exclude-absent-no-interpolation', gaps: 0, issues: 0, formula: { mean: 'sum(value)/count', interval: 'inclusive', weighting: 'sample' }, selection: s.selection });
  s.repository.retainDerivation(s.projectId, syntheticDerivation(s.raw.sha256, { values: [900, 901] }), [s.raw]);
  assert.deepEqual(s.repository.metrics(s.projectId, s.selection), first);
  const empty = s.repository.metrics(s.projectId, { ...s.selection, start: 100, end: 200 })[0]; assert.equal(empty.count, 0); assert.equal(empty.mean, null);
  const gap = syntheticDerivation(s.raw.sha256, { gaps: true }); s.repository.retainDerivation(s.projectId, gap, [s.raw]);
  const metric = s.repository.metrics(s.projectId, { ...s.selection, recordingId: gap.recordingId, derivationId: gap.derivationId })[0]; assert.equal(metric.mean, 2); assert.equal(metric.gaps, 1);
  assert.throws(() => s.repository.metrics(s.projectId, { ...s.selection, recordingId: randomUUID() }), { code: 'ARTIFACT_MISMATCH' });
  assert.throws(() => s.repository.metrics(s.projectId, { ...s.selection, timeBasis: 'device', deviceEpoch: 0 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => s.repository.retainDerivation(s.projectId, { ...s.data, samples: [{ ...s.data.samples[0], value: 1000 }] }, [s.raw]), { code: 'ARTIFACT_MISMATCH' });
  const extreme = syntheticDerivation(s.raw.sha256, { values: [1e308, -1e308] }); s.repository.retainDerivation(s.projectId, extreme, [s.raw]);
  assert.equal(s.repository.metrics(s.projectId, { ...s.selection, recordingId: extreme.recordingId, derivationId: extreme.derivationId })[0].mean, 0);
  s.store.close();
});

test('restart marks a running acquisition interrupted, preserves partial evidence and performs no replay', () => {
  const s = setup(); let run = s.start(); run = s.repository.attachSelection(s.projectId, run.experimentId, run.revisionId, s.selection);
  s.store.close(); const reopenedStore = new WorkbenchStore(join(s.directory, 'data')), repository = new ExperimentRepository(reopenedStore);
  const recovered = repository.recover(s.projectId); assert.equal(recovered.length, 1); assert.equal(recovered[0].lifecycle, 'interrupted'); assert.deepEqual(recovered[0].selections, [s.selection]);
  assert.equal(repository.recover(s.projectId).length, 0); assert.equal(repository.history(s.projectId, run.experimentId).at(-2)!.lifecycle, 'running');
  assert.throws(() => repository.transition(s.projectId, run.experimentId, recovered[0].revisionId, 'running'), { code: 'INVALID_REQUEST' }); reopenedStore.close();
});

test('agent text cannot pass a procedure; local judgment needs applicable retained evidence', () => {
  const s = setup(), run = s.finish(), agent = new ExperimentRepository(s.store, 'agent');
  const input = { outcome: 'pass' as const, evaluator: 'Local fixture evaluator', criterion: 'Synthetic mean equals two; no physical claim.', evidenceRevisionIds: [run.revisionId] };
  assert.throws(() => agent.judge(s.projectId, run.experimentId, run.revisionId, input), { code: 'UNAUTHORIZED_SCOPE' });
  assert.throws(() => s.repository.judge(s.projectId, run.experimentId, run.revisionId, { ...input, evidenceRevisionIds: [randomUUID()] }), { code: 'INVALID_REQUEST' });
  const judged = s.repository.judge(s.projectId, run.experimentId, run.revisionId, input); assert.equal(judged.judgment.outcome, 'pass');
  assert.equal(s.repository.history(s.projectId, run.experimentId).at(-2)!.judgment.outcome, 'not-evaluated'); s.store.close();
});

test('configuration changes prevent a whole-run pass and preserve preceding notes and metric artifacts', () => {
  const s = setup(); let run = s.start();
  run = s.repository.attachSelection(s.projectId, run.experimentId, run.revisionId, s.selection);
  run = s.repository.note(s.projectId, run.experimentId, run.revisionId, { author: 'local fixture operator', reason: 'Original setup note.', text: 'The fixture originally used a fixed target.' });
  const before = structuredClone(run);
  run = s.repository.changeSegment(s.projectId, run.experimentId, run.revisionId, 'Synthetic setup changed.', 'Fixture target changed from2mm to3mm.');
  run = s.repository.transition(s.projectId, run.experimentId, run.revisionId, 'completed');
  const historyLength = s.repository.history(s.projectId, run.experimentId).length;
  const judgment = { outcome: 'pass' as const, evaluator: 'Local fixture evaluator', criterion: procedure.decisionRules[0], evidenceRevisionIds: [run.revisionId] };
  assert.throws(() => s.repository.judge(s.projectId, run.experimentId, run.revisionId, judgment), { code: 'INVALID_REQUEST' });
  assert.equal(s.repository.history(s.projectId, run.experimentId).length, historyLength);
  assert.deepEqual(s.repository.history(s.projectId, run.experimentId).find(item => item.revisionId === before.revisionId), before);
  assert.deepEqual(run.metricArtifacts, before.metricArtifacts); assert.deepEqual(run.notes, before.notes); assert.equal(run.frozenConfigurationSha256, before.frozenConfigurationSha256);
  run = s.repository.judge(s.projectId, run.experimentId, run.revisionId, { ...judgment, outcome: 'inconclusive' });
  assert.equal(run.judgment.outcome, 'inconclusive'); assert.equal(run.comparable, false); assert.equal(run.changes.length, 1);
  const reopened = reopenExperimentExport(Buffer.from(JSON.stringify(s.repository.export(s.projectId, run.experimentId))));
  assert.deepEqual(reopened.runs.at(-1)!.notes, before.notes); assert.deepEqual(reopened.runs.at(-1)!.metricArtifacts, before.metricArtifacts); s.store.close();
});

test('unit, procedure and clock incompatibilities remain visible and block formal improvement claims', () => {
  const s = setup(), a = s.finish();
  const other = syntheticDerivation(s.raw.sha256, { unit: 'cm', device: true }); s.repository.retainDerivation(s.projectId, other, [s.raw]);
  let b = s.repository.create({ ...s.input, procedureBytes: Buffer.from(JSON.stringify({ ...procedure, version: 2 })) });
  b = s.repository.transition(s.projectId, b.experimentId, b.revisionId, 'ready');
  b = s.repository.attachSelection(s.projectId, b.experimentId, b.revisionId, { ...s.selection, recordingId: other.recordingId, derivationId: other.derivationId, timeBasis: 'device', deviceEpoch: 0 });
  b = s.repository.transition(s.projectId, b.experimentId, b.revisionId, 'running'); b = s.repository.transition(s.projectId, b.experimentId, b.revisionId, 'completed');
  const comparison = s.repository.compare(s.projectId, a.experimentId, b.experimentId);
  assert.equal(comparison.exploratoryOverlay, true); assert.equal(comparison.formalImprovementAllowed, false); assert.equal(comparison.conclusion, 'not-evaluated');
  assert.ok(comparison.incompatibilities.some(reason => reason.includes('units'))); assert.ok(comparison.incompatibilities.some(reason => reason.includes('Clock'))); assert.ok(comparison.incompatibilities.some(reason => reason.includes('Procedure'))); s.store.close();
});

test('missing/corrupt original evidence blocks metrics and export while run references remain retained', () => {
  const s = setup(), run = s.finish(); writeFileSync(join(s.store.dataRoot, 'artifacts', s.raw.sha256), 'corrupt');
  assert.throws(() => s.repository.metrics(s.projectId, s.selection), { code: 'ARTIFACT_MISMATCH' });
  assert.throws(() => s.repository.export(s.projectId, run.experimentId), { code: 'ARTIFACT_MISMATCH' });
  assert.throws(() => s.repository.judge(s.projectId, run.experimentId, run.revisionId, { outcome: 'pass', evaluator: 'local', criterion: procedure.decisionRules[0], evidenceRevisionIds: [run.revisionId] }), { code: 'ARTIFACT_MISMATCH' });
  assert.equal(s.repository.get(s.projectId, run.experimentId).selections.length, 1);
  assert.equal(s.repository.inspectEvidence(s.projectId, run.experimentId).status, 'incomplete');
  unlinkSync(join(s.store.dataRoot, 'artifacts', s.raw.sha256)); assert.throws(() => s.repository.metrics(s.projectId, s.selection)); s.store.close();
});

test('gaps and empty intervals cannot produce passing numeric judgments; inconclusive preserves the evidence', () => {
  const s = setup(), derived = syntheticDerivation(s.raw.sha256, { gaps: true }); s.repository.retainDerivation(s.projectId, derived, [s.raw]);
  let run = s.start(); run = s.repository.attachSelection(s.projectId, run.experimentId, run.revisionId, { ...s.selection, recordingId: derived.recordingId, derivationId: derived.derivationId });
  run = s.repository.transition(s.projectId, run.experimentId, run.revisionId, 'completed');
  const judgment = { outcome: 'pass' as const, evaluator: 'Local fixture evaluator', criterion: procedure.decisionRules[0], evidenceRevisionIds: [run.revisionId] };
  assert.throws(() => s.repository.judge(s.projectId, run.experimentId, run.revisionId, judgment), { code: 'INVALID_REQUEST' });
  run = s.repository.judge(s.projectId, run.experimentId, run.revisionId, { ...judgment, outcome: 'inconclusive' });
  assert.equal(run.judgment.outcome, 'inconclusive'); assert.equal(s.repository.metrics(s.projectId, run.selections[0])[0].gaps, 1);
  s.store.close();
});

test('offline export/reopen retains exact procedure/raw/parsed artifacts and metrics, and detects tampering', () => {
  const s = setup(), run = s.finish(), exported = s.repository.export(s.projectId, run.experimentId), serialized = Buffer.from(JSON.stringify(exported));
  s.store.close(); const reopened = reopenExperimentExport(serialized); assert.deepEqual(reopened, exported); assert.equal(reopened.metrics[0].mean, 2);
  assert.equal(reopened.artifacts.find(item => item.artifactId === s.raw.artifactId)!.bytesBase64, Buffer.from('range:1\nrange:2\nrange:3\n').toString('base64'));
  assert.ok(reopened.runs.every(item => item.procedureArtifact.sha256 === hash(s.input.procedureBytes)));
  const tampered = structuredClone(exported); tampered.artifacts[0].bytesBase64 = Buffer.from('different').toString('base64');
  assert.throws(() => reopenExperimentExport(Buffer.from(JSON.stringify(tampered))), { code: 'ARTIFACT_MISMATCH' });
  const { manifestSha256: _ignored, ...body } = tampered; tampered.manifestSha256 = hash(JSON.stringify(body));
  assert.throws(() => reopenExperimentExport(Buffer.from(JSON.stringify(tampered))), { code: 'ARTIFACT_MISMATCH' });
  const wrongSummary = structuredClone(exported); wrongSummary.metrics[0].mean = 999;
  const { manifestSha256: _oldSummary, ...wrongBody } = wrongSummary; wrongSummary.manifestSha256 = hash(JSON.stringify(wrongBody));
  assert.throws(() => reopenExperimentExport(Buffer.from(JSON.stringify(wrongSummary))), { code: 'ARTIFACT_MISMATCH' });
});

test('export excludes recognizable credential material, including encoded serial payloads, without changing originals', () => {
  const s = setup(), bytes = Buffer.from(JSON.stringify({ bytesBase64: Buffer.from('api_key=synthetic-secret-value').toString('base64') }) + '\n');
  const raw = s.store.storeArtifact(s.projectId, bytes, 'application/jsonl'), derived = syntheticDerivation(raw.sha256); s.repository.retainDerivation(s.projectId, derived, [raw]);
  let run = s.start(); run = s.repository.attachSelection(s.projectId, run.experimentId, run.revisionId, { ...s.selection, recordingId: derived.recordingId, derivationId: derived.derivationId });
  assert.throws(() => s.repository.export(s.projectId, run.experimentId), { code: 'INVALID_REQUEST' }); assert.deepEqual(s.store.readArtifact(s.projectId, raw.artifactId), bytes);
  assert.throws(() => s.repository.note(s.projectId, run.experimentId, run.revisionId, { author: 'operator', reason: 'credential injection', text: 'password=synthetic-secret-value' }), { code: 'INVALID_REQUEST' }); s.store.close();
});

test('export detects recognizable serial credentials split across immutable raw segments', () => {
  const s = setup(), parts = ['api_', 'key=synthetic-secret-value'].map(text => Buffer.from(JSON.stringify({ bytesBase64: Buffer.from(text).toString('base64') }) + '\n'));
  const segments = parts.map(bytes => s.store.storeArtifact(s.projectId, bytes, 'application/jsonl')), derived = syntheticDerivation(segments[0].sha256);
  derived.segmentSha256s = segments.map(item => item.sha256); s.repository.retainDerivation(s.projectId, derived, segments);
  let run = s.start(); run = s.repository.attachSelection(s.projectId, run.experimentId, run.revisionId, { ...s.selection, recordingId: derived.recordingId, derivationId: derived.derivationId });
  assert.throws(() => s.repository.export(s.projectId, run.experimentId), { code: 'INVALID_REQUEST' });
  segments.forEach((reference, index) => assert.deepEqual(s.store.readArtifact(s.projectId, reference.artifactId), parts[index])); s.store.close();
});
