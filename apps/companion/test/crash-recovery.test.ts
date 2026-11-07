import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkbenchStore, type ArtifactCommitStep } from '@robotics-workbench/persistence';

const bytes = Buffer.from('retained synthetic crash evidence\n');
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const steps: ArtifactCommitStep[] = ['temporary-created', 'bytes-written', 'finalized', 'registered'];

function observedStep(child: ChildProcess, step: ArtifactCommitStep): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Fixture did not reach ${step}.`)), 12000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Fixture exited before ${step}.`)); });
    child.on('message', value => {
      if (value && typeof value === 'object' && 'step' in value && value.step === step) { clearTimeout(timer); resolve(); }
    });
  });
}

for (const step of steps) test(`real child kill at artifact ${step} recovers durable bytes without replay`, { timeout: 20000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-real-crash-'));
  const safeRoot = realpathSync(tmpdir());
  const cleanupRelative = relative(safeRoot, realpathSync(directory));
  assert.ok(cleanupRelative && !isAbsolute(cleanupRelative) && cleanupRelative !== '..' && !cleanupRelative.startsWith(`..${sep}`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const projectRoot = join(directory, 'project');
  const dataRoot = join(directory, 'data');
  mkdirSync(projectRoot);
  const manifestText = readFileSync('examples/workbench.valid.json', 'utf8');
  const manifest = JSON.parse(manifestText);
  writeFileSync(join(projectRoot, 'workbench.json'), manifestText);
  mkdirSync(join(projectRoot, 'RangeSensor'));
  const sketch = join(projectRoot, 'RangeSensor', 'RangeSensor.ino');
  writeFileSync(sketch, 'void setup() {}\nvoid loop() {}\n');
  const originalSource = digest(readFileSync(sketch));
  const child = fork(resolve('artifacts/fixtures/task02-crash.cjs'), [projectRoot, dataRoot, step], {
    execPath: process.execPath, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: Object.fromEntries(['SystemRoot', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]!]))
  });
  let diagnostics = '';
  child.stderr!.on('data', chunk => { diagnostics = `${diagnostics}${String(chunk)}`.slice(-8192); });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  try {
    await observedStep(child, step).catch(error => { throw new Error(`${String(error)}\n${diagnostics}`); });
    assert.equal(child.kill('SIGKILL'), true);
    await closed;
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; }
  }
  assert.equal(digest(readFileSync(sketch)), originalSource);
  assert.equal(readFileSync(join(projectRoot, 'workbench.json'), 'utf8'), manifestText);

  const recovered = new WorkbenchStore(dataRoot);
  try {
    assert.deepEqual(recovered.recovery.missing, []);
    assert.deepEqual(recovered.recovery.corrupt, []);
    assert.deepEqual(readdirSync(join(dataRoot, 'temporary')), []);
    const database = new DatabaseSync(recovered.databasePath, { readOnly: true });
    let artifacts: Record<string, unknown>[];
    try { artifacts = database.prepare('SELECT artifact_id FROM artifacts').all(); } finally { database.close(); }
    if (step === 'registered') {
      assert.equal(artifacts.length, 1);
      assert.deepEqual(recovered.readArtifact(manifest.projectId, String(artifacts[0].artifact_id)), bytes);
      assert.deepEqual(recovered.recovery.quarantined, []);
    } else {
      assert.equal(artifacts.length, 0);
      assert.equal(recovered.recovery.quarantined.length, 1);
      const retained = readFileSync(join(dataRoot, recovered.recovery.quarantined[0]));
      assert.deepEqual(retained, step === 'temporary-created' ? Buffer.alloc(0) : bytes);
      assert.deepEqual(readdirSync(join(dataRoot, 'artifacts')), []);
    }
    assert.equal(recovered.listOperations(manifest.projectId).length, 1);
    const [receipt] = recovered.reconcileOperations();
    assert.equal(receipt.kind, 'upload');
    assert.equal(receipt.status, 'outcome-unknown');
    assert.equal(receipt.tool.name, 'synthetic-upload-no-device');
    assert.deepEqual(recovered.reconcileOperations(), []);
    assert.equal(recovered.listOperations(manifest.projectId).length, 1);
  } finally { recovered.close(); }
  const restarted = new WorkbenchStore(dataRoot);
  try {
    assert.deepEqual(restarted.reconcileOperations(), []);
    assert.equal(restarted.listOperations(manifest.projectId).length, 1);
    assert.equal(restarted.listOperations(manifest.projectId)[0].status, 'outcome-unknown');
  } finally { restarted.close(); }
});
