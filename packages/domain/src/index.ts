import { WorkbenchError, type OperationStatus, type WorkbenchManifest } from '@robotics-workbench/contracts';
export * from './components';
export * from './wiring';

export function assertManifestSemantics(manifest: WorkbenchManifest, definitionPins?: ReadonlyMap<string, ReadonlySet<string>>): void {
  const ids = new Set<string>();
  for (const id of [manifest.projectId, ...manifest.targets.map(item => item.targetId), ...manifest.components.map(item => item.componentId),
    ...manifest.nets.map(item => item.netId), ...manifest.codeBindings.map(item => item.bindingId), ...manifest.documents.map(item => item.documentId)]) {
    const key = id.toLowerCase();
    if (ids.has(key)) throw new WorkbenchError('INVALID_REQUEST', 'Manifest contains duplicate identities.');
    ids.add(key);
  }
  const components = new Map(manifest.components.map(item => [item.componentId.toLowerCase(), item]));
  const targets = new Set(manifest.targets.map(item => item.targetId.toLowerCase()));
  for (const sketch of manifest.sketches) {
    if (!targets.has(sketch.targetId.toLowerCase())) throw new WorkbenchError('INVALID_REQUEST', 'Sketch references a missing compiler target.');
  }
  for (const component of manifest.components) {
    const pins = component.provisionalPins?.map(pin => pin.pinId) ?? [];
    if (new Set(pins).size !== pins.length) throw new WorkbenchError('INVALID_REQUEST', 'Component contains duplicate provisional pin identities.');
  }
  function endpoint(componentId: string, pinId?: string): void {
    const component = components.get(componentId.toLowerCase());
    if (!component) throw new WorkbenchError('INVALID_REQUEST', 'Manifest references a missing component.');
    if (!pinId) return;
    const pins = component.definition
      ? definitionPins?.get(`${component.definition.definitionId}@${component.definition.definitionVersion}`)
      : new Set(component.provisionalPins?.map(pin => pin.pinId) ?? []);
    if (pins && !pins.has(pinId)) throw new WorkbenchError('INVALID_REQUEST', 'Manifest references an undeclared pin.');
  }
  for (const net of manifest.nets) {
    const members = new Set<string>();
    for (const pin of net.members) {
      endpoint(pin.componentId, pin.pinId);
      const key = `${pin.componentId.toLowerCase()}:${pin.pinId}`;
      if (members.has(key)) throw new WorkbenchError('INVALID_REQUEST', 'Net contains a duplicate endpoint.');
      members.add(key);
    }
  }
  for (const binding of manifest.codeBindings) endpoint(binding.componentId, binding.pinId);
  for (const document of manifest.documents) for (const componentId of document.componentIds ?? []) endpoint(componentId);
}

export function assertRevision(manifest: WorkbenchManifest, expectedRevision: number, expectedHash: string, actualHash: string): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== manifest.projectRevision || !/^[a-f0-9]{64}$/.test(expectedHash) || expectedHash !== actualHash) {
    throw new WorkbenchError('REVISION_CONFLICT', 'Project changed. Refresh and review before applying this request.', { currentRevision: manifest.projectRevision });
  }
}

const transitions: Record<OperationStatus, readonly OperationStatus[]> = {
  queued: ['running', 'awaiting-input', 'cancelled', 'failed'],
  running: ['awaiting-input', 'succeeded', 'failed', 'cancelled', 'outcome-unknown'],
  'awaiting-input': ['running', 'cancelled', 'failed', 'outcome-unknown'],
  succeeded: [], failed: [], cancelled: [], 'outcome-unknown': []
};
export function assertTransition(from: OperationStatus, to: OperationStatus): void {
  if (!Object.hasOwn(transitions, from) || !transitions[from].includes(to)) {
    throw new WorkbenchError('INVALID_REQUEST', `Operation transition ${from} to ${to} is not allowed. Preserve terminal history and append a reconciliation receipt.`);
  }
}
