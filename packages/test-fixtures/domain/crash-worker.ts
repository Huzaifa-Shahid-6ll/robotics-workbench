import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { WorkbenchStore, type ArtifactCommitStep } from '@robotics-workbench/persistence';
import { validateManifest } from '@robotics-workbench/contracts';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

// Synthetic subprocess fixture: the parent kills it after the attributable durable commit boundary.
const [projectRoot, dataRoot, requestedStep] = isMainThread ? process.argv.slice(2) : workerData as string[];
const steps: ArtifactCommitStep[] = ['temporary-created', 'bytes-written', 'finalized', 'registered'];
if (!projectRoot || !dataRoot || !steps.includes(requestedStep as ArtifactCommitStep)) throw new Error('Expected project/data roots and an artifact commit step.');
if (isMainThread) {
  if (!process.send) throw new Error('Expected inherited IPC.');
  const worker = new Worker(__filename, { workerData: [projectRoot, dataRoot, requestedStep] });
  worker.on('message', message => process.send!(message, undefined, undefined, (error: Error | null) => { if (error) throw error; }));
  worker.on('error', error => { throw error; });
} else {
const text = readFileSync(join(projectRoot, 'workbench.json'), 'utf8');
const manifest = validateManifest(JSON.parse(text));
const store = new WorkbenchStore(dataRoot, { fault(step) {
  if (step !== requestedStep) return;
  parentPort!.postMessage({ step, projectId: manifest.projectId });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);
  throw new Error('Fixture boundary escaped before parent termination.');
} });
store.registerProject({ projectId: manifest.projectId, root: projectRoot, projectRevision: manifest.projectRevision,
  manifestSha256: createHash('sha256').update(text).digest('hex') });
const receipt = store.createOperation({ schemaVersion: 1, operationId: randomUUID(), requestId: randomUUID(), projectId: manifest.projectId,
  kind: 'upload', status: 'queued', expectedProjectRevision: manifest.projectRevision, createdAt: new Date().toISOString(),
  deviceId: randomUUID(), sourceSnapshotId: randomUUID(), tool: { name: 'synthetic-upload-no-device', version: 'fixture-1' }, artifacts: [] }, { action: 'synthetic-artifact-crash-check' });
store.transitionOperation(manifest.projectId, receipt.operationId, 'running');
store.storeArtifact(manifest.projectId, Buffer.from('retained synthetic crash evidence\n'), 'text/plain', receipt.operationId);
throw new Error('Expected parent to terminate this fixture before artifact commit returned.');
}
