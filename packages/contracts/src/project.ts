import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import manifestSchema from '../../../contracts/workbench.schema.json';
import requestSchema from '../../../contracts/request.schema.json';
import responseSchema from '../../../contracts/response.schema.json';
import eventSchema from '../../../contracts/event.schema.json';
import operationSchema from '../../../contracts/operation.schema.json';
import contextSchema from '../../../contracts/context-packet.schema.json';
import { kicadMethodPolicies, kicadParamSchemas } from './kicad';
import { cadMethodPolicies, cadParamSchemas } from './cad';
import { diagnosticMethodPolicies, diagnosticParamSchemas } from './diagnostics';

export type OperationStatus = 'queued' | 'running' | 'awaiting-input' | 'succeeded' | 'failed' | 'cancelled' | 'outcome-unknown';
export type WorkbenchManifest = {
  schemaVersion: 1;
  projectId: string;
  projectRevision: number;
  name: string;
  sketches: { path: string; targetId: string }[];
  targets: { targetId: string; fqbn: string; options: Record<string, string> }[];
  components: {
    componentId: string;
    label: string;
    definition: { definitionId: string; definitionVersion: string } | null;
    properties?: Record<string, unknown>;
    identityStatus?: 'unresolved' | 'resolved';
    candidateLabels?: string[];
    evidenceRefs?: string[];
    provisionalPins?: { pinId: string; label: string }[];
  }[];
  nets: {
    netId: string;
    label?: string;
    members: { componentId: string; pinId: string }[];
    intent?: { domainId?: string; designState?: 'proposed' | 'accepted'; sourceRefs?: string[] };
  }[];
  codeBindings: { bindingId: string; componentId: string; pinId?: string; path: string; symbol?: string; line?: number }[];
  documents: { documentId: string; path: string; title?: string; componentIds?: string[] }[];
  extensions: Record<string, unknown>;
};

