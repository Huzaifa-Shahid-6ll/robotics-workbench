// Explicit dedicated-board bench only. Ordinary verification never opens a physical port.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { CompanionClient } from '../../apps/extension/src/companion-client';
import type { OperationReceipt, ProjectRequest } from '@robotics-workbench/contracts';
import type { DeviceSnapshot } from '@robotics-workbench/devices';
import { WorkbenchStore } from '@robotics-workbench/persistence';
import type { StoredRecording } from '../../apps/companion/src/hardware-service';

type RawPage = { bytesBase64: string; nextCursor: string | null; gaps: { cause: string; lostBytes: number | null }[] };
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function deadline<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function rawBytes(read: (cursor: string | null) => Promise<RawPage>) {
  const chunks: Buffer[] = [], seen = new Set<string>(); let cursor: string | null = null, gaps: RawPage['gaps'] = [];
  do {
    const page = await read(cursor); chunks.push(Buffer.from(page.bytesBase64, 'base64')); gaps = page.gaps;
    assert.ok(chunks.reduce((total, bytes) => total + bytes.length, 0) <= 1024 * 1024, 'Bench evidence exceeds its one MiB read bound.');
    cursor = page.nextCursor;
    if (cursor) { assert.ok(!seen.has(cursor), 'Raw evidence cursor repeated.'); seen.add(cursor); }
  } while (cursor);
  const bytes = Buffer.concat(chunks); return { bytes, sha256: hash(bytes), gaps };
}

async function selfTest() {
  const bytes = Buffer.from('counter:1\n€\n'), pages = [bytes.subarray(0, 11), bytes.subarray(11)]; let reads = 0;
  const retained = await rawBytes(async cursor => { const index = cursor === null ? 0 : 1; reads++; return { bytesBase64: pages[index].toString('base64'), nextCursor: index === 0 ? 'second-page' : null, gaps: [{ cause: 'disconnect', lostBytes: null }] }; });
  assert.deepEqual(retained.bytes, bytes); assert.equal(retained.sha256, hash(bytes)); assert.equal(reads, 2); assert.equal(retained.gaps[0].lostBytes, null);
  await assert.rejects(rawBytes(async () => ({ bytesBase64: 'YQ==', nextCursor: 'same', gaps: [] })), /cursor repeated/);
  console.log('TASK-11 bench evidence self-check passed; no companion or device opened.');
}

