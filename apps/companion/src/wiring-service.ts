import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isProjectRequest, isProjectResponse, WorkbenchError, type ComponentDefinition, type ProjectRequest, type ProjectResponse, type WiringPlan, type WiringViewState, type WorkbenchManifest } from '@robotics-workbench/contracts';
import { referenceCatalog, validateCatalog, findDefinition, componentPins, validateWiring } from '@robotics-workbench/domain';
import { planWiring, isWiringOperations, assertSafeAgentText } from '@robotics-workbench/application';
import { canonicalJson } from '@robotics-workbench/persistence';
import type { ProjectService } from './project-service';

type Confirmation = Omit<WiringViewState['confirmations'][number], 'applicability'> & { kind: 'wiring-observation'; schemaVersion: 1; actor: 'local-user'; evidenceRefs: string[] };
type CatalogStamp = { kind: 'catalog-stamp'; definitionId: string; definitionVersion: string; sha256: string };
type Commit = { kind: 'wiring-commit'; previewId: string; projectRevision: number; manifestSha256: string; migrationArtifactId: string };
type Prepared = WiringPlan & { previewId: string; previous: WorkbenchManifest; manifestSha256: string };
export type WiringData = Pick<WiringViewState, 'catalog' | 'pins' | 'rules' | 'confirmations' | 'layout'> & { manifest: WorkbenchManifest; manifestSha256: string };
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Design intent stays in ordinary files; operational history never claims measured wiring. */
export class WiringService {
  private readonly plans = new Map<string, { plan: Prepared; catalogSha256: string }>();
  private readonly stamps = new Map<string, string>();
  private catalogKey?: string;
  private catalogCache: ComponentDefinition[] = [];
  constructor(private readonly project: ProjectService) {
    project.design = this;
    for (const item of project.store.listRecords<CatalogStamp>('sessions', project.projectId)) if (item.kind === 'catalog-stamp') this.stamps.set(`${item.definitionId}@${item.definitionVersion}`, item.sha256);
  }
  supports(method: string): boolean { return method.startsWith('wiring.') || ['component.inspect', 'connections.query'].includes(method); }
  private current() {
    const response = this.project.handle({ schemaVersion: 1, requestId: randomUUID(), projectId: this.project.projectId, method: 'project.snapshot', params: {} }, { includeBuilds: false });
    if (response.error) throw new WorkbenchError(response.error.code, response.error.message);
    return this.project.files.inspectManifest();
  }
  private read(path: string, limit = 512 * 1024): Buffer {
    const full = this.project.files.resolvePath(path);
    if (statSync(full).size > limit) throw new WorkbenchError('INVALID_REQUEST', 'Design/catalog input exceeds its bounded size; inspect the ordinary source file.');
    const bytes = readFileSync(full); if (bytes.length > limit) throw new WorkbenchError('REVISION_CONFLICT', 'Design input grew during read.'); return bytes;
  }
  private catalog(): ComponentDefinition[] {
    const path = this.project.files.resolvePath('components/catalog.json', true);
    const bytes = existsSync(path) ? this.read('components/catalog.json') : Buffer.from('');
    const key = hash(bytes); if (key === this.catalogKey) return this.catalogCache;
    let supplied: unknown[] = [];
    if (bytes.length) {
      const input = JSON.parse(bytes.toString('utf8'));
      if (!input || input.schemaVersion !== 1 || !Array.isArray(input.definitions) || Object.keys(input).some(name => !['schemaVersion', 'definitions'].includes(name))) throw new WorkbenchError('INVALID_REQUEST', 'Catalog requires schemaVersion1 and definitions[]. Its source bytes were preserved.');
      supplied = input.definitions;
    }
    const definitions = validateCatalog([...referenceCatalog, ...supplied]);
    assertSafeAgentText(JSON.stringify(definitions));
    for (const definition of definitions) {
      const identity = `${definition.definitionId}@${definition.definitionVersion}`, sha256 = hash(canonicalJson(definition));
      if (this.stamps.has(identity) && this.stamps.get(identity) !== sha256) throw new WorkbenchError('REVISION_CONFLICT', `Definition ${identity} changed without a new version. Review a version migration; do not silently change active pin facts.`);
      if (!this.stamps.has(identity)) { this.project.store.putRecord('sessions', randomUUID(), this.project.projectId, { kind: 'catalog-stamp', definitionId: definition.definitionId, definitionVersion: definition.definitionVersion, sha256 }); this.stamps.set(identity, sha256); }
    }
    this.catalogCache = definitions; this.catalogKey = key; return definitions;
  }
  private layout(manifest: WorkbenchManifest): WiringViewState['layout'] {
    const path = this.project.files.resolvePath('.workbench-layout.json', true);
    if (!existsSync(path)) return { revision: 0, sha256: null, positions: {} };
    const bytes = this.read('.workbench-layout.json'), value = JSON.parse(bytes.toString('utf8'));
    if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 || !value.positions || typeof value.positions !== 'object' || Array.isArray(value.positions)) throw new WorkbenchError('INVALID_REQUEST', 'Layout sidecar is invalid; its text was preserved. Repair it before moving components.');
    const positions: WiringViewState['layout']['positions'] = {};
    for (const [id, point] of Object.entries(value.positions)) {
      if (!point || typeof point !== 'object' || !('x' in point) || !('y' in point) || typeof point.x !== 'number' || typeof point.y !== 'number' || !Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 1e6 || Math.abs(point.y) > 1e6) throw new WorkbenchError('INVALID_REQUEST', 'Layout coordinates must be finite and bounded.');
      if (manifest.components.some(component => component.componentId === id)) positions[id] = { x: point.x, y: point.y };
    }
    return { revision: value.revision, sha256: hash(bytes), positions };
  }
  private observations(revision: number): WiringViewState['confirmations'] {
    return this.project.store.listRecords<Confirmation>('observations', this.project.projectId).filter(item => item.kind === 'wiring-observation' && item.schemaVersion === 1).slice(-100).map(({ kind, schemaVersion, actor, evidenceRefs, ...item }) => ({ ...item, applicability: item.projectRevision === revision ? 'current' : 'stale' }));
  }
  private snapshot(): WiringData {
    const { manifest, sha256 } = this.current(), catalog = this.catalog();
    assertSafeAgentText(JSON.stringify(manifest));
    return { manifest, manifestSha256: sha256, catalog: catalog.map(definition => ({ definitionId: definition.definitionId, definitionVersion: definition.definitionVersion, label: `${definition.model} · ${definition.package}`, detail: `${definition.manufacturer}; reference facts only; ${definition.sources.map(source => source.uri).join(', ')}`.slice(0, 2048) })),
      pins: Object.fromEntries(manifest.components.map(component => [component.componentId, componentPins(component, catalog).map(({ pinId, label, aliases, modes, electricalType }) => ({ pinId, label, aliases, modes, electricalType }))])), rules: validateWiring(manifest, catalog), confirmations: this.observations(manifest.projectRevision), layout: this.layout(manifest) };
  }
  handle(value: unknown): ProjectResponse {
    if (!isProjectRequest(value) || value.projectId !== this.project.projectId) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Invalid design request or wrong project binding.');
    try {
      let result: unknown;
      if (value.method === 'wiring.snapshot') result = this.snapshot();
      else if (value.method === 'wiring.plan') result = this.prepare(value);
      else if (value.method === 'wiring.check') { this.check(value); result = { current: true }; }
      else if (value.method === 'wiring.accept') result = this.accept(value);
      else if (value.method === 'wiring.observe') result = this.observe(value);
      else if (value.method === 'component.inspect') {
        const state = this.snapshot(), component = state.manifest.components.find(item => item.componentId === value.params.componentId);
        if (!component) throw new WorkbenchError('NOT_FOUND', 'Component is unavailable in this project.');
        result = { projectRevision: state.manifest.projectRevision, component, definition: component.definition ? findDefinition(this.catalog(), component.definition) ?? null : null, pins: state.pins[component.componentId], rules: state.rules.filter(rule => rule.affectedIds.includes(component.componentId)), observations: state.confirmations.filter(item => item.subjectIds.includes(component.componentId)), codeBindings: state.manifest.codeBindings.filter(item => item.componentId === component.componentId), documents: state.manifest.documents.filter(item => item.componentIds?.includes(component.componentId)), unknowns: ['Intended connections and reported observations do not establish measured continuity or a safe assembled circuit.'] };
      } else if (value.method === 'connections.query') {
        const response = this.project.handle(value); if (response.error) return response; result = response.result;
      } else throw new WorkbenchError('UNKNOWN_METHOD', 'Unsupported design method.');
      const response: ProjectResponse = { schemaVersion: 1, requestId: value.requestId, result };
      if (!isProjectResponse(response)) throw new WorkbenchError('INVALID_REQUEST', 'Design preview exceeds the control-message bound; inspect its ordinary manifest/catalog.');
      return response;
    } catch (error) { return { schemaVersion: 1, requestId: value.requestId, error: { code: error instanceof WorkbenchError ? error.code : 'INVALID_REQUEST', message: error instanceof WorkbenchError ? error.message : 'Design/catalog input is invalid. Preserve and repair its ordinary source file.', retryable: false } }; }
  }
  private prepare(request: ProjectRequest): Prepared {
    const current = this.current();
    if (current.manifest.projectRevision !== request.expectedProjectRevision || current.sha256 !== request.params.expectedManifestSha256) throw new WorkbenchError('REVISION_CONFLICT', 'Design changed; preserve the draft and preview a fresh patch.');
    if (!isWiringOperations(request.params.operations)) throw new WorkbenchError('INVALID_REQUEST', 'Design operations do not match the closed version1 contract.');
    const catalog = this.catalog(), plan = planWiring(current.manifest, request.expectedProjectRevision!, request.params.operations, catalog);
    const prepared: Prepared = { ...plan, previewId: randomUUID(), previous: current.manifest, manifestSha256: current.sha256 };
    if (this.plans.size >= 32) this.plans.delete(this.plans.keys().next().value!);
    this.plans.set(prepared.previewId, { plan: prepared, catalogSha256: hash(canonicalJson(catalog)) }); return structuredClone(prepared);
  }
  private checkedPlan(previewId: string): Prepared {
    const prepared = this.plans.get(previewId);
    if (!prepared) throw new WorkbenchError('REVISION_CONFLICT', 'Design preview expired; inspect actual source before preparing another.');
    if (hash(canonicalJson(this.catalog())) !== prepared.catalogSha256) throw new WorkbenchError('REVISION_CONFLICT', 'Catalog changed after this preview. Preserve the draft and review a fresh plan.');
    if (prepared.plan.rules.some(rule => rule.outcome === 'fail' && rule.severity === 'error')) throw new WorkbenchError('INVALID_REQUEST', 'Known design errors block this commit. Resolve the exact reported endpoints/facts.');
    return prepared.plan;
  }
  private check(request: ProjectRequest): Prepared {
    const plan = this.checkedPlan(String(request.params.previewId)), current = this.current();
    if (current.sha256 !== plan.manifestSha256 || current.sha256 !== request.params.expectedManifestSha256 || current.manifest.projectRevision !== request.expectedProjectRevision || current.manifest.projectRevision !== plan.expectedProjectRevision) throw new WorkbenchError('REVISION_CONFLICT', 'Design source changed after preview. Preserve both versions.');
    return plan;
  }
  private accept(request: ProjectRequest): Commit {
    const existing = this.project.store.listRecords<Commit>('sessions', request.projectId).find(item => item.kind === 'wiring-commit' && item.previewId === request.params.previewId);
    if (existing) {
      if (existing.manifestSha256 !== request.params.manifestSha256 || existing.projectRevision !== request.expectedProjectRevision) throw new WorkbenchError('REQUEST_ID_CONFLICT', 'This preview was accepted with different resulting bytes.'); return existing;
    }
    const plan = this.checkedPlan(String(request.params.previewId));
    const current = this.current();
    if (current.sha256 !== request.params.manifestSha256 || current.manifest.projectRevision !== request.expectedProjectRevision || canonicalJson(current.manifest) !== canonicalJson(plan.next)) throw new WorkbenchError('REVISION_CONFLICT', 'Saved source differs from the reviewed design; preserve and reconcile both versions.');
    const artifact = this.project.store.storeArtifact(request.projectId, Buffer.from(JSON.stringify({ schemaVersion: 1, previous: plan.previous, next: plan.next, inverseOperations: plan.inverseOperations, changes: plan.changes })), 'application/json');
    const commit: Commit = { kind: 'wiring-commit', previewId: plan.previewId, projectRevision: current.manifest.projectRevision, manifestSha256: current.sha256, migrationArtifactId: artifact.artifactId };
    this.project.store.putRecord('sessions', plan.previewId, request.projectId, commit);
    this.project.store.appendEvent(request.projectId, current.manifest.projectRevision, plan.confirmationInvalidated ? 'design.changed' : 'design.unchanged', { migrationArtifactId: artifact.artifactId, previousRevision: plan.expectedProjectRevision, physicalConfirmationsStale: plan.confirmationInvalidated });
    this.plans.delete(plan.previewId); return commit;
  }
  private observe(request: ProjectRequest): unknown {
    const existing = this.project.store.listRecords<Confirmation>('observations', request.projectId).find(item => item.kind === 'wiring-observation' && item.observationId === request.requestId);
    if (existing) { this.project.store.admitRequest(request.projectId, request.requestId, request); return existing; }
    const current = this.current();
    if (current.manifest.projectRevision !== request.expectedProjectRevision || current.sha256 !== request.params.expectedManifestSha256) throw new WorkbenchError('REVISION_CONFLICT', 'Observation must name the exact current intended design.');
    const subjects = request.params.subjectIds as string[], known = new Set([...current.manifest.components.map(item => item.componentId), ...current.manifest.nets.map(item => item.netId)]);
    if (subjects.some(id => !known.has(id))) throw new WorkbenchError('NOT_FOUND', 'Observation scope contains a missing component/net.');
    const note = { procedure: request.params.procedure, note: request.params.note, result: request.params.result, observedAt: request.params.observedAt };
    assertSafeAgentText(JSON.stringify(note));
    if (!this.project.store.admitRequest(request.projectId, request.requestId, request)) throw new WorkbenchError('OUTCOME_UNKNOWN', 'Observation admission exists without a completed record. Inspect retained history before submitting another report.');
    const artifact = this.project.store.storeArtifact(request.projectId, Buffer.from(JSON.stringify(note)), 'application/json');
    const record: Confirmation = { kind: 'wiring-observation', schemaVersion: 1, observationId: request.requestId, subjectIds: subjects, projectRevision: current.manifest.projectRevision, basis: 'reported', actor: 'local-user', result: request.params.result as Confirmation['result'], procedure: String(request.params.procedure), note: String(request.params.note), observedAt: String(request.params.observedAt), evidenceRefs: [artifact.artifactId] };
    this.project.store.putRecord('observations', record.observationId, request.projectId, record); return record;
  }
}