export const methodPolicies = {
  'recovery.inspect': { classification: 'read', deadlineMs: 10000 },
  'review.relocation': { classification: 'read', deadlineMs: 10000 },
  'device.reconcile': { classification: 'mutate', deadlineMs: 10000 },
  'project.export': { classification: 'mutate', deadlineMs: 120000 },
  'project.restore': { classification: 'mutate', deadlineMs: 120000 },
  ...kicadMethodPolicies,
  ...cadMethodPolicies,
  ...diagnosticMethodPolicies,
  'telemetry.snapshot': { classification: 'read', deadlineMs: 10000 },
  'telemetry.inspect': { classification: 'read', deadlineMs: 15000 },
  'telemetry.live': { classification: 'read', deadlineMs: 10000 },
  'telemetry.derive': { classification: 'execute', deadlineMs: 5000 },
  'telemetry.query': { classification: 'read', deadlineMs: 15000 },
  'telemetry.selection': { classification: 'read', deadlineMs: 15000 },
  'telemetry.exportSelection': { classification: 'read', deadlineMs: 30000 },
  'telemetry.stopCapture': { classification: 'mutate', deadlineMs: 10000 },
  'experiment.create': { classification: 'mutate', deadlineMs: 10000 },
  'experiment.transition': { classification: 'mutate', deadlineMs: 10000 },
  'experiment.attach': { classification: 'mutate', deadlineMs: 15000 },
  'experiment.note': { classification: 'mutate', deadlineMs: 10000 },
  'experiment.segment': { classification: 'mutate', deadlineMs: 10000 },
  'experiment.judge': { classification: 'mutate', deadlineMs: 15000 },
  'experiment.compare': { classification: 'read', deadlineMs: 30000 },
  'experiment.export': { classification: 'read', deadlineMs: 30000 },
  'document.list': { classification: 'read', deadlineMs: 10000 },
  'document.ingest': { classification: 'execute', deadlineMs: 5000 },
  'document.page': { classification: 'read', deadlineMs: 30000 },
  'document.query': { classification: 'read', deadlineMs: 10000 },
  'document.excerpt': { classification: 'read', deadlineMs: 10000 },
  'document.expand': { classification: 'read', deadlineMs: 10000 },
  'document.original': { classification: 'read', deadlineMs: 10000 },
  'document.rebuild': { classification: 'mutate', deadlineMs: 30000 },
  'wiring.snapshot': { classification: 'read', deadlineMs: 10000 },
  'wiring.plan': { classification: 'read', deadlineMs: 10000 },
  'wiring.check': { classification: 'read', deadlineMs: 10000 },
  'wiring.accept': { classification: 'mutate', deadlineMs: 10000 },
  'wiring.observe': { classification: 'mutate', deadlineMs: 10000 },
  'review.load': { classification: 'read', deadlineMs: 10000 },
  'review.save': { classification: 'mutate', deadlineMs: 10000 },
  'artifact.preview': { classification: 'read', deadlineMs: 10000 },
  'agent.inspect': { classification: 'read', deadlineMs: 60000 },
  'agent.start': { classification: 'execute', deadlineMs: 120000 },
  'agent.get': { classification: 'read', deadlineMs: 10000 },
  'agent.list': { classification: 'read', deadlineMs: 10000 },
  'agent.interrupt': { classification: 'mutate', deadlineMs: 30000 },
  'agent.reconcile': { classification: 'read', deadlineMs: 30000 },
  'agent.approval': { classification: 'mutate', deadlineMs: 30000 },
  'agent.authorizeUpload': { classification: 'mutate', deadlineMs: 5000 },
  'agent.handoff': { classification: 'read', deadlineMs: 10000 },
  'toolchain.inspect': { classification: 'read', deadlineMs: 60000 },
  'device.discover': { classification: 'read', deadlineMs: 15000 },
  'device.select': { classification: 'mutate', deadlineMs: 5000 },
  'project.prepareBuild': { classification: 'mutate', deadlineMs: 60000 },
  'project.context': { classification: 'read', deadlineMs: 10000 },
  'project.snapshot': { classification: 'read', deadlineMs: 10000 },
  'component.inspect': { classification: 'read', deadlineMs: 10000 },
  'connections.query': { classification: 'read', deadlineMs: 10000 },
  'build.compile': { classification: 'execute', deadlineMs: 5000 },
  'build.diagnostics': { classification: 'read', deadlineMs: 10000 },
  'device.status': { classification: 'read', deadlineMs: 10000 },
  'firmware.upload': { classification: 'execute', deadlineMs: 5000 },
  'serial.capture': { classification: 'execute', deadlineMs: 5000 },
  'recording.query': { classification: 'read', deadlineMs: 10000 },
  'experiment.record': { classification: 'mutate', deadlineMs: 5000 },
  'operation.get': { classification: 'read', deadlineMs: 10000 },
  'operation.cancel': { classification: 'mutate', deadlineMs: 5000 }
} as const;
export type ProjectMethod = keyof typeof methodPolicies;
export type ProjectRequest = {
  schemaVersion: 1;
  requestId: string;
  projectId: string;
  method: ProjectMethod;
  expectedProjectRevision?: number;
  params: Record<string, unknown>;
};
export type ErrorResult = { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
export type ProjectResponse = { schemaVersion: 1; requestId: string } & (
  | { result: unknown; error?: never }
  | { error: ErrorResult; result?: never }
);
export type ProjectEvent = {
  schemaVersion: 1; eventId: string; sequence: number; projectId: string; projectRevision: number;
  operationId?: string; type: string; occurredAt: string; payload: Record<string, unknown>;
};
export type OperationReceipt = {
  schemaVersion: 1; operationId: string; requestId: string; projectId: string;
  kind: 'compile' | 'upload' | 'serial-capture' | 'kicad-export' | 'cad-generate' | 'document-ingest' | 'experiment-record';
  status: OperationStatus; expectedProjectRevision: number;
  sourceSnapshotId?: string; deviceId?: string; createdAt: string; startedAt?: string; finishedAt?: string;
  tool: { name: string; version: string };
  artifacts: { artifactId: string; sha256: string; mediaType: string; relativePath: string }[];
  error?: ErrorResult; reconcilesOperationId?: string; result?: Record<string, unknown>;
};

export class WorkbenchError extends Error {
  readonly retryable = false;
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'WorkbenchError';
  }
}

