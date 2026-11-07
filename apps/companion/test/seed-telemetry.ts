import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { WorkbenchStore } from '@robotics-workbench/persistence';
import { RawRecorder } from '@robotics-workbench/serial';
import { WorkbenchError, type ExperimentProcedure, type ParserProfile, type WorkbenchManifest } from '@robotics-workbench/contracts';
import type { StoredRecording } from '../src/hardware-service';

/** Dedicated software-only fixture. Run before starting the companion's database owner. */
export function seedTelemetry(root: string, dataRoot: string): { projectId: string; projectRevision: number; recordingId: string; profileId: string; procedureId: string } {
  if (!isAbsolute(root) || !isAbsolute(dataRoot) || resolve(root).toLowerCase() === resolve(dataRoot).toLowerCase()) throw new WorkbenchError('INVALID_REQUEST', 'Seed requires separate absolute project/data directories.');
  const dataLocation = relative(resolve(root), resolve(dataRoot));
  if (dataLocation !== '..' && !dataLocation.startsWith(`..${sep}`) && !isAbsolute(dataLocation)) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Synthetic operational data must live outside its project.');
  for (const directory of [root, dataRoot]) {
    if (existsSync(directory) && readdirSync(directory).length) throw new WorkbenchError('REVISION_CONFLICT', 'Synthetic seeding requires empty dedicated directories; existing files were preserved.');
    mkdirSync(directory, { recursive: true });
    if (realpathSync(directory).toLowerCase() !== resolve(directory).toLowerCase()) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Synthetic seeding cannot traverse links or junctions.');
  }
  const projectId = randomUUID(), targetId = randomUUID(), profileId = randomUUID(), procedureId = randomUUID();
  const manifest: WorkbenchManifest = { schemaVersion: 1, projectId, projectRevision: 1, name: 'Synthetic telemetry fixture — software only', sketches: [{ path: 'TelemetryProbe', targetId }], targets: [{ targetId, fqbn: 'arduino:avr:uno', options: {} }], components: [], nets: [], codeBindings: [], documents: [], extensions: { syntheticFixture: true } };
  const profile: ParserProfile = { schemaVersion: 1, id: profileId, parserVersion: 'telemetry-v1', mode: 'labeled-numeric', channels: [{ channelId: 'range', label: 'Synthetic range', source: 'range', unit: 'mm' }, { channelId: 'power', label: 'Synthetic power', source: 'power', unit: 'mW' }] };
  const procedure: ExperimentProcedure = { schemaVersion: 1, procedureId, version: 1, purpose: 'Synthetic telemetry stability test (software only)', setup: ['No hardware; generated fixture bytes enter RawRecorder.'], controlledInputs: ['Range sequence 10,20,15,25,20; power sequence 1,2,3,4,5.'], instruments: ['Deterministic software fixture; no physical instrument.'], steps: ['Derive the retained labeled-numeric recording.', 'Select the complete retained interval.', 'Inspect exact metrics and raw byte references.'], expectedOutputs: ['Five samples per channel, mean range18 mm and mean power3 mW in the synthetic fixture.'], tolerances: ['Exact fixture values only; no physical accuracy claim.'], stopConditions: ['Stop after the five generated lines; do not open a physical port.'], decisionRules: ['A local evaluator may judge only the generated software fixture against its exact retained metrics.'] };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  for (const directory of ['TelemetryProbe', 'telemetry', 'experiments']) mkdirSync(join(root, directory));
  writeFileSync(join(root, 'workbench.json'), manifestBytes, { flag: 'wx' });
  writeFileSync(join(root, 'TelemetryProbe', 'TelemetryProbe.ino'), '// Synthetic source fixture. It has not been compiled or uploaded.\nvoid setup() {}\nvoid loop() {}\n', { flag: 'wx' });
  writeFileSync(join(root, 'telemetry', 'parsers.json'), JSON.stringify({ schemaVersion: 1, profiles: [profile] }, null, 2) + '\n', { flag: 'wx' });
  writeFileSync(join(root, 'experiments', 'procedures.json'), JSON.stringify({ schemaVersion: 1, procedures: [procedure] }, null, 2) + '\n', { flag: 'wx' });
  const store = new WorkbenchStore(dataRoot);
  try {
    store.registerProject({ projectId, root, projectRevision: 1, manifestSha256: createHash('sha256').update(manifestBytes).digest('hex') });
    const recorder = new RawRecorder(join(dataRoot, 'work', projectId, 'synthetic-telemetry'), { projectId, projectRevision: 1, deviceId: randomUUID(), baudRate: 9600, uploadReceiptId: null, firmwareSha256: null });
    const values = [10, 20, 15, 25, 20];
    for (let i = 0; i < values.length; i++) {
      if (i === 2) recorder.boundary('disconnect');
      if (!recorder.receive(Buffer.from(`range:${values[i]} power:${i + 1}\n`))) throw new WorkbenchError('INTERNAL_ERROR', 'Synthetic RawRecorder refused fixture bytes.');
    }
    const recording = recorder.finish();
    if (recording.status !== 'completed') throw new WorkbenchError('INTERNAL_ERROR', 'Synthetic recording did not finalize.');
    const segments = recording.segments.map(segment => {
      const artifact = store.storeArtifact(projectId, readFileSync(segment.path), 'application/x-ndjson');
      if (artifact.sha256 !== segment.sha256 || artifact.sizeBytes !== segment.sizeBytes) throw new WorkbenchError('ARTIFACT_MISMATCH', 'Synthetic recording segment changed before retention.');
      return { ...segment, artifactId: artifact.artifactId };
    });
    const retained: StoredRecording = { ...recording, segments };
    store.putRecord('recordings', retained.recordingId, projectId, retained);
    return { projectId, projectRevision: 1, recordingId: retained.recordingId, profileId, procedureId };
  } finally { store.close(); }
}

// Bundled service tests import this fixture without executing its CLI entry point.
if (process.argv[1] && /(?:^|[\\/])(?:task09-seed\.cjs|seed-telemetry\.(?:ts|js|cjs))$/.test(process.argv[1])) {
  const args = process.argv.slice(2), option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const root = option('--root') ?? args[0], dataRoot = option('--data') ?? args[1];
  if (!root || !dataRoot) throw new WorkbenchError('INVALID_REQUEST', 'Usage: task09-seed.cjs <absolute root> <absolute data>, or --root <root> --data <data>.');
  process.stdout.write(JSON.stringify(seedTelemetry(root, dataRoot)) + '\n');
}
