import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import controlSchema from '../../../contracts/companion-control.schema.json';
import resultSchema from '../../../contracts/companion-result.schema.json';
import responseSchema from '../../../contracts/response.schema.json';

export type ControlRequest = {
  schemaVersion: 1;
  requestId: string;
  method: 'companion.hello' | 'companion.shutdown';
  params: Record<string, never>;
};
export type ControlResult =
  | { state: 'ready'; pid: number; runtimeVersion: string; platform: 'win32'; arch: 'x64' }
  | { state: 'stopping' };
export type ControlResponse = { schemaVersion: 1; requestId: string } & (
  | { result: ControlResult; error?: never }
  | { error: { code: string; message: string; retryable: boolean }; result?: never }
);

// D18's not/required branches refer to envelope properties declared above them.
const ajv = new Ajv({ strict: true, strictRequired: false });
addFormats(ajv);
const control = ajv.compile<ControlRequest>(controlSchema);
const response = ajv.compile(responseSchema);
const result = ajv.compile<ControlResult>(resultSchema);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isRequestId = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);

function bounded(value: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (value && typeof value === 'object') {
    return Object.values(value).every(item => bounded(item, depth + 1));
  }
  return true;
}

function withinLimits(value: unknown): boolean {
  try { return bounded(value) && new TextEncoder().encode(JSON.stringify(value) ?? '').byteLength <= 1024 * 1024; }
  catch { return false; }
}

export function isControlRequest(value: unknown): value is ControlRequest {
  return withinLimits(value) && control(value);
}

export function isControlResponse(value: unknown): value is ControlResponse {
  if (!withinLimits(value) || !response(value)) return false;
  const envelope = value as Record<string, unknown>;
  return 'error' in envelope || result(envelope.result);
}

export * from './project';
export * from './views';
export * from './review';
export * from './wiring';
export * from './components';
export * from './documents';
export * from './telemetry';
export * from './experiments';
export * from './kicad';
export * from './cad';
export * from './recovery';
export * from './diagnostics';
export { default as contextPacketSchema } from '../../../contracts/context-packet.schema.json';
export type { UUID, ISODateTime, ProviderId, Capability, ErrorCode, AdapterProblem, ProviderDescriptor, SessionRef, ModelConfiguration, OpenSession, AttachmentRef, SubmitTurn, TurnRef, ApprovalRequest, ApprovalAnswer, Usage, DisplayMessage, SessionSnapshot, AgentEvent, ProviderAdapter } from '../../../contracts/provider-adapter';