const ajv = new Ajv({ strict: true, strictRequired: false, ownProperties: true });
addFormats(ajv);
const manifest = ajv.compile<WorkbenchManifest>(manifestSchema);
const request = ajv.compile<ProjectRequest>(requestSchema);
const response = ajv.compile<ProjectResponse>(responseSchema);
const event = ajv.compile<ProjectEvent>(eventSchema);
const operation = ajv.compile<OperationReceipt>(operationSchema);
const id = { type: 'string', format: 'uuid' };
const cursor = { type: 'string', minLength: 1, maxLength: 512 };
const limit = { type: 'integer', minimum: 1, maximum: 500 };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const documentCitation = object({ documentId: id, artifactSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, extractorVersion: { type: 'string', minLength: 1, maxLength: 128 }, page: { type: 'integer', minimum: 1, maximum: 2000 }, region: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'number', minimum: 0, maximum: 1 } }, textRange: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'integer', minimum: 0, maximum: 262144 } } }, ['documentId', 'artifactSha256', 'extractorVersion', 'page']);
export const projectParamSchemas = {
  'recovery.inspect': object({ cursor }),
  'review.relocation': object({ taskId: id }, ['taskId']),
  'device.reconcile': object({ operationId: id, deviceId: id, expectedDeviceObservationId: id, processTerminationConfirmed: { const: true }, note: { type: 'string', minLength: 1, maxLength: 2048 } }, ['operationId', 'deviceId', 'expectedDeviceObservationId', 'processTerminationConfirmed', 'note']),
  'project.export': object({ destination: { type: 'string', minLength: 1, maxLength: 4096 }, expectedManifestSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, documentHashes: { type: 'object', maxProperties: 1000, propertyNames: { maxLength: 1024 }, additionalProperties: { type: 'string', pattern: '^[a-f0-9]{64}$' } } }, ['destination', 'expectedManifestSha256', 'documentHashes']),
  'project.restore': object({ archiveDirectory: { type: 'string', minLength: 1, maxLength: 4096 }, newProjectRoot: { type: 'string', minLength: 1, maxLength: 4096 }, newDataRoot: { type: 'string', minLength: 1, maxLength: 4096 } }, ['archiveDirectory', 'newProjectRoot', 'newDataRoot']),
  ...kicadParamSchemas,
  ...cadParamSchemas,
  ...diagnosticParamSchemas,
  'telemetry.snapshot': object({ derivationId: id }),
  'telemetry.inspect': object({ derivationId: id }, ['derivationId']),
  'telemetry.live': object({ recordingId: id, profileId: id }, ['recordingId', 'profileId']),
  'telemetry.derive': object({ recordingId: id, profileId: id }, ['recordingId', 'profileId']),
  'telemetry.query': object({ derivationId: id, channelIds: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 128 } }, timeBasis: { enum: ['host-receive', 'device'] }, start: { type: 'number', minimum: 0 }, end: { type: 'number', minimum: 0 }, deviceEpoch: { type: 'integer', minimum: 0 } }, ['derivationId', 'channelIds', 'timeBasis', 'start', 'end']),
  'telemetry.selection': object({ selection: { type: 'object', maxProperties: 16 } }, ['selection']),
  'telemetry.exportSelection': object({ selection: { type: 'object', maxProperties: 16 } }, ['selection']),
  'telemetry.stopCapture': object({ recordingId: id }, ['recordingId']),
  'experiment.create': object({ procedureId: id, setup: { type: 'string', minLength: 1, maxLength: 8192 }, parameters: { type: 'object', maxProperties: 100 }, recordingId: id }, ['procedureId', 'setup', 'parameters']),
  'experiment.transition': object({ experimentId: id, expectedRevisionId: id, lifecycle: { enum: ['ready', 'running', 'completed', 'aborted'] } }, ['experimentId', 'expectedRevisionId', 'lifecycle']),
  'experiment.attach': object({ experimentId: id, expectedRevisionId: id, selection: { type: 'object', maxProperties: 16 } }, ['experimentId', 'expectedRevisionId', 'selection']),
  'experiment.note': object({ experimentId: id, expectedRevisionId: id, text: { type: 'string', minLength: 1, maxLength: 4096 }, reason: { type: 'string', minLength: 1, maxLength: 4096 } }, ['experimentId', 'expectedRevisionId', 'text', 'reason']),
  'experiment.segment': object({ experimentId: id, expectedRevisionId: id, configuration: { type: 'string', minLength: 1, maxLength: 8192 }, reason: { type: 'string', minLength: 1, maxLength: 4096 } }, ['experimentId', 'expectedRevisionId', 'configuration', 'reason']),
  'experiment.judge': object({ experimentId: id, expectedRevisionId: id, outcome: { enum: ['pass', 'fail', 'inconclusive'] }, criterion: { type: 'string', minLength: 1, maxLength: 4096 } }, ['experimentId', 'expectedRevisionId', 'outcome', 'criterion']),
  'experiment.compare': object({ experimentIds: { type: 'array', minItems: 2, maxItems: 6, uniqueItems: true, items: id } }, ['experimentIds']),
  'experiment.export': object({ experimentId: id }, ['experimentId']),
  'document.list': object({}),
  'document.ingest': object({ documentId: id, expectedSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, ['documentId', 'expectedSha256']),
  'document.page': documentCitation,
  'document.excerpt': documentCitation,
  'document.query': object({ query: { type: 'string', minLength: 1, maxLength: 1024 }, documentIds: { type: 'array', maxItems: 100, items: id }, componentId: id, limit: { type: 'integer', minimum: 1, maximum: 20 }, includeHistory: { type: 'boolean' } }, ['query']),
  'document.expand': object({ handle: { type: 'string', minLength: 1, maxLength: 2048 } }, ['handle']),
  'document.original': object({ documentId: id, artifactSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, ['documentId', 'artifactSha256']),
  'document.rebuild': object({}),
  'wiring.snapshot': object({}),
  'wiring.plan': object({ expectedManifestSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, operations: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object' } } }, ['expectedManifestSha256', 'operations']),
  'wiring.check': object({ previewId: id, expectedManifestSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, ['previewId', 'expectedManifestSha256']),
  'wiring.accept': object({ previewId: id, manifestSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, ['previewId', 'manifestSha256']),
  'wiring.observe': object({ subjectIds: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: id }, procedure: { type: 'string', minLength: 1, maxLength: 2048 }, note: { type: 'string', minLength: 1, maxLength: 4096 }, result: { enum: ['passed', 'failed', 'inconclusive'] }, observedAt: { type: 'string', format: 'date-time' }, expectedManifestSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, ['subjectIds', 'procedure', 'note', 'result', 'observedAt', 'expectedManifestSha256']),
  'review.load': object({ taskId: id }, ['taskId']),
  'review.save': object({ taskId: id, snapshot: { type: 'object', maxProperties: 16 } }, ['taskId', 'snapshot']),
  'artifact.preview': object({ artifactId: id }, ['artifactId']),
  'agent.inspect': object({ providerId: { enum: ['codex', 'opencode'] } }, ['providerId']),
  'agent.start': object({ taskId: id, clientTurnId: id, providerId: { enum: ['codex', 'opencode'] }, modelId: { type: 'string', minLength: 1, maxLength: 256 }, permissionProfileId: { enum: ['read-only', 'workspace-write'] }, userText: { type: 'string', minLength: 1, maxLength: 8192 }, sourceSnapshotId: { anyOf: [id, { type: 'null' }] }, handoffTaskId: id, pinnedIds: { type: 'array', maxItems: 100, uniqueItems: true, items: id }, selection: contextSchema.properties.selection }, ['taskId', 'clientTurnId', 'providerId', 'modelId', 'permissionProfileId', 'userText', 'sourceSnapshotId']),
  'agent.get': object({ taskId: id }, ['taskId']),
  'agent.list': object({}),
  'agent.interrupt': object({ taskId: id }, ['taskId']),
  'agent.reconcile': object({ taskId: id }, ['taskId']),
  'agent.approval': object({ taskId: id, answer: { type: 'object', maxProperties: 12 } }, ['taskId', 'answer']),
  'agent.authorizeUpload': object({ taskId: id, upload: { type: 'object', maxProperties: 8 } }, ['taskId', 'upload']),
  'agent.handoff': object({ taskId: id }, ['taskId']),
  'toolchain.inspect': object({}),
  'device.discover': object({}),
  'device.select': object({ deviceId: id, expectedDeviceObservationId: id }, ['deviceId', 'expectedDeviceObservationId']),
  'project.prepareBuild': object({ targetId: id, documentHashes: { type: 'array', maxItems: 1000, items: object({ path: { type: 'string', minLength: 1, maxLength: 4096 }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, ['path', 'sha256']) } }, ['targetId', 'documentHashes']),
  'project.context': object({}),
  'project.snapshot': object({
    selection: contextSchema.properties.selection,
    include: { type: 'array', maxItems: 16, uniqueItems: true, items: { enum: ['manifest', 'operations', 'artifacts'] } },
    limit, cursor
  }),
  'component.inspect': object({ componentId: id }, ['componentId']),
  'connections.query': { ...object({ componentId: id, netId: id, limit, cursor }), oneOf: [{ required: ['componentId'] }, { required: ['netId'] }] },
  'build.compile': object({ targetId: id, sourceSnapshotId: id }, ['targetId', 'sourceSnapshotId']),
  'build.diagnostics': object({ buildId: id, limit, cursor }, ['buildId']),
  'device.status': object({ deviceId: id }),
  'firmware.upload': object({ buildId: id, artifactId: id, artifactSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, deviceId: id,
    expectedDeviceObservationId: id, fqbn: { type: 'string', minLength: 1, maxLength: 256 }, resumeMonitoring: { type: 'boolean' } },
  ['buildId', 'artifactId', 'artifactSha256', 'deviceId', 'expectedDeviceObservationId', 'fqbn', 'resumeMonitoring']),
  'serial.capture': object({ deviceId: id, baudRate: { type: 'integer', minimum: 1, maximum: 4000000 }, durationMs: { type: 'integer', minimum: 1000, maximum: 3600000 } }, ['deviceId', 'baudRate', 'durationMs']),
  'recording.query': object({ recordingId: id, channelIds: { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 128 } },
    range: object({ startMs: { type: 'number', minimum: 0 }, endMs: { type: 'number', minimum: 0 }, timeBasis: { enum: ['host-receive', 'device', 'relative'] } }, ['startMs', 'endMs', 'timeBasis']), limit, cursor }, ['recordingId', 'range']),
  'experiment.record': object({ experimentId: id, expectedRevisionId: id, text: { type: 'string', minLength: 1, maxLength: 4096 }, reason: { type: 'string', minLength: 1, maxLength: 4096 } }, ['experimentId', 'expectedRevisionId', 'text', 'reason']),
  'operation.get': { ...object({ operationId: id, requestId: id }), oneOf: [{ required: ['operationId'] }, { required: ['requestId'] }] },
  'operation.cancel': object({ operationId: id }, ['operationId'])
};
const methodParams = Object.fromEntries(Object.entries(projectParamSchemas).map(([method, schema]) => [method, ajv.compile(schema)]));

function bounded(value: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'object') return Object.values(value).every(item => bounded(item, depth + 1));
  return false;
}
function withinLimits(value: unknown): boolean {
  try { return bounded(value) && new TextEncoder().encode(JSON.stringify(value) ?? '').byteLength <= 1024 * 1024; }
  catch { return false; }
}
export function isManifest(value: unknown): value is WorkbenchManifest {
  return withinLimits(value) && manifest(value) && Number.isSafeInteger(value.projectRevision);
}
export function isProjectRequest(value: unknown): value is ProjectRequest {
  if (!withinLimits(value) || !request(value) || !Object.hasOwn(methodPolicies, value.method)) return false;
  if (!methodParams[value.method](value.params)) return false;
  if (value.expectedProjectRevision !== undefined && !Number.isSafeInteger(value.expectedProjectRevision)) return false;
  if (['project.export', 'project.restore', 'device.reconcile', 'diagnostics.export'].includes(value.method) && value.expectedProjectRevision === undefined) return false;
  if (['project.prepareBuild', 'build.compile', 'firmware.upload', 'experiment.record', 'wiring.plan', 'wiring.check', 'wiring.accept', 'wiring.observe', 'document.ingest', 'document.rebuild'].includes(value.method) && value.expectedProjectRevision === undefined) return false;
  if (value.method === 'recording.query') {
    const range = value.params.range as { startMs: number; endMs: number };
    if (range.endMs < range.startMs) return false;
  }
  if (['document.page', 'document.excerpt'].includes(value.method)) {
    const range = value.params.textRange as [number, number] | undefined;
    if (range && (value.params.region !== undefined || range[1] < range[0])) return false;
  }
  if (['telemetry.', 'experiment.', 'kicad.', 'cad.'].some(prefix => value.method.startsWith(prefix)) && methodPolicies[value.method].classification !== 'read' && value.expectedProjectRevision === undefined) return false;
  if (value.method === 'telemetry.query' && (Number(value.params.end) < Number(value.params.start) || (value.params.timeBasis === 'device' ? value.params.deviceEpoch === undefined : value.params.deviceEpoch !== undefined))) return false;
  return true;
}
export function isProjectResponse(value: unknown): value is ProjectResponse { return withinLimits(value) && response(value); }
export function isProjectEvent(value: unknown): value is ProjectEvent {
  return withinLimits(value) && event(value) && Number.isSafeInteger(value.sequence) && Number.isSafeInteger(value.projectRevision);
}
export function isOperationReceipt(value: unknown): value is OperationReceipt {
  return withinLimits(value) && operation(value) && Number.isSafeInteger(value.expectedProjectRevision);
}
export function validateManifest(value: unknown): WorkbenchManifest {
  if (!isManifest(value)) throw new WorkbenchError(
    value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion !== 1 ? 'UNSUPPORTED_SCHEMA' : 'INVALID_REQUEST',
    'Manifest is invalid or exceeds supported limits. Preserve the original document and repair it.');
  return value;
}
export function validateOperation(value: unknown): OperationReceipt {
  if (!isOperationReceipt(value)) throw new WorkbenchError('INVALID_REQUEST', 'Operation receipt is invalid or exceeds supported limits.');
  return value;
}