async function resumeDrill(priorDirectory: string, mode: 'capture-crash-only' | 'resume-user-drill', serial: string, arduinoPath: string) {
  const priorPath = resolve(priorDirectory, 'result.json'), priorBytes = readFileSync(priorPath), prior = JSON.parse(priorBytes.toString('utf8'));
  assert.equal(prior.taskId, 'TASK-11'); assert.equal(prior.serial, serial); assert.equal(prior.upload?.status, 'succeeded', 'Resume requires a known successful exact upload; unknown uploads are never replayed.');
  const projectRoot = prior.projectRoot ?? join(resolve(priorDirectory), 'project', 'WorkbenchProbe'), dataRoot = prior.dataRoot ?? join(resolve(priorDirectory), 'data'), sourcePath = join(projectRoot, 'WorkbenchProbe.ino');
  const source = readFileSync(sourcePath), manifest = JSON.parse(readFileSync(join(projectRoot, 'workbench.json'), 'utf8'));
  assert.equal(manifest.projectId, prior.projectId); assert.equal(hash(source), prior.sourceSha256); assert.equal(hash(source), hash(readFileSync('packages/test-fixtures/arduino/WorkbenchProbe/WorkbenchProbe.ino')));
  const runId = randomUUID(), directory = resolve('verification/evidence/task-11/hardware', runId); mkdirSync(directory, { recursive: true });
  const evidence: Record<string, unknown> = { schemaVersion: 1, taskId: 'TASK-11', runId, mode, evidenceClass: 'real-hardware', startedAt: new Date().toISOString(), projectRoot, dataRoot, projectId: manifest.projectId, projectRevision: manifest.projectRevision, serial, sourceSha256: hash(source), priorRun: { path: priorPath, sha256: hash(priorBytes), runId: prior.runId, result: prior.result }, upload: prior.upload, environment: { platform: platform(), release: release(), arch: arch(), node: process.version }, checks: [], limitations: ['No compilation or upload is invoked by this resumed drill.', 'Physical wiring, sensors and actuators remain unverified.', mode === 'capture-crash-only' ? 'This independent capture-process-loss check does not satisfy physical unplug/replug.' : 'This drill requires actual operator USB removal and reconnection.'] };
  const save = () => writeFileSync(join(directory, 'result.json'), JSON.stringify(evidence, null, 2) + '\n'), phase = (name: string, detail: Record<string, unknown> = {}) => { evidence.phase = name; save(); const path = join(directory, 'progress.json'); writeFileSync(path, JSON.stringify({ runId, phase: name, occurredAt: new Date().toISOString(), ...detail }, null, 2) + '\n'); console.log(`TASK11_CHECKPOINT ${name} ${path}`); };
  let disconnected!: () => void, disconnectedPromise!: Promise<void>;
  const script = resolve('apps/extension/dist/companion.js'), binding = resolve('apps/extension/dist/vendor/node_modules/@serialport/bindings-cpp'); evidence.companionSha256 = hash(readFileSync(script));
  const connect = () => { disconnectedPromise = new Promise<void>(resolve => { disconnected = resolve; }); return new CompanionClient(script, process.execPath, line => console.log(line), () => disconnected(), { projectRoot, dataRoot, arduinoPath, nativeBindingPath: binding }); };
  let client = connect();
  const rpc = <T>(method: ProjectRequest['method'], params: Record<string, unknown> = {}) => client.requestProject({ schemaVersion: 1, requestId: randomUUID(), projectId: manifest.projectId, method, params }) as Promise<T>;
  const terminal = async (operation: OperationReceipt) => { const stop = Date.now() + 90000; while (['queued', 'running', 'awaiting-input'].includes(operation.status)) { assert.ok(Date.now() < stop, 'Capture terminal state was not observed.'); await pause(100); operation = await rpc('operation.get', { operationId: operation.operationId }); } return operation; };
  const discover = async () => (await rpc<{ devices: DeviceSnapshot[] }>('device.discover')).devices.filter(device => device.observation.connected && device.observation.identity?.serialNumber === serial);
  const identify = async () => { const matches = await discover(); assert.equal(matches.length, 1); return rpc<DeviceSnapshot>('device.select', { deviceId: matches[0].observation.deviceId, expectedDeviceObservationId: matches[0].observation.observationId }); };
  const capture = async (device: DeviceSnapshot) => {
    const operation = await rpc<OperationReceipt>('serial.capture', { deviceId: device.observation.deviceId, baudRate: 9600, durationMs: 600000 }), stop = Date.now() + 15000;
    while (Date.now() < stop) {
      const snapshot = await rpc<{ recordings: { recordingId: string; completion: string; device: string }[]; profiles: { id: string }[] }>('telemetry.snapshot'), active = snapshot.recordings.find(recording => recording.completion === 'active' && recording.device === device.observation.deviceId);
      if (active) { const live = await rpc<{ live: { text: string } }>('telemetry.live', { recordingId: active.recordingId, profileId: snapshot.profiles[0].id }); if (/counter:\d+/.test(live.live.text)) return { operation, recordingId: active.recordingId }; }
      assert.ok(['queued', 'running'].includes((await rpc<OperationReceipt>('operation.get', { operationId: operation.operationId })).status)); await pause(100);
    }
    throw Error('No real probe counter observed; capture was not treated as valid evidence.');
  };
  const retained = (recordingId: string) => rawBytes(cursor => rpc<RawPage>('recording.query', { recordingId, range: { startMs: 0, endMs: 360000, timeBasis: 'host-receive' }, limit: 500, ...(cursor ? { cursor } : {}) }));
  try {
    phase('resuming-without-upload'); await client.start(); assert.deepEqual(await rpc('operation.get', { operationId: prior.upload.operationId }), prior.upload);
    let device = await identify(); evidence.device = device;
    if (mode === 'resume-user-drill') {
      let active = await capture(device); phase('waiting-for-unplug', { instruction: 'Unplug only this dedicated Uno USB cable. Wait for the replug checkpoint before reconnecting.', port: device.observation.transportPath, deadlineMs: 300000 });
      const until = Date.now() + 300000;
      while ((await discover()).length) {
        assert.ok(Date.now() < until, 'Physical unplug was not observed within five minutes.');
        await pause(500);
      }
      const ended = await terminal(active.operation), raw = await retained(active.recordingId); assert.equal(ended.status, 'failed'); assert.ok(raw.bytes.length > 0 && raw.gaps.some(gap => gap.cause === 'disconnect' && gap.lostBytes === null)); writeFileSync(join(directory, 'unplug.raw'), raw.bytes); evidence.unplugCapture = ended;
      phase('waiting-for-replug', { instruction: 'Reconnect the same dedicated Uno. No firmware will be uploaded.', deadlineMs: 300000 }); const returns = Date.now() + 300000;
      while (!(await discover()).length) { assert.ok(Date.now() < returns, 'Same dedicated USB identity did not return.'); await pause(500); }
      device = await identify(); const returned = await capture(device); await rpc('operation.cancel', { operationId: returned.operation.operationId }); await terminal(returned.operation); const returnedRaw = await retained(returned.recordingId); assert.match(returnedRaw.bytes.toString('utf8'), /counter:\d+/); writeFileSync(join(directory, 'replug.raw'), returnedRaw.bytes);
      (evidence.checks as unknown[]).push({ testId: 'task11.hardware.physical-unplug-replug', result: 'passed', recordingId: active.recordingId, rawSha256: raw.sha256, returnedRecordingId: returned.recordingId, returnedRawSha256: returnedRaw.sha256, uploadReplayed: false });
    } else {
      const active = await capture(device); phase('crashing-capture-only', { recordingId: active.recordingId }); const pid = client.pid; assert.ok(pid); process.kill(pid, 'SIGKILL'); await deadline(disconnectedPromise, 10000, 'Capture companion exit was not observed.');
      client = connect(); await client.start();
      const snapshot = await rpc<{ recordings: { recordingId: string; completion: string }[] }>('telemetry.snapshot'); assert.equal(snapshot.recordings.find(recording => recording.recordingId === active.recordingId)?.completion, 'partial');
      const old = await rpc<OperationReceipt>('operation.get', { operationId: active.operation.operationId }); assert.ok(['failed', 'cancelled'].includes(old.status));
      const raw = await retained(active.recordingId); assert.match(raw.bytes.toString('utf8'), /counter:\d+/); assert.ok(raw.gaps.some(gap => gap.cause === 'service-restart' && gap.lostBytes === null)); writeFileSync(join(directory, 'restart.raw'), raw.bytes); assert.deepEqual(await rpc('device.status'), []);
      evidence.crashCaptureReceipt = old; (evidence.checks as unknown[]).push({ testId: 'task11.hardware.capture-process-loss', result: 'passed', recordingId: active.recordingId, rawSha256: raw.sha256, portReopened: false, uploadReplayed: false });
    }
    assert.deepEqual(await rpc('operation.get', { operationId: prior.upload.operationId }), prior.upload); await client.stop();
    const store = new WorkbenchStore(dataRoot); try { assert.equal(store.listOperations(manifest.projectId).filter(operation => operation.kind === 'upload').length, 1); evidence.recordings = store.listRecords<StoredRecording>('recordings', manifest.projectId).map(recording => ({ ...recording, segments: recording.segments.map(segment => { assert.equal(hash(store.readArtifact(manifest.projectId, segment.artifactId)), segment.sha256); return segment; }) })); } finally { store.close(); }
    assert.equal(hash(readFileSync(sourcePath)), prior.sourceSha256); evidence.result = 'passed'; phase('completed');
  } catch (error) { evidence.result = 'failed'; evidence.error = String(error); phase('failed'); throw error; }
  finally { await client.stop(); evidence.endedAt = new Date().toISOString(); save(); console.log(`TASK-11 resumed hardware evidence ${join(directory, 'result.json')}`); }
}

