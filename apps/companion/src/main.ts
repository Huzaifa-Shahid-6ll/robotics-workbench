import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { isControlRequest, isRequestId, isProjectRequest, methodPolicies, WorkbenchError, type ControlResponse, type ProjectResponse } from '@robotics-workbench/contracts';
import { ProjectService } from './project-service';
import { HardwareService } from './hardware-service';
import { AgentService } from './agent-service';
import { ReviewService } from './review-service';
import { WiringService } from './wiring-service';
import { DocumentService } from './document-service';
import { TelemetryService } from './telemetry-service';
import { KicadService } from './kicad-service';
import { CadService } from './cad-service';
import { RecoveryService } from './recovery-service';
import { DiagnosticsService } from './diagnostics-service';

if (!process.send || process.platform !== 'win32' || process.arch !== 'x64' || !process.version.startsWith('v24.') || Number(process.versions.node.split('.')[1]) < 18) {
  process.stderr.write('Companion requires inherited IPC and local Windows x64 Node 24.\n');
  process.exit(1);
}

// This pipe reserves ownership only; it never accepts control messages.
const owner = createServer(socket => socket.destroy());
const pipe = `\\\\.\\pipe\\robotics-workbench-${createHash('sha256').update(homedir().toLowerCase()).digest('hex').slice(0, 24)}`;
let ready = false;
let stopping = false;
let project: ProjectService | undefined;
let hardware: HardwareService | undefined;
let agents: AgentService | undefined;
let wiring: WiringService | undefined;
let kicad: KicadService | undefined;
let cad: CadService | undefined;
function toolOption(name: string): string | undefined { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
function configuredKicad(): KicadService { return kicad ??= new KicadService(configuredProject(), { executable: toolOption('--kicad-path'), testedExecutableSha256: toolOption('--kicad-sha256') }); }
function configuredCad(): CadService { return cad ??= new CadService(configuredProject(), { pythonPath: toolOption('--cad-python-path'), trusted: true }); }
function configuredWiring(): WiringService { return wiring ??= new WiringService(configuredProject()); }
function configuredAgents(): AgentService {
  const args = process.argv.slice(2);
  const option = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] ?? '' : '';
  configuredWiring();
  configuredDocuments();
  configuredTelemetry();
  return agents ??= new AgentService(configuredProject(), configuredHardware(), { codexPath: option('--codex-path'), opencodePath: option('--opencode-path'), nodePath: process.execPath, mcpScript: join(__dirname, 'mcp-stdio.js') });
}

function configuredDocuments(): DocumentService { const bound = configuredProject(); return bound.references as DocumentService ?? new DocumentService(bound); }
function configuredTelemetry(): TelemetryService { const bound = configuredProject(); return bound.telemetry as TelemetryService ?? new TelemetryService(bound, configuredHardware()); }

function configuredHardware(): HardwareService {
  if (hardware) return hardware;
  const args = process.argv.slice(2);
  const arduinoPath = args.includes('--arduino-path') ? args[args.indexOf('--arduino-path') + 1] : '';
  if (arduinoPath && !isAbsolute(arduinoPath)) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Arduino CLI settings require an absolute executable path.');
  const nativePath = args.includes('--native-binding-path') ? args[args.indexOf('--native-binding-path') + 1] : join(__dirname, 'vendor/node_modules/@serialport/bindings-cpp');
  hardware = new HardwareService(configuredProject(), arduinoPath, nativePath);
  return hardware;
}

function configuredProject(): ProjectService {
  if (project) return project;
  const args = process.argv.slice(2);
  const projectRoot = args[args.indexOf('--project-root') + 1];
  const dataRoot = args[args.indexOf('--data-root') + 1];
  if (!args.includes('--project-root') || !args.includes('--data-root') || !isAbsolute(projectRoot ?? '') || !isAbsolute(dataRoot ?? '')) {
    throw new Error('No trusted project binding was supplied by the host.');
  }
  project = new ProjectService(projectRoot, dataRoot);
  return project;
}

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try { try { await agents?.close(); } finally { await project?.shutdown(); } }
  catch { process.stderr.write('OUTCOME_UNKNOWN: Shutdown could not reconcile every operation; inspect receipts on restart.\n'); process.exitCode = 1; }
  if (owner.listening) owner.close();
  if (process.connected) process.disconnect();
}

