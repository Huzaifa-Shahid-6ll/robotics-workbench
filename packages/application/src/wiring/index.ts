import { isManifest, isRequestId, validateManifest, WorkbenchError, type ComponentDefinition, type WorkbenchManifest, type WiringOperation, type WiringPlan } from '@robotics-workbench/contracts';
import { assertManifestSemantics, canonicalEndpoint, canonicalizeNets, canonicalPin, componentPins, definitionMigration, findDefinition, validateWiring } from '@robotics-workbench/domain';
import { assertSafeAgentText } from '../context/index';

type Component = WorkbenchManifest['components'][number];
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const text = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum;
const keys = (value: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const fixture = (): WorkbenchManifest => ({ schemaVersion: 1, projectId: '00000000-0000-4000-8000-000000000001', projectRevision: 1, name: 'Shape validation only', sketches: [{ path: '.', targetId: '00000000-0000-4000-8000-000000000002' }], targets: [{ targetId: '00000000-0000-4000-8000-000000000002', fqbn: 'fixture:core:board', options: {} }], components: [], nets: [], codeBindings: [], documents: [], extensions: {} });
function recordShape(kind: 'components' | 'nets' | 'codeBindings' | 'documents', value: unknown): boolean {
  const manifest = fixture(); (manifest[kind] as unknown[]) = [value]; return isManifest(manifest);
}
function reference(value: unknown): boolean { return value === null || plain(value) && keys(value, ['definitionId', 'definitionVersion']) && text(value.definitionId, 256) && text(value.definitionVersion, 128); }
function mapping(value: unknown): boolean { return plain(value) && Object.keys(value).length <= 256 && Object.entries(value).every(([from, to]) => text(from, 128) && text(to, 128)); }

/** Closed operation union: geometry and executable commands cannot enter an intent patch. */
export function isWiringOperations(value: unknown): value is WiringOperation[] {
  try {
    if (!Array.isArray(value) || value.length < 1 || value.length > 100 || new TextEncoder().encode(JSON.stringify(value)).byteLength > 262144) return false;
    return value.every(operation => {
      if (!plain(operation) || typeof operation.type !== 'string') return false;
      switch (operation.type) {
        case 'component.add': return keys(operation, ['type', 'component'], ['beforeComponentId']) && recordShape('components', operation.component) && (operation.beforeComponentId === undefined || isRequestId(operation.beforeComponentId));
        case 'component.replace': return keys(operation, ['type', 'component']) && recordShape('components', operation.component);
        case 'component.rename': return keys(operation, ['type', 'componentId', 'label']) && isRequestId(operation.componentId) && text(operation.label, 256);
        case 'component.resolve': return keys(operation, ['type', 'componentId', 'definition'], ['pinMapping']) && isRequestId(operation.componentId) && reference(operation.definition) && (operation.pinMapping === undefined || mapping(operation.pinMapping));
        case 'component.remove': return keys(operation, ['type', 'componentId', 'removeBindings']) && isRequestId(operation.componentId) && typeof operation.removeBindings === 'boolean';
        case 'net.set': return keys(operation, ['type', 'net']) && recordShape('nets', operation.net);
        case 'net.remove': return keys(operation, ['type', 'netId']) && isRequestId(operation.netId);
        case 'binding.set': return keys(operation, ['type', 'binding'], ['beforeBindingId']) && recordShape('codeBindings', operation.binding) && (operation.beforeBindingId === undefined || isRequestId(operation.beforeBindingId));
        case 'binding.remove': return keys(operation, ['type', 'bindingId']) && isRequestId(operation.bindingId);
        case 'document.set': return keys(operation, ['type', 'document']) && recordShape('documents', operation.document);
        case 'pin.mode': return keys(operation, ['type', 'componentId', 'pinId', 'mode']) && isRequestId(operation.componentId) && text(operation.pinId, 128) && text(operation.mode, 64);
        default: return false;
      }
    });
  } catch { return false; }
}
const clone = <T>(value: T): T => structuredClone(value);
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function intent(manifest: WorkbenchManifest, catalog: readonly ComponentDefinition[]): string {
  return stable({ ...manifest, projectRevision: 1, nets: canonicalizeNets(manifest, catalog), codeBindings: manifest.codeBindings.map(binding => binding.pinId ? { ...binding, ...canonicalEndpoint(manifest, { componentId: binding.componentId, pinId: binding.pinId }, catalog) } : binding) });
}
function fail(message: string, code = 'INVALID_REQUEST'): never { throw new WorkbenchError(code, message); }
function sourcePath(path: string): void {
  if (!path || path.length > 4096 || /[\\:\x00-\x1f\x7f<>"|?*]/.test(path) || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i.test(part))) fail('Source bindings and document links require normalized project-relative file paths.');
}

/** Plans only: the host still checks document version and exact file hash before a native edit. */
export function planWiring(manifest: WorkbenchManifest, expectedRevision: number, operations: unknown, catalog: readonly ComponentDefinition[]): WiringPlan {
  validateManifest(manifest); assertManifestSemantics(manifest);
  if (!Number.isSafeInteger(expectedRevision) || manifest.projectRevision !== expectedRevision) fail('Design intent changed; refresh before applying this patch.', 'REVISION_CONFLICT');
  if (!isWiringOperations(operations)) fail('Wiring patch is malformed, oversized or contains unsupported operations.');
  assertSafeAgentText(JSON.stringify(operations));
  const next = clone(manifest), inverse: WiringOperation[][] = [], changes: string[] = [];
  const component = (id: string): Component => next.components.find(item => item.componentId.toLowerCase() === id.toLowerCase()) ?? fail('Component no longer exists.', 'NOT_FOUND');
  const related = (id: string) => ({ nets: next.nets.filter(net => net.members.some(endpoint => endpoint.componentId.toLowerCase() === id.toLowerCase())).map(clone), bindings: next.codeBindings.filter(binding => binding.componentId.toLowerCase() === id.toLowerCase()).map(clone) });
  for (const operation of operations) {
    switch (operation.type) {
      case 'component.add': {
        if (next.components.some(item => item.componentId.toLowerCase() === operation.component.componentId.toLowerCase())) fail('Component identity already exists.');
        if (operation.component.definition && !findDefinition(catalog, operation.component.definition)) fail('Definition is unavailable; add an unresolved instance or attach the exact reviewed catalog version.');
        const index = operation.beforeComponentId ? next.components.findIndex(item => item.componentId.toLowerCase() === operation.beforeComponentId!.toLowerCase()) : next.components.length;
        if (index < 0) fail('Component insertion anchor no longer exists.', 'NOT_FOUND');
        next.components.splice(index, 0, clone(operation.component)); inverse.push([{ type: 'component.remove', componentId: operation.component.componentId, removeBindings: true }]); changes.push(`Add component ${operation.component.componentId}; physical possession is not inferred.`); break;
      }
      case 'component.replace': {
        const previous = clone(component(operation.component.componentId)); next.components[next.components.indexOf(component(previous.componentId))] = clone(operation.component);
        inverse.push([{ type: 'component.replace', component: previous }]); changes.push(`Restore reviewed metadata for component ${previous.componentId}.`); break;
      }
      case 'component.rename': {
        const current = component(operation.componentId); inverse.push([{ type: 'component.rename', componentId: current.componentId, label: current.label }]);
        current.label = operation.label; changes.push(`Rename component ${current.componentId}; stable connection and evidence identities remain.`); break;
      }
      case 'component.resolve': {
        const current = component(operation.componentId), previous = clone(current), references = related(current.componentId);
        const oldDefinition = previous.definition ? findDefinition(catalog, previous.definition) : undefined;
        const definition = operation.definition ? findDefinition(catalog, operation.definition) : undefined;
        if (operation.definition && !definition) fail('The exact target definition/version is not available.');
        if (stable(current.definition) === stable(operation.definition) && operation.pinMapping && Object.keys(operation.pinMapping).length) fail('Use an explicit net edit to reassign pins within the same definition.');
        if (!operation.definition && !current.provisionalPins) current.provisionalPins = componentPins(previous, catalog).map(pin => ({ pinId: pin.pinId, label: pin.label }));
        const migration = oldDefinition && definition ? definitionMigration(oldDefinition, definition, operation.pinMapping) : null;
        const mappings = new Set<string>();
        const remap = (pinId: string): string => {
          const oldPin = oldDefinition ? canonicalEndpoint({ ...next, components: next.components.map(item => item.componentId === current.componentId ? previous : item) }, { componentId: current.componentId, pinId }, catalog).pinId : pinId;
          const explicit = operation.pinMapping && (Object.hasOwn(operation.pinMapping, oldPin) ? operation.pinMapping[oldPin] : Object.hasOwn(operation.pinMapping, pinId) ? operation.pinMapping[pinId] : undefined);
          const migrated = migration?.endpointMappings.find(item => item.fromPinId === oldPin)?.toPinId;
          const requested = explicit ?? migrated ?? oldPin;
          const pin = definition ? canonicalPin(definition, requested) : current.provisionalPins?.find(pin => pin.pinId === requested);
          if (!pin) fail(`Pin ${oldPin} has no reviewed target mapping; resolve it explicitly.`);
          if (oldPin !== pin.pinId) mappings.add(`${oldPin} -> ${pin.pinId}`);
          return pin.pinId;
        };
        for (const net of next.nets) for (const endpoint of net.members) if (endpoint.componentId.toLowerCase() === current.componentId.toLowerCase()) endpoint.pinId = remap(endpoint.pinId);
        for (const binding of next.codeBindings) if (binding.componentId.toLowerCase() === current.componentId.toLowerCase() && binding.pinId) binding.pinId = remap(binding.pinId);
        if (current.properties?.pinModes !== undefined) {
          if (!plain(current.properties.pinModes)) fail('Pin mode metadata is invalid; resolve it without discarding user properties.');
          const modes: Record<string, unknown> = Object.create(null);
          for (const [pinId, mode] of Object.entries(current.properties.pinModes)) {
            const mapped = remap(pinId);
            if (Object.hasOwn(modes, mapped) && modes[mapped] !== mode) fail('Definition migration combines conflicting pin modes; resolve those assignments explicitly.');
            modes[mapped] = mode;
          }
          current.properties = { ...current.properties, pinModes: Object.fromEntries(Object.entries(modes)) };
        }
        current.definition = clone(operation.definition); current.identityStatus = operation.definition ? 'resolved' : 'unresolved';
        inverse.push([{ type: 'component.replace', component: previous }, ...references.nets.map(net => ({ type: 'net.set' as const, net })), ...references.bindings.map(binding => ({ type: 'binding.set' as const, binding }))]);
        changes.push(`Change definition for ${current.componentId}: ${previous.definition ? `${previous.definition.definitionId}@${previous.definition.definitionVersion}` : 'unresolved'} -> ${operation.definition ? `${operation.definition.definitionId}@${operation.definition.definitionVersion}` : 'unresolved'}.`);
        if (migration) changes.push(...migration.endpointMappings.filter(item => item.fromPinId !== item.toPinId).map(item => `Pin migration ${current.componentId}: ${item.fromPinId} -> ${item.toPinId ?? 'unresolved'}.`));
        else changes.push(...[...mappings].map(mapping => `Pin migration ${current.componentId}: ${mapping}.`));
        break;
      }
      case 'component.remove': {
        const current = component(operation.componentId), references = related(current.componentId), documents = next.documents.filter(document => document.componentIds?.some(id => id.toLowerCase() === current.componentId.toLowerCase())).map(clone);
        if (!operation.removeBindings && references.bindings.length) fail('Component has source bindings; explicitly approve their removal or resolve them first.');
        const beforeComponentId = next.components[next.components.indexOf(current) + 1]?.componentId;
        const bindings: WiringOperation[] = references.bindings.slice().reverse().map(binding => {
          const index = next.codeBindings.findIndex(item => item.bindingId === binding.bindingId), beforeBindingId = next.codeBindings[index + 1]?.bindingId;
          return { type: 'binding.set', binding, ...(beforeBindingId ? { beforeBindingId } : {}) };
        });
        next.components = next.components.filter(item => item !== current);
        next.nets = next.nets.map(net => ({ ...net, members: net.members.filter(endpoint => endpoint.componentId.toLowerCase() !== current.componentId.toLowerCase()) })).filter(net => net.members.length >= 2);
        next.codeBindings = next.codeBindings.filter(binding => binding.componentId.toLowerCase() !== current.componentId.toLowerCase());
        next.documents = next.documents.map(document => document.componentIds ? { ...document, componentIds: document.componentIds.filter(id => id.toLowerCase() !== current.componentId.toLowerCase()) } : document);
        inverse.push([{ type: 'component.add', component: clone(current), ...(beforeComponentId ? { beforeComponentId } : {}) }, ...references.nets.map(net => ({ type: 'net.set' as const, net })), ...bindings, ...documents.map(document => ({ type: 'document.set' as const, document }))]);
        changes.push(`Remove component ${current.componentId}, ${references.nets.length} affected net memberships, ${references.bindings.length} source bindings and ${documents.length} document associations. Catalog definitions, inventory, source/document files and historical evidence are retained.`); break;
      }
      case 'net.set': {
        const index = next.nets.findIndex(net => net.netId.toLowerCase() === operation.net.netId.toLowerCase()), previous = next.nets[index];
        inverse.push([previous ? { type: 'net.set', net: clone(previous) } : { type: 'net.remove', netId: operation.net.netId }]);
        if (index < 0) next.nets.push(clone(operation.net)); else next.nets[index] = clone(operation.net);
        changes.push(`Set intended net ${operation.net.netId} to ${operation.net.members.length} explicit endpoints; visual crossings add no membership.`); break;
      }
      case 'net.remove': {
        const index = next.nets.findIndex(net => net.netId.toLowerCase() === operation.netId.toLowerCase()); if (index < 0) fail('Net no longer exists.', 'NOT_FOUND');
        inverse.push([{ type: 'net.set', net: clone(next.nets[index]) }]); next.nets.splice(index, 1); changes.push(`Remove intended net ${operation.netId}; historical references remain in the migration record.`); break;
      }
      case 'binding.set': {
        sourcePath(operation.binding.path);
        const index = next.codeBindings.findIndex(binding => binding.bindingId.toLowerCase() === operation.binding.bindingId.toLowerCase()), previous = next.codeBindings[index];
        inverse.push([previous ? { type: 'binding.set', binding: clone(previous) } : { type: 'binding.remove', bindingId: operation.binding.bindingId }]);
        if (index < 0) {
          const insertion = operation.beforeBindingId ? next.codeBindings.findIndex(item => item.bindingId.toLowerCase() === operation.beforeBindingId!.toLowerCase()) : next.codeBindings.length;
          if (insertion < 0) fail('Binding insertion anchor no longer exists.', 'NOT_FOUND');
          next.codeBindings.splice(insertion, 0, clone(operation.binding));
        } else {
          if (operation.beforeBindingId) fail('Binding insertion anchors apply only to absent bindings.');
          next.codeBindings[index] = clone(operation.binding);
        }
        changes.push(`Set explicit source binding ${operation.binding.bindingId}. Expressions and firmware edits are not inferred.`); break;
      }
      case 'binding.remove': {
        const index = next.codeBindings.findIndex(binding => binding.bindingId.toLowerCase() === operation.bindingId.toLowerCase()); if (index < 0) fail('Binding no longer exists.', 'NOT_FOUND');
        const beforeBindingId = next.codeBindings[index + 1]?.bindingId;
        inverse.push([{ type: 'binding.set', binding: clone(next.codeBindings[index]), ...(beforeBindingId ? { beforeBindingId } : {}) }]); next.codeBindings.splice(index, 1); changes.push(`Remove source association ${operation.bindingId}; the source file is unchanged.`); break;
      }
      case 'document.set': {
        sourcePath(operation.document.path);
        const index = next.documents.findIndex(document => document.documentId.toLowerCase() === operation.document.documentId.toLowerCase()); if (index < 0) fail('Document association no longer exists.', 'NOT_FOUND');
        inverse.push([{ type: 'document.set', document: clone(next.documents[index]) }]); next.documents[index] = clone(operation.document); changes.push(`Restore reviewed component associations for document ${operation.document.documentId}; document bytes are unchanged.`); break;
      }
      case 'pin.mode': {
        const current = component(operation.componentId), previous = clone(current), endpoint = canonicalEndpoint(next, { componentId: current.componentId, pinId: operation.pinId }, catalog);
        const pin = componentPins(current, catalog).find(pin => pin.pinId === endpoint.pinId);
        if (!pin || !pin.modes.includes(operation.mode as typeof pin.modes[number])) fail('Selected mode is not declared for this canonical pin.');
        const old = current.properties?.pinModes; if (old !== undefined && !plain(old)) fail('Pin mode metadata is invalid; repair it without erasing other properties.');
        const modes: Record<string, unknown> = Object.assign(Object.create(null), old ?? {});
        for (const alias of Object.keys(modes)) { try { if (canonicalEndpoint(next, { componentId: current.componentId, pinId: alias }, catalog).pinId === endpoint.pinId) delete modes[alias]; } catch {} }
        modes[endpoint.pinId] = operation.mode; current.properties = { ...current.properties, pinModes: Object.fromEntries(Object.entries(modes)) };
        inverse.push([{ type: 'component.replace', component: previous }]); changes.push(`Select mode ${operation.mode} for ${current.componentId}:${endpoint.pinId}.`); break;
      }
    }
  }
  next.nets = canonicalizeNets(next, catalog);
  next.codeBindings = next.codeBindings.map(binding => binding.pinId ? { ...binding, ...canonicalEndpoint(next, { componentId: binding.componentId, pinId: binding.pinId }, catalog) } : binding);
  for (const binding of next.codeBindings) sourcePath(binding.path);
  for (const document of next.documents) sourcePath(document.path);
  validateManifest(next); assertManifestSemantics(next);
  const changed = intent(manifest, catalog) !== intent(next, catalog);
  if (changed && !Number.isSafeInteger(manifest.projectRevision + 1)) fail('Project revision exhausted its supported integer range.');
  const result = changed ? next : clone(manifest); result.projectRevision = changed ? manifest.projectRevision + 1 : manifest.projectRevision;
  return { schemaVersion: 1, projectId: manifest.projectId, expectedProjectRevision: expectedRevision, next: result, inverseOperations: changed ? inverse.reverse().flat() : [], changes: changed ? changes : [], rules: validateWiring(result, catalog), confirmationInvalidated: changed };
}
