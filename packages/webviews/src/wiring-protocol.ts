import type { WiringOperation, WiringViewRequest, WiringViewResponse, WiringViewState } from '@robotics-workbench/contracts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha = /^[a-f0-9]{64}$/;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const text = (v: unknown, max: number, min = 0): v is string => typeof v === 'string' && v.length >= min && v.length <= max;
const id = (v: unknown): v is string => typeof v === 'string' && uuid.test(v);
const revision = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
const keys = (v: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => [...required, ...optional].includes(k));
const array = (v: unknown, max: number, valid: (item: unknown) => boolean): v is unknown[] => Array.isArray(v) && v.length <= max && v.every(valid);
const hash = (v: unknown) => v === null || typeof v === 'string' && sha.test(v);
const pinId = (v: unknown) => text(v, 128, 1) && !/[\x00-\x1f]/.test(v);
const path = (v: unknown) => text(v, 4096, 1) && !/[\\:\x00-\x1f]/.test(v) && !v.startsWith('/') && !v.split('/').some(x => !x || x === '.' || x === '..');
function bounded(v: unknown, limit: number): boolean {
  const scan = (x: unknown, depth = 0): boolean => depth <= 16 && (x === null || typeof x === 'string' || typeof x === 'boolean' || typeof x === 'number' && Number.isFinite(x) || Array.isArray(x) && x.every(i => scan(i, depth + 1)) || object(x) && Object.values(x).every(i => scan(i, depth + 1)));
  try { return scan(v) && new TextEncoder().encode(JSON.stringify(v)).byteLength <= limit; } catch { return false; }
}
const definition = (v: unknown) => v === null || object(v) && keys(v, ['definitionId', 'definitionVersion']) && text(v.definitionId, 256, 1) && text(v.definitionVersion, 128, 1);
function component(v: unknown): boolean {
  return object(v) && keys(v, ['componentId', 'label', 'definition'], ['properties', 'identityStatus', 'candidateLabels', 'evidenceRefs', 'provisionalPins']) && id(v.componentId) && text(v.label, 256, 1) && definition(v.definition)
    && (v.properties === undefined || object(v.properties)) && (v.identityStatus === undefined || ['resolved', 'unresolved'].includes(String(v.identityStatus)))
    && (v.candidateLabels === undefined || array(v.candidateLabels, 32, x => text(x, 256))) && (v.evidenceRefs === undefined || array(v.evidenceRefs, 100, id))
    && (v.provisionalPins === undefined || array(v.provisionalPins, 256, p => object(p) && keys(p, ['pinId', 'label']) && pinId(p.pinId) && text(p.label, 256, 1)));
}
const endpoint = (v: unknown) => object(v) && keys(v, ['componentId', 'pinId']) && id(v.componentId) && pinId(v.pinId);
function net(v: unknown): boolean {
  return object(v) && keys(v, ['netId', 'members'], ['label', 'intent']) && id(v.netId) && array(v.members, 1000, endpoint) && (v.label === undefined || text(v.label, 256))
    && (v.intent === undefined || object(v.intent) && keys(v.intent, [], ['domainId', 'designState', 'sourceRefs']) && (v.intent.domainId === undefined || id(v.intent.domainId)) && (v.intent.designState === undefined || ['proposed', 'accepted'].includes(String(v.intent.designState))) && (v.intent.sourceRefs === undefined || array(v.intent.sourceRefs, 100, x => text(x, 512, 1))));
}
const binding = (v: unknown) => object(v) && keys(v, ['bindingId', 'componentId', 'path'], ['pinId', 'symbol', 'line']) && id(v.bindingId) && id(v.componentId) && path(v.path) && (v.pinId === undefined || pinId(v.pinId)) && (v.symbol === undefined || text(v.symbol, 512, 1)) && (v.line === undefined || revision(v.line));
export function isWiringOperation(v: unknown): v is WiringOperation {
  if (!object(v)) return false;
  switch (v.type) {
    case 'component.add': return keys(v, ['type', 'component']) && component(v.component);
    case 'component.rename': return keys(v, ['type', 'componentId', 'label']) && id(v.componentId) && text(v.label, 256, 1);
    case 'component.resolve': return keys(v, ['type', 'componentId', 'definition'], ['pinMapping']) && id(v.componentId) && definition(v.definition) && (v.pinMapping === undefined || object(v.pinMapping) && Object.entries(v.pinMapping).length <= 256 && Object.entries(v.pinMapping).every(([k, value]) => pinId(k) && pinId(value)));
    case 'component.remove': return keys(v, ['type', 'componentId', 'removeBindings']) && id(v.componentId) && typeof v.removeBindings === 'boolean';
    case 'net.set': return keys(v, ['type', 'net']) && net(v.net);
    case 'net.remove': return keys(v, ['type', 'netId']) && id(v.netId);
    case 'binding.set': return keys(v, ['type', 'binding']) && binding(v.binding);
    case 'binding.remove': return keys(v, ['type', 'bindingId']) && id(v.bindingId);
    case 'pin.mode': return keys(v, ['type', 'componentId', 'pinId', 'mode']) && id(v.componentId) && pinId(v.pinId) && text(v.mode, 128, 1);
    default: return false;
  }
}
function positions(v: unknown): boolean { return object(v) && Object.keys(v).length <= 1000 && Object.entries(v).every(([key, point]) => id(key) && object(point) && keys(point, ['x', 'y']) && Number.isFinite(point.x) && Number.isFinite(point.y) && Math.abs(Number(point.x)) <= 1e6 && Math.abs(Number(point.y)) <= 1e6); }
export function isWiringViewRequest(v: unknown, projectId?: string | null): v is WiringViewRequest {
  if (!bounded(v, 65536) || !object(v) || !keys(v, ['schemaVersion', 'requestId', 'projectId', 'type', 'payload']) || v.schemaVersion !== 1 || !id(v.requestId) || !(v.projectId === null || id(v.projectId)) || !object(v.payload)) return false;
  if (projectId !== undefined && v.projectId !== projectId && !(v.type === 'ready' && v.projectId === null)) return false;
  const p = v.payload;
  if (v.type === 'ready' || v.type === 'refresh') return keys(p, []);
  if (!id(v.projectId)) return false;
  switch (v.type) {
    case 'select': return keys(p, ['kind', 'id']) && ['component', 'net'].includes(String(p.kind)) && id(p.id);
    case 'propose': return keys(p, ['operations']) && array(p.operations, 100, isWiringOperation) && p.operations.length > 0;
    case 'commit': return keys(p, ['previewId']) && id(p.previewId);
    case 'layout': return keys(p, ['positions']) && positions(p.positions);
    case 'openCode': return keys(p, ['bindingId']) && id(p.bindingId);
    case 'openDocument': return keys(p, ['documentId']) && id(p.documentId);
    case 'discard': case 'undo': case 'ask': case 'observe': case 'openManifest': case 'openCatalog': return keys(p, []);
    default: return false;
  }
}
function manifest(v: unknown): boolean {
  return object(v) && keys(v, ['schemaVersion', 'projectId', 'projectRevision', 'name', 'sketches', 'targets', 'components', 'nets', 'codeBindings', 'documents', 'extensions']) && v.schemaVersion === 1 && id(v.projectId) && revision(v.projectRevision) && text(v.name, 1024, 1)
    && array(v.components, 1000, component) && array(v.nets, 1000, net) && array(v.codeBindings, 1000, binding) && object(v.extensions)
    && array(v.sketches, 100, x => object(x) && keys(x, ['path', 'targetId']) && text(x.path, 4096, 1) && id(x.targetId))
    && array(v.targets, 100, x => object(x) && keys(x, ['targetId', 'fqbn', 'options']) && id(x.targetId) && text(x.fqbn, 256, 1) && object(x.options) && Object.values(x.options).every(o => text(o, 1024)))
    && array(v.documents, 1000, x => object(x) && keys(x, ['documentId', 'path'], ['title', 'componentIds']) && id(x.documentId) && path(x.path) && (x.title === undefined || text(x.title, 1024)) && (x.componentIds === undefined || array(x.componentIds, 1000, id)));
}
const rule = (v: unknown) => object(v) && keys(v, ['ruleId', 'ruleVersion', 'severity', 'outcome', 'affectedIds', 'projectRevision', 'sourceFacts', 'explanation']) && text(v.ruleId, 256, 1) && text(v.ruleVersion, 128, 1) && ['error', 'warning', 'info'].includes(String(v.severity)) && ['pass', 'fail', 'not-checked', 'not-applicable'].includes(String(v.outcome)) && array(v.affectedIds, 1000, x => text(x, 512, 1)) && revision(v.projectRevision) && array(v.sourceFacts, 100, x => text(x, 4096, 1)) && text(v.explanation, 4096, 1);
export function isWiringViewState(v: unknown): v is WiringViewState {
  if (!bounded(v, 1024 * 1024) || !object(v) || !keys(v, ['schemaVersion', 'trusted', 'loading', 'error', 'project', 'manifest', 'catalog', 'pins', 'rules', 'confirmations', 'layout', 'selection', 'preview']) || v.schemaVersion !== 1 || typeof v.trusted !== 'boolean' || typeof v.loading !== 'boolean' || !(v.error === null || text(v.error, 4096))) return false;
  if (v.project === null ? v.manifest !== null : !object(v.project) || !keys(v.project, ['projectId', 'projectRevision', 'name', 'manifestSha256']) || !id(v.project.projectId) || !revision(v.project.projectRevision) || !text(v.project.name, 1024, 1) || typeof v.project.manifestSha256 !== 'string' || !sha.test(v.project.manifestSha256) || !manifest(v.manifest) || !object(v.manifest) || v.manifest.projectId !== v.project.projectId || v.manifest.projectRevision !== v.project.projectRevision) return false;
  if (!array(v.catalog, 100, x => object(x) && keys(x, ['definitionId', 'definitionVersion', 'label', 'detail']) && text(x.definitionId, 256, 1) && text(x.definitionVersion, 128, 1) && text(x.label, 1024, 1) && text(x.detail, 4096))) return false;
  if (!object(v.pins) || Object.keys(v.pins).length > 1000 || !Object.entries(v.pins).every(([key, pins]) => id(key) && array(pins, 256, p => object(p) && keys(p, ['pinId', 'label', 'aliases', 'modes', 'electricalType']) && pinId(p.pinId) && text(p.label, 256, 1) && array(p.aliases, 128, pinId) && array(p.modes, 32, x => text(x, 128, 1)) && text(p.electricalType, 128, 1)))) return false;
  if (!array(v.rules, 1000, rule) || !array(v.confirmations, 100, x => object(x) && keys(x, ['observationId', 'subjectIds', 'projectRevision', 'basis', 'result', 'procedure', 'note', 'observedAt', 'applicability']) && id(x.observationId) && array(x.subjectIds, 1000, id) && revision(x.projectRevision) && ['reported', 'measured'].includes(String(x.basis)) && ['passed', 'failed', 'inconclusive'].includes(String(x.result)) && text(x.procedure, 2048, 1) && text(x.note, 4096) && typeof x.observedAt === 'string' && Number.isFinite(Date.parse(x.observedAt)) && ['current', 'stale'].includes(String(x.applicability)))) return false;
  if (!object(v.layout) || !keys(v.layout, ['revision', 'sha256', 'positions']) || !(v.layout.revision === 0 || revision(v.layout.revision)) || !hash(v.layout.sha256) || !positions(v.layout.positions)) return false;
  if (!(v.selection === null || object(v.selection) && keys(v.selection, ['kind', 'id']) && ['component', 'net'].includes(String(v.selection.kind)) && id(v.selection.id))) return false;
  return v.preview === null || object(v.preview) && keys(v.preview, ['previewId', 'changes', 'rules', 'confirmationInvalidated']) && id(v.preview.previewId) && array(v.preview.changes, 200, x => text(x, 4096)) && array(v.preview.rules, 1000, rule) && typeof v.preview.confirmationInvalidated === 'boolean';
}
export function isWiringViewResponse(v: unknown): v is WiringViewResponse { return object(v) && keys(v, ['schemaVersion', 'type', 'state']) && v.schemaVersion === 1 && v.type === 'state' && isWiringViewState(v.state); }