function send(response: ControlResponse | ProjectResponse, after?: () => void): void {
  process.send?.(response, undefined, undefined, (error: Error | null) => {
    if (error) stop();
    else after?.();
  });
}

owner.on('error', error => {
  process.stderr.write((error as NodeJS.ErrnoException).code === 'EADDRINUSE'
    ? 'DEVICE_BUSY: Another Robotics Workbench window owns the companion. Close that window and retry.\n'
    : 'INTERNAL_ERROR: Companion ownership could not be established.\n');
  process.exitCode = 1;
  stop();
});
owner.listen(pipe, () => { ready = true; });
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('message', async (message: unknown) => {
  const envelope = message as { requestId?: unknown; method?: unknown; schemaVersion?: unknown } | null;
  if (ready && !stopping && envelope && isRequestId(envelope.requestId) &&
      isProjectRequest(message)) {
    try {
      const base = ['project.snapshot', 'component.inspect', 'connections.query', 'operation.get', 'operation.cancel', 'device.status'].includes(message.method);
      if (['project.snapshot', 'device.status'].includes(message.method)) configuredHardware();
      if (message.method === 'project.snapshot') {
        const inputHashes = await configuredHardware().inputHashesAsync();
        send(configuredProject().handle(message, { inputHashes }));
        return;
      }
      if (message.method === 'serial.capture') configuredTelemetry();
      if (['recovery.inspect', 'project.export', 'project.restore'].includes(message.method)) {
        send(new RecoveryService(configuredProject()).handle(message));
        return;
      }
      if (message.method.startsWith('diagnostics.')) {
        send(await new DiagnosticsService(configuredProject(), { appVersion: '0.1.0' }).handle(message));
        return;
      }
      send(message.method.startsWith('kicad.') ? await configuredKicad().handle(message) : message.method.startsWith('cad.') ? await configuredCad().handle(message) : message.method.startsWith('telemetry.') || message.method.startsWith('experiment.') ? await configuredTelemetry().handle(message) : message.method.startsWith('document.') ? await configuredDocuments().handle(message) : message.method.startsWith('wiring.') || ['component.inspect', 'connections.query'].includes(message.method) ? configuredWiring().handle(message) : message.method.startsWith('review.') || message.method === 'artifact.preview' ? new ReviewService(configuredProject()).handle(message) : message.method.startsWith('agent.') ? await configuredAgents().handle(message) : base ? configuredProject().handle(message) : await configuredHardware().handle(message));
    }
    catch (error) { send({ schemaVersion: 1, requestId: envelope.requestId, error: {
      code: envelope.schemaVersion !== 1 ? 'UNSUPPORTED_SCHEMA' : error instanceof WorkbenchError ? error.code : 'INVALID_REQUEST', message: error instanceof WorkbenchError ? error.message : 'Project binding, storage or request is invalid. Reopen the project and inspect its manifest.', retryable: false
    } }); }
    return;
  }
  if (!isControlRequest(message)) {
    const candidate = message as { requestId?: unknown; schemaVersion?: unknown; method?: unknown } | null;
    if (!candidate || !isRequestId(candidate.requestId)) return;
    const code = candidate.schemaVersion !== 1 ? 'UNSUPPORTED_SCHEMA'
      : typeof candidate.method === 'string' && Object.hasOwn(methodPolicies, candidate.method) ? 'INVALID_REQUEST'
      : typeof candidate.method === 'string' && !['companion.hello', 'companion.shutdown'].includes(candidate.method)
        ? 'UNKNOWN_METHOD' : 'INVALID_REQUEST';
    send({ schemaVersion: 1, requestId: candidate.requestId, error: { code, message: 'Unsupported or malformed lifecycle request.', retryable: false } });
    return;
  }
  if (stopping || !ready) {
    send({ schemaVersion: 1, requestId: message.requestId, error: { code: 'DEVICE_BUSY', message: 'Companion is not ready.', retryable: true } });
    return;
  }
  if (message.method === 'companion.shutdown') {
    send({ schemaVersion: 1, requestId: message.requestId, result: { state: 'stopping' } }, stop);
  } else {
    send({ schemaVersion: 1, requestId: message.requestId, result: {
      state: 'ready', pid: process.pid, runtimeVersion: process.version, platform: 'win32', arch: 'x64'
    } });
  }
});