async function main() {
  const args = process.argv.slice(2), option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  if (args.includes('--self-test')) return selfTest();
  const serial = option('--serial'), arduinoPath = option('--arduino');
  if (option('--resume')) {
    assert.equal(serial, 'PRIVATE_BENCH_SERIAL_WITHHELD'); assert.ok(arduinoPath);
    assert.equal(Number(args.includes('--capture-crash-only')) + Number(args.includes('--resume-user-drill')), 1, 'Choose exactly one resumed observation drill.');
    return resumeDrill(option('--resume')!, args.includes('--capture-crash-only') ? 'capture-crash-only' : 'resume-user-drill', serial, arduinoPath);
  }
  assert.ok(args.includes('--authorize-firmware-replacement'), 'Explicit dedicated-board firmware replacement authorization is required.');
  assert.equal(serial, 'PRIVATE_BENCH_SERIAL_WITHHELD', 'This drill is scoped to the authorized dedicated Uno USB identity.'); assert.ok(arduinoPath, 'Supply the existing Arduino CLI executable.');
  const runId = randomUUID(), directory = resolve('verification/evidence/task-11/hardware', runId), projectRoot = join(directory, 'project', 'WorkbenchProbe'), dataRoot = join(directory, 'data');
  mkdirSync(projectRoot, { recursive: true });
  const source = readFileSync('packages/test-fixtures/arduino/WorkbenchProbe/WorkbenchProbe.ino'), sourcePath = join(projectRoot, 'WorkbenchProbe.ino'); writeFileSync(sourcePath, source);
  const projectId = randomUUID(), targetId = randomUUID(), projectRevision = 1;
  writeFileSync(join(projectRoot, 'workbench.json'), JSON.stringify({ schemaVersion: 1, projectId, projectRevision, name: 'Dedicated Uno TASK-11 recovery drill', sketches: [{ path: '.', targetId }], targets: [{ targetId, fqbn: 'arduino:avr:uno', options: {} }], components: [], nets: [], codeBindings: [], documents: [], extensions: {} }, null, 2));
  const evidence: Record<string, unknown> = { schemaVersion: 1, taskId: 'TASK-11', runId, evidenceClass: 'real-hardware', startedAt: new Date().toISOString(), authorization: 'User authorized this dedicated Uno firmware replacement and unplug/replug bench on 2026-11-04; no actuators.', projectId, projectRevision, serial, fqbn: 'arduino:avr:uno', sourceSha256: hash(source), environment: { platform: platform(), release: release(), arch: arch(), node: process.version, cpu: cpus()[0]?.model ?? null, totalMemoryBytes: totalmem() }, checks: [], limitations: ['Uploader and observed serial behavior are separate from wiring, sensor, actuator or physical function verification.', 'Serial open can reset this Uno. A dropped capture is partial, with unknown loss count.', 'The companion is killed only during capture; flashing is never intentionally interrupted.'] };
  const checks = evidence.checks as Record<string, unknown>[], resultPath = join(directory, 'result.json'), progressPath = join(directory, 'progress.json');
  const save = () => writeFileSync(resultPath, JSON.stringify(evidence, null, 2) + '\n');
  const phase = (name: string, details: Record<string, unknown> = {}) => { evidence.phase = name; save(); writeFileSync(progressPath, JSON.stringify({ runId, phase: name, occurredAt: new Date().toISOString(), ...details }, null, 2) + '\n'); console.log(`TASK11_CHECKPOINT ${name} ${progressPath}`); };
  const companionScript = resolve('apps/extension/dist/companion.js'), nativeBindingPath = resolve('apps/extension/dist/vendor/node_modules/@serialport/bindings-cpp');
  evidence.companionSha256 = hash(readFileSync(companionScript));
  let disconnected!: () => void, disconnectedPromise!: Promise<void>;
  const clientForProject = () => { disconnectedPromise = new Promise<void>(resolve => { disconnected = resolve; }); return new CompanionClient(companionScript, process.execPath, line => { if (line) console.log(line); }, () => disconnected(), { projectRoot, dataRoot, arduinoPath, nativeBindingPath }); };
  let client = clientForProject();
  const rpc = <T>(method: ProjectRequest['method'], params: Record<string, unknown> = {}, expectedProjectRevision?: number) => client.requestProject({ schemaVersion: 1, requestId: randomUUID(), projectId, method, params, ...(expectedProjectRevision === undefined ? {} : { expectedProjectRevision }) }) as Promise<T>;
  const terminal = async (operation: OperationReceipt, deadlineMs = 180000): Promise<OperationReceipt> => {
    const deadline = Date.now() + deadlineMs;
    while (['queued', 'running', 'awaiting-input'].includes(operation.status)) { assert.ok(Date.now() < deadline, 'Operation deadline reached; inspect receipt rather than replay.'); await pause(150); operation = await rpc('operation.get', { operationId: operation.operationId }); }
    return operation;
  };
  const discover = async () => (await rpc<{ devices: DeviceSnapshot[] }>('device.discover')).devices.filter(device => device.observation.connected && device.observation.identity?.serialNumber === serial);
  const identify = async () => { const matches = await discover(); assert.equal(matches.length, 1, 'Exactly one matching USB identity is required.'); return rpc<DeviceSnapshot>('device.select', { deviceId: matches[0].observation.deviceId, expectedDeviceObservationId: matches[0].observation.observationId }); };
  const capture = async (device: DeviceSnapshot) => {
    const operation = await rpc<OperationReceipt>('serial.capture', { deviceId: device.observation.deviceId, baudRate: 9600, durationMs: 600000 });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const snapshot = await rpc<{ recordings: { recordingId: string; completion: string; device: string }[]; profiles: { id: string }[] }>('telemetry.snapshot');
      const active = snapshot.recordings.find(recording => recording.completion === 'active' && recording.device === device.observation.deviceId);
      if (active) {
        const live = await rpc<{ live: { text: string } }>('telemetry.live', { recordingId: active.recordingId, profileId: snapshot.profiles[0].id });
        if (/counter:\d+/.test(live.live.text)) return { operation, recordingId: active.recordingId };
      }
      const state = await rpc<OperationReceipt>('operation.get', { operationId: operation.operationId }); assert.ok(['queued', 'running'].includes(state.status), JSON.stringify(state)); await pause(100);
    }
    throw Error('No real probe counter bytes observed within capture deadline.');
  };
  const retained = (recordingId: string) => rawBytes(cursor => rpc<RawPage>('recording.query', { recordingId, range: { startMs: 0, endMs: 360000, timeBasis: 'host-receive' }, limit: 500, ...(cursor ? { cursor } : {}) }));
  try {
    phase('starting'); await client.start(); evidence.toolchain = await rpc('toolchain.inspect'); let device = await identify(); evidence.device = device; save();
    const prepared = await rpc<{ sourceSnapshotId: string }>('project.prepareBuild', { targetId, documentHashes: [{ path: 'WorkbenchProbe.ino', sha256: hash(source) }] }, projectRevision);
    evidence.sourceSnapshotId = prepared.sourceSnapshotId; save();
    const buildAdmission = await rpc<OperationReceipt>('build.compile', { targetId, sourceSnapshotId: prepared.sourceSnapshotId }, projectRevision); evidence.buildAdmission = buildAdmission; save();
    const built = await terminal(buildAdmission); evidence.build = built; assert.equal(built.status, 'succeeded', JSON.stringify(built.error));
    const build = built.result as { buildId: string; uploadArtifact: { artifactId: string; sha256: string } }; assert.ok(build.uploadArtifact); phase('compiled', { artifactSha256: build.uploadArtifact.sha256 });
    const monitoring = await capture(device);
    const uploaded = await terminal(await rpc<OperationReceipt>('firmware.upload', { buildId: build.buildId, artifactId: build.uploadArtifact.artifactId, artifactSha256: build.uploadArtifact.sha256, deviceId: device.observation.deviceId, expectedDeviceObservationId: device.observation.observationId, fqbn: 'arduino:avr:uno', resumeMonitoring: true }, projectRevision)); evidence.upload = uploaded; assert.equal(uploaded.status, 'succeeded', JSON.stringify(uploaded.error));
    await pause(4000); await rpc('operation.cancel', { operationId: monitoring.operation.operationId }); evidence.monitorHandoff = await terminal(monitoring.operation);
    const first = await retained(monitoring.recordingId); assert.match(first.bytes.toString('utf8'), /ROBOTICS_WORKBENCH_PROBE_V1/); assert.match(first.bytes.toString('utf8'), /counter:\d+/); assert.ok(first.gaps.some(gap => gap.cause === 'upload'));
    writeFileSync(join(directory, 'handoff.raw'), first.bytes); evidence.handoffRawSha256 = first.sha256;
    checks.push({ testId: 'task11.hardware.exact-upload-handoff', result: 'passed', artifactSha256: build.uploadArtifact.sha256, recordingId: monitoring.recordingId, rawSha256: first.sha256, operationId: uploaded.operationId });
    phase('external-port-contention');
    const ownerCode = "const b=require(process.argv[1]).autoDetect();b.open({path:process.argv[2],baudRate:9600,dataBits:8,stopBits:1,parity:'none'}).then(p=>{process.send('held');process.on('message',async()=>{await p.close();process.disconnect()})}).catch(e=>{process.stderr.write(String(e));process.exit(1)})";
    const external = spawn(process.execPath, ['-e', ownerCode, nativeBindingPath, device.observation.transportPath], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: Object.fromEntries(['SystemRoot', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]!])) });
    const externalExit = new Promise<number | null>(resolve => external.once('close', resolve)); let externalError = '';
    external.stderr?.on('data', chunk => { externalError = (externalError + String(chunk)).slice(-4096); });
    try {
      await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(Error('External native serial owner did not confirm its handle.')), 10000); external.once('message', message => { clearTimeout(timer); message === 'held' ? resolve() : reject(Error('Invalid native owner acknowledgement.')); }); external.once('error', error => { clearTimeout(timer); reject(error); }); external.once('exit', () => { clearTimeout(timer); reject(Error('External owner exited: ' + externalError)); }); });
      const busy = await terminal(await rpc<OperationReceipt>('serial.capture', { deviceId: device.observation.deviceId, baudRate: 9600, durationMs: 1000 }));
      assert.equal(busy.status, 'failed'); assert.equal(external.exitCode, null); evidence.externalContention = busy;
      checks.push({ testId: 'task11.hardware.external-contention', result: 'passed', operationId: busy.operationId, externalOwnerPreserved: true });
    } finally {
      if (external.connected) external.send('close');
      else if (external.exitCode === null && external.signalCode === null) external.kill('SIGKILL');
      let code: number | null;
      try { code = await deadline(externalExit, 10000, 'External fixture closure was not observed.'); }
      catch (error) { external.kill('SIGKILL'); throw error; }
      assert.equal(code, 0);
    }
    device = await identify();
    let unplug = await capture(device); phase('waiting-for-unplug', { deviceId: device.observation.deviceId, port: device.observation.transportPath, instruction: 'Unplug only the dedicated Uno USB cable. The drill detects disappearance; do not reconnect until the next checkpoint.', deadlineMs: 300000, recordingId: unplug.recordingId });
    const absentDeadline = Date.now() + 300000;
    while ((await discover()).length) {
      assert.ok(Date.now() < absentDeadline, 'Dedicated Uno was not unplugged within five minutes.');
      await pause(500);
    }
    const unplugged = await terminal(unplug.operation); evidence.unplugCapture = unplugged; assert.equal(unplugged.status, 'failed', 'Observed removal must not claim complete capture.');
    const disconnectedRaw = await retained(unplug.recordingId); assert.ok(disconnectedRaw.bytes.length > 0); assert.ok(disconnectedRaw.gaps.some(gap => gap.cause === 'disconnect' && gap.lostBytes === null)); writeFileSync(join(directory, 'unplug.raw'), disconnectedRaw.bytes);
    checks.push({ testId: 'task11.hardware.physical-unplug', result: 'passed', operationId: unplugged.operationId, recordingId: unplug.recordingId, rawSha256: disconnectedRaw.sha256 });
    phase('waiting-for-replug', { instruction: 'Reconnect that same dedicated Uno. The drill checks the exact USB serial and never uploads again.', deadlineMs: 300000 });
    const returnDeadline = Date.now() + 300000; while (!(await discover()).length) { assert.ok(Date.now() < returnDeadline, 'Dedicated Uno did not return within five minutes.'); await pause(500); }
    device = await identify(); evidence.reconnectedDevice = device;
    const returned = await capture(device); await rpc('operation.cancel', { operationId: returned.operation.operationId }); await terminal(returned.operation); const returnedRaw = await retained(returned.recordingId); assert.match(returnedRaw.bytes.toString('utf8'), /counter:\d+/); writeFileSync(join(directory, 'replug.raw'), returnedRaw.bytes);
    checks.push({ testId: 'task11.hardware.same-device-replug', result: 'passed', recordingId: returned.recordingId, rawSha256: returnedRaw.sha256, uploadReplayed: false });
    const interrupted = await capture(device); phase('crashing-capture-only', { recordingId: interrupted.recordingId });
    const pid = client.pid; assert.ok(pid); assert.equal((await rpc<OperationReceipt>('operation.get', { operationId: uploaded.operationId })).status, 'succeeded');
    process.kill(pid, 'SIGKILL');
    await deadline(disconnectedPromise, 10000, 'Companion process exit was not observed.');
    client = clientForProject(); await client.start();
    const recovered = await rpc<{ recordings: { recordingId: string; completion: string }[] }>('telemetry.snapshot'); assert.equal(recovered.recordings.find(recording => recording.recordingId === interrupted.recordingId)?.completion, 'partial');
    const oldCapture = await rpc<OperationReceipt>('operation.get', { operationId: interrupted.operation.operationId }); assert.ok(['failed', 'cancelled'].includes(oldCapture.status)); evidence.crashCaptureReceipt = oldCapture;
    const crashedRaw = await retained(interrupted.recordingId); assert.match(crashedRaw.bytes.toString('utf8'), /counter:\d+/); assert.ok(crashedRaw.gaps.some(gap => gap.cause === 'service-restart' && gap.lostBytes === null)); writeFileSync(join(directory, 'restart.raw'), crashedRaw.bytes);
    assert.deepEqual(await rpc<DeviceSnapshot[]>('device.status'), [], 'Restart must not reopen a board from archived state.');
    checks.push({ testId: 'task11.hardware.capture-process-loss', result: 'passed', recordingId: interrupted.recordingId, rawSha256: crashedRaw.sha256, uploadReplayed: false, portReopened: false });
    await client.stop();
    const store = new WorkbenchStore(dataRoot);
    try {
      const uploads = store.listOperations(projectId).filter(operation => operation.kind === 'upload'); assert.equal(uploads.length, 1); assert.deepEqual(uploads[0], uploaded);
      evidence.recordings = store.listRecords<StoredRecording>('recordings', projectId).map(recording => ({ ...recording, segments: recording.segments.map(segment => { const bytes = store.readArtifact(projectId, segment.artifactId); assert.equal(hash(bytes), segment.sha256); return { ...segment, checkedSha256: hash(bytes) }; }) }));
      evidence.operationCount = store.listOperations(projectId).length;
    } finally { store.close(); }
    for (const check of checks) Object.assign(check, { deviceId: device.observation.deviceId, fqbn: 'arduino:avr:uno', firmwareArtifactSha256: build.uploadArtifact.sha256, sourceSnapshotId: prepared.sourceSnapshotId, projectRevision, wiringConfirmationRef: null, wiringLimitation: 'Dedicated Uno with no sensor/actuator wiring under test; no physical wiring verification is claimed.' });
    assert.equal(hash(readFileSync(sourcePath)), hash(source)); evidence.result = 'passed'; phase('completed');
  } catch (error) { evidence.result = 'failed'; evidence.error = String(error); phase('failed'); throw error; }
  finally { await client.stop(); evidence.endedAt = new Date().toISOString(); save(); console.log(`TASK-11 hardware evidence ${resultPath}`); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
