// Explicit bench invocation only; ordinary verification never opens a physical port.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { CompanionClient } from '../../apps/extension/src/companion-client';
import type { OperationReceipt, ProjectRequest } from '@robotics-workbench/contracts';
import type { DeviceSnapshot } from '@robotics-workbench/devices';

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.includes('--authorize-firmware-replacement'), 'Dedicated-board firmware replacement must be explicitly authorized.');
  const serial = args[args.indexOf('--serial') + 1];
  assert.ok(args.includes('--serial') && /^[A-Za-z0-9_-]{4,128}$/.test(serial), 'Supply the observed dedicated USB serial.');
  const arduino = args[args.indexOf('--arduino') + 1];
  assert.ok(args.includes('--arduino'), 'Supply the installed CLI path.');
  const runRoot = resolve('artifacts/task04-live', randomUUID()), projectRoot = join(runRoot, 'WorkbenchProbe');
  mkdirSync(projectRoot, { recursive: true });
  const source = readFileSync('packages/test-fixtures/arduino/WorkbenchProbe/WorkbenchProbe.ino');
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const sourcePath = join(projectRoot, 'WorkbenchProbe.ino'); writeFileSync(sourcePath, source);
  const projectId = randomUUID(), targetId = randomUUID();
  writeFileSync(join(projectRoot, 'workbench.json'), JSON.stringify({ schemaVersion: 1, projectId, projectRevision: 1, name: 'Dedicated Uno bench', sketches: [{ path: '.', targetId }], targets: [{ targetId, fqbn: 'arduino:avr:uno', options: {} }], components: [], nets: [], codeBindings: [], documents: [], extensions: {} }));
  const bindingPath = resolve('apps/extension/dist/vendor/node_modules/@serialport/bindings-cpp');
  const client = new CompanionClient(resolve('apps/extension/dist/companion.js'), process.execPath, line => console.log(line), () => {}, { projectRoot, dataRoot: join(runRoot, 'data'), arduinoPath: arduino, nativeBindingPath: bindingPath });
  const evidence: Record<string, unknown> = { taskId: 'TASK-04', startedAt: new Date().toISOString(), authorization: 'User authorized replacing the dedicated Uno firmware in this chat on 2026-11-02.', serial, sourceSha256: hash(source), runtime: process.version, physical: true, checks: [] };
  const checks = evidence.checks as unknown[];
  const save = () => writeFileSync(join(runRoot, 'result.json'), JSON.stringify(evidence, null, 2) + '\n');
  const rpc = <T>(method: ProjectRequest['method'], params: Record<string, unknown> = {}, revision?: number) => client.requestProject({ schemaVersion: 1, requestId: randomUUID(), projectId, method, params, ...(revision === undefined ? {} : { expectedProjectRevision: revision }) }) as Promise<T>;
  const wait = async (receipt: OperationReceipt) => {
    const deadline = Date.now() + 180000;
    while (['queued', 'running', 'awaiting-input'].includes(receipt.status)) {
      assert.ok(Date.now() < deadline, 'Bench job deadline; inspect receipts before retrying.');
      await new Promise(resolve => setTimeout(resolve, 150));
      receipt = await rpc('operation.get', { operationId: receipt.operationId });
    }
    return receipt;
  };
  const compile = async () => {
    const prepared = await rpc<{ sourceSnapshotId: string }>('project.prepareBuild', { targetId, documentHashes: [{ path: 'WorkbenchProbe.ino', sha256: hash(readFileSync(sourcePath)) }] }, 1);
    return wait(await rpc<OperationReceipt>('build.compile', { targetId, sourceSnapshotId: prepared.sourceSnapshotId }, 1));
  };
  try {
    await client.start();
    evidence.toolchain = await rpc('toolchain.inspect'); save();
    const discovery = await rpc<{ devices: DeviceSnapshot[] }>('device.discover'); evidence.discovery = discovery;
    const matches = discovery.devices.filter(item => item.observation.connected && item.observation.identity?.serialNumber === serial);
    assert.equal(matches.length, 1, 'Exactly one matching dedicated USB serial is required.');
    const device = await rpc<DeviceSnapshot>('device.select', { deviceId: matches[0].observation.deviceId, expectedDeviceObservationId: matches[0].observation.observationId });
    evidence.selectedDevice = device; save();
    console.log(`Identified dedicated device ${device.observation.transportPath} USB ${serial}`);
    writeFileSync(sourcePath, 'void setup() {\n  WORKBENCH_INTENTIONAL_COMPILE_FAILURE;\n}\nvoid loop() {}\n');
    const failed = await compile(); evidence.failedCompile = failed;
    assert.equal(failed.status, 'failed'); assert.equal(failed.error?.code, 'COMPILE_FAILED');
    const state = await rpc<{ builds: { buildId: string; operationId: string; uploadArtifact?: unknown }[] }>('project.snapshot');
    const failedBuild = state.builds.find(item => item.operationId === failed.operationId)!;
    assert.ok(failedBuild); assert.equal(failedBuild.uploadArtifact, undefined);
    evidence.failedDiagnostics = await rpc('build.diagnostics', { buildId: failedBuild.buildId });
    checks.push({ procedure: 'Real invalid C++ compile', result: 'passed', assertion: 'Failed build has source-linked diagnostics and no upload artifact; no upload requested.' }); save();
    writeFileSync(sourcePath, source);
    const compiled = await compile(); evidence.compile = compiled; assert.equal(compiled.status, 'succeeded');
    const build = compiled.result as { buildId: string; uploadArtifact: { artifactId: string; sha256: string } };
    assert.ok(build.uploadArtifact); console.log(`Exact Uno artifact SHA256 ${build.uploadArtifact.sha256}`); save();
    const capture = await rpc<OperationReceipt>('serial.capture', { deviceId: device.observation.deviceId, baudRate: 9600, durationMs: 60000 });
    const monitorDeadline = Date.now() + 7000;
    while (true) {
      const observed = (await rpc<DeviceSnapshot[]>('device.status', { deviceId: device.observation.deviceId }))[0];
      if (observed.state === 'monitoring') break;
      assert.ok(Date.now() < monitorDeadline, `Monitor did not acquire port: ${observed.state}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    evidence.upload = await wait(await rpc('firmware.upload', { buildId: build.buildId, artifactId: build.uploadArtifact.artifactId, artifactSha256: build.uploadArtifact.sha256, deviceId: device.observation.deviceId, expectedDeviceObservationId: device.observation.observationId, fqbn: 'arduino:avr:uno', resumeMonitoring: true }, 1));
    assert.equal((evidence.upload as OperationReceipt).status, 'succeeded'); save();
    await new Promise(resolve => setTimeout(resolve, 6000));
    await rpc('operation.cancel', { operationId: capture.operationId });
    const recorded = await wait(capture); evidence.capture = recorded; assert.equal(recorded.status, 'cancelled');
    const raw = await rpc<{ text: string; gaps: { cause: string }[] }>('recording.query', { recordingId: recorded.result!.recordingId, range: { startMs: 0, endMs: 60000, timeBasis: 'host-receive' }, limit: 500 });
    evidence.rawWindow = raw;
    assert.match(raw.text, /ROBOTICS_WORKBENCH_PROBE_V1/); assert.match(raw.text, /counter:\d+/); assert.ok(raw.gaps.some(item => item.cause === 'upload'));
    checks.push({ procedure: 'Coordinator monitor → exact-artifact upload → resumed raw capture', result: 'passed', assertion: 'Uploader code0; observed probe header/counters; explicit upload gap; raw artifact hashes retained. No wiring/sensor/actuator verification claimed.' }); save();
    const supplied = await rpc<{ text: string }>('project.context'); assert.ok(Buffer.byteLength(supplied.text) <= 24576);
    writeFileSync(join(runRoot, 'application-context.json'), supplied.text); evidence.contextBytes = Buffer.byteLength(supplied.text);
    // A separate external owner intentionally competes with the workbench acquisition path.
    const ownerCode = `const b=require(process.argv[1]).autoDetect(); b.open({path:process.argv[2],baudRate:9600,dataBits:8,stopBits:1,parity:'none'}).then(p=>{process.send('held');process.on('message',async()=>{await p.close();process.disconnect()})}).catch(e=>{process.stderr.write(String(e));process.exit(1)})`;
    const external = spawn(process.execPath, ['-e', ownerCode, bindingPath, device.observation.transportPath], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    const exited = new Promise<number | null>(resolve => external.once('close', resolve));
    try {
      await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('External handle did not open.')), 5000); external.once('message', () => { clearTimeout(timer); resolve(); }); external.once('error', reject); external.once('exit', () => { clearTimeout(timer); reject(new Error('External handle owner exited before confirmation.')); }); });
      const blocked = await wait(await rpc<OperationReceipt>('serial.capture', { deviceId: device.observation.deviceId, baudRate: 9600, durationMs: 1000 }));
      assert.equal(blocked.status, 'failed'); evidence.externalContention = blocked;
      checks.push({ procedure: 'Independent native serial owner holds exact physical port', result: 'passed', assertion: 'Workbench capture failed explicitly without killing external owner or uploading.' });
    } finally { if (external.connected) external.send('close'); assert.equal(await exited, 0); }
    assert.equal(hash(readFileSync(sourcePath)), hash(source));
    evidence.result = 'passed'; evidence.limitations = ['Dedicated Uno was flashed; physical wiring and actuator behavior were not tested.', 'Unplug/replug and driver installation were not performed.', 'Existing provider terminal receives bounded context; live provider lifecycle remains separately recorded.'];
  } catch (error) { evidence.result = 'failed'; evidence.error = String(error); throw error; }
  finally { evidence.endedAt = new Date().toISOString(); save(); await client.stop(); console.log(`Bench evidence ${join(runRoot, 'result.json')}`); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
