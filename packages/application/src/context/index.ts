import { randomUUID } from 'node:crypto';
import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { contextPacketSchema, WorkbenchError } from '@robotics-workbench/contracts';

export interface ContextEvidence {
  evidenceId: string; artifactId: string | null; sha256: string | null;
  basis: 'planned' | 'reported' | 'measured' | 'inferred'; sourceUri: string;
  location: { kind: 'whole' | 'lines' | 'page' | 'recording-range'; start: number | null; end: number | null; timeBasis: 'host-receive' | 'device' | 'relative' | null };
  projectRevision: number; observedAt: string | null;
  applicability: 'current' | 'historical' | 'stale' | 'conflicting' | 'unknown'; summary: string;
}
export interface ContextPacket {
  schemaVersion: 1; packetId: string; projectId: string; projectRevision: number;
  sourceSnapshotId: string | null; assembledAt: string; task: string;
  selection: null | { kind: 'component' | 'net' | 'source' | 'experiment' | 'document' | 'artifact'; id: string; revision: number }
    | { kind: 'document-page'; documentId: string; artifactSha256: string; extractorVersion: string; page: number; region?: [number, number, number, number]; textRange?: [number, number]; projectRevision: number }
    | { kind: 'recording-range'; recordingId: string; channelIds: string[]; startMs: number; endMs: number; timeBasis: 'host-receive' | 'device' | 'relative'; parserVersion: string; projectRevision: number; derivationId?: string; configurationSha256?: string; recordingProjectRevision?: number; deviceEpoch?: number };
  current: { targetFqbn: string | null; deviceId: string | null;
    connectionState: 'disconnected' | 'available' | 'monitoring' | 'releasing-monitor' | 'uploading' | 'reconnecting' | 'blocked' | 'outcome-unknown' | 'unknown';
    latestBuildId: string | null; lastUploadReceiptId: string | null;
    physicalConfirmation: 'confirmed' | 'unconfirmed' | 'stale' | 'conflicting' | 'not-applicable'; activeOperationIds: string[] };
  constraints: string[]; evidenceRefs: ContextEvidence[]; conflicts: string[]; unknowns: string[];
  omitted: { reason: 'budget' | 'excluded' | 'unavailable' | 'unsupported' | 'stale'; ref: string; expansionHandle: string | null }[];
}
const ajv = new Ajv({ strict: true, strictRequired: false, ownProperties: true });
addFormats(ajv);
const validate = ajv.compile<ContextPacket>(contextPacketSchema);
export const CONTEXT_BUDGET = 24 * 1024;
const secretPattern = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}|(?:api[_-]?key|access[_-]?token|password)\s*[=:]\s*["']?[^\s"']{8,})/i;
export function assertSafeAgentText(text: string): void {
  if (secretPattern.test(text)) throw new WorkbenchError('INVALID_REQUEST', 'Recognizable credential material is excluded from agent context and storage.');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return; }
  const scan = (value: unknown, depth = 0): void => {
    if (depth > 16) throw new WorkbenchError('INVALID_REQUEST', 'Agent data nesting exceeds the supported limit.');
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      if (/^(password|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|credentials|private[-_]?key)$/i.test(key) && child !== null && child !== '') throw new WorkbenchError('INVALID_REQUEST', 'Credential-bearing fields are excluded from agent data.');
      scan(child, depth + 1);
    }
    else if (typeof value === 'string') {
      if (secretPattern.test(value)) throw new WorkbenchError('INVALID_REQUEST', 'Recognizable credential material is excluded from agent data.');
      if (/^[\[{]/.test(value)) { let nested: unknown; try { nested = JSON.parse(value); } catch { return; } scan(nested, depth + 1); }
    }
  };
  scan(parsed);
}
export function validateContextPacket(value: unknown): ContextPacket {
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { throw new WorkbenchError('INVALID_REQUEST', 'Context must be finite JSON.'); }
  if (!serialized || Buffer.byteLength(serialized) > CONTEXT_BUDGET || !validate(value)) throw new WorkbenchError('INVALID_REQUEST', 'Context is invalid or exceeds 24 KiB.');
  assertSafeAgentText(serialized);
  const packet = value;
  if (!Number.isSafeInteger(packet.projectRevision)) throw new WorkbenchError('INVALID_REQUEST', 'Invalid project revision.');
  if (packet.selection && ('revision' in packet.selection ? packet.selection.revision : packet.selection.projectRevision) !== packet.projectRevision) throw new WorkbenchError('REVISION_CONFLICT', 'Selection belongs to another project revision.');
  if (packet.selection?.kind === 'recording-range' && packet.selection.endMs < packet.selection.startMs) throw new WorkbenchError('INVALID_REQUEST', 'Recording range is reversed.');
  if (packet.selection?.kind === 'document-page' && packet.selection.region && (packet.selection.region[0] > packet.selection.region[2] || packet.selection.region[1] > packet.selection.region[3])) throw new WorkbenchError('INVALID_REQUEST', 'Document region is reversed.');
  if (packet.selection?.kind === 'document-page' && packet.selection.textRange && (packet.selection.region || packet.selection.textRange[1] < packet.selection.textRange[0])) throw new WorkbenchError('INVALID_REQUEST', 'Document text range is reversed or conflicts with a page region.');
  for (const evidence of packet.evidenceRefs) {
    const { kind, start, end, timeBasis } = evidence.location;
    if (kind === 'whole' ? start !== null || end !== null || timeBasis !== null
      : start === null || end === null || end < start || !Number.isFinite(start) || !Number.isFinite(end)
      || (kind === 'recording-range' ? timeBasis === null : timeBasis !== null || !Number.isInteger(start) || !Number.isInteger(end) || start < 1)) throw new WorkbenchError('INVALID_REQUEST', 'Evidence location is invalid.');
    if (evidence.applicability === 'current' && evidence.projectRevision !== packet.projectRevision) throw new WorkbenchError('REVISION_CONFLICT', 'Current evidence belongs to another design revision.');
  }
  return structuredClone(packet);
}
export interface ContextCandidate { evidence: ContextEvidence; entityIds: string[]; expansionHandle: string | null; excluded?: boolean }
export interface AssembleContext extends Omit<ContextPacket, 'packetId' | 'assembledAt' | 'evidenceRefs' | 'omitted'> {
  packetId?: string; assembledAt?: string; candidates: ContextCandidate[];
  excludedUris?: string[]; knownSecrets?: string[]; lastUploadedBuildId?: string | null;
}
/** Excerpts remain quoted evidence; none of their contents becomes an authorization field. */
export function assembleContext(input: AssembleContext): ContextPacket {
  const { candidates, excludedUris = [], knownSecrets = [], lastUploadedBuildId, ...base } = input;
  const secretValues = knownSecrets.filter(Boolean).flatMap(secret => [secret, JSON.stringify(secret).slice(1, -1), Buffer.from(secret).toString('base64'), encodeURIComponent(secret)]);
  const packet: ContextPacket = { ...structuredClone(base), packetId: input.packetId ?? randomUUID(), assembledAt: input.assembledAt ?? new Date().toISOString(), evidenceRefs: [], omitted: [] };
  if (lastUploadedBuildId !== undefined && packet.current.latestBuildId !== lastUploadedBuildId) packet.conflicts = [...new Set([...packet.conflicts, 'The latest build differs from the last uploaded build.'])];
  validateContextPacket(packet);
  const selectionId = packet.selection && ('id' in packet.selection ? packet.selection.id : packet.selection.kind === 'document-page' ? packet.selection.documentId : packet.selection.recordingId);
  const selected = candidates.filter(candidate => !selectionId || candidate.entityIds.includes(selectionId));
  const seen = new Set<string>();
  const included: { evidence: ContextEvidence; omission: ContextPacket['omitted'][number] }[] = [];
  for (const candidate of selected.slice(0, 100)) {
    const evidence = structuredClone(candidate.evidence);
    const identity = JSON.stringify([evidence.sha256 ?? evidence.evidenceId, evidence.location]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const path = evidence.sourceUri.replaceAll('\\', '/').toLowerCase();
    const excluded = candidate.excluded || excludedUris.some(uri => path === uri.replaceAll('\\', '/').toLowerCase())
      || /(?:^|\/)(?:\.env(?:\.[^/]*)?|credentials(?:\.[^/]*)?|id_rsa|id_ed25519|auth\.json)(?:$|[?#])/.test(path)
      || secretPattern.test(JSON.stringify(evidence)) || secretValues.some(secret => JSON.stringify(evidence).includes(secret));
    const omission: ContextPacket['omitted'][number] = { reason: excluded ? 'excluded' : 'budget', ref: evidence.evidenceId, expansionHandle: excluded ? null : candidate.expansionHandle };
    packet.omitted.push(omission);
    if (!excluded) {
      if (evidence.projectRevision !== packet.projectRevision && evidence.applicability === 'current') evidence.applicability = 'stale';
      included.push({ evidence, omission });
    }
  }
  if (selected.length > 100) packet.unknowns.push('Additional matching evidence was not scanned; narrow the selection or retrieve a bounded page.');
  if (Buffer.byteLength(JSON.stringify(packet)) > CONTEXT_BUDGET) throw new WorkbenchError('INVALID_REQUEST', 'Essential context and omission handles exceed 24 KiB. Narrow the selection.');
  for (const { evidence, omission } of included) {
    packet.omitted = packet.omitted.filter(item => item !== omission);
    packet.evidenceRefs.push(evidence);
    if (Buffer.byteLength(JSON.stringify(packet)) > CONTEXT_BUDGET) { packet.evidenceRefs.pop(); packet.omitted.push(omission); }
  }
  if (secretValues.some(secret => JSON.stringify(packet).includes(secret))) throw new WorkbenchError('INVALID_REQUEST', 'Secret material is excluded from essential context.');
  return validateContextPacket(packet);
}
