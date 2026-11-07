import { WorkbenchError, type ComponentDefinition, type LogicalPin, type NumericFact, type WorkbenchManifest, type WiringRuleResult } from '@robotics-workbench/contracts';
import { canonicalPin, convertFact, findDefinition } from './components';

type Component = WorkbenchManifest['components'][number];
type Endpoint = WorkbenchManifest['nets'][number]['members'][number];
const key = (endpoint: Endpoint) => `${endpoint.componentId.toLowerCase()}:${endpoint.pinId}`;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const componentById = (manifest: WorkbenchManifest, id: string) => manifest.components.find(component => component.componentId.toLowerCase() === id.toLowerCase());

/** Provisional labels remain usable without becoming reviewed electrical facts. */
export function componentPins(component: Component, catalog: readonly ComponentDefinition[]): LogicalPin[] {
  const definition = component.definition ? findDefinition(catalog, component.definition) : undefined;
  return definition ? definition.pins.map(pin => pinReviewed(pin, definition) ? structuredClone(pin) : { ...structuredClone(pin), electricalType: 'unknown', modes: ['unknown'], voltageRange: null, driveVoltage: null, busKind: null }) : (component.provisionalPins ?? []).map(pin => ({ ...pin, aliases: [], electricalType: 'unknown', modes: ['unknown'], required: false, sourceIds: [], voltageRange: null, driveVoltage: null, busKind: null }));
}
function pinReviewed(pin: LogicalPin, definition: ComponentDefinition): boolean { return pin.sourceIds.length > 0 && pin.sourceIds.every(id => definition.sources.some(source => source.sourceId === id && source.reviewStatus === 'reviewed' && !!source.reviewedBy)); }

export function canonicalEndpoint(manifest: WorkbenchManifest, endpoint: Endpoint, catalog: readonly ComponentDefinition[]): Endpoint {
  const component = componentById(manifest, endpoint.componentId);
  if (!component) throw new WorkbenchError('INVALID_REQUEST', 'Connection references a missing component.');
  const definition = component.definition ? findDefinition(catalog, component.definition) : undefined;
  const pin = definition ? canonicalPin(definition, endpoint.pinId) : component.provisionalPins?.find(item => item.pinId === endpoint.pinId);
  if (!pin && (definition || !component.definition)) throw new WorkbenchError('INVALID_REQUEST', 'Connection references an undeclared logical pin.');
  return { componentId: component.componentId, pinId: pin?.pinId ?? endpoint.pinId };
}

/** Net geometry is absent: only explicit unordered endpoint membership has meaning. */
export function canonicalizeNets(manifest: WorkbenchManifest, catalog: readonly ComponentDefinition[]): WorkbenchManifest['nets'] {
  return manifest.nets.map(net => {
    const members = new Map<string, Endpoint>();
    for (const endpoint of net.members) { const canonical = canonicalEndpoint(manifest, endpoint, catalog); members.set(key(canonical), canonical); }
    if (members.size < 2) throw new WorkbenchError('INVALID_REQUEST', 'A net needs two distinct logical endpoints after alias resolution.');
    return { ...structuredClone(net), members: [...members.values()].sort((a, b) => compare(key(a), key(b))) };
  }).sort((a, b) => compare(a.netId.toLowerCase(), b.netId.toLowerCase()));
}

function pinDetails(manifest: WorkbenchManifest, endpoint: Endpoint, catalog: readonly ComponentDefinition[]) {
  const component = componentById(manifest, endpoint.componentId)!;
  const definition = component.definition ? findDefinition(catalog, component.definition) : undefined;
  const pin = componentPins(component, catalog).find(item => item.pinId === endpoint.pinId);
  const modes = component.properties?.pinModes;
  const assigned = modes && typeof modes === 'object' && !Array.isArray(modes) ? Object.entries(modes).filter(([alias]) => definition ? canonicalPin(definition, alias)?.pinId === endpoint.pinId : alias === endpoint.pinId).map(([, mode]) => mode) : [];
  const mode = assigned[0];
  const modeTypes: Record<string, LogicalPin['electricalType']> = { input: 'input', 'analog-input': 'input', output: 'output', 'pwm-output': 'output', 'open-drain': 'open-drain', ground: 'ground', passive: 'passive', bidirectional: 'bidirectional', unknown: 'unknown' };
  const electricalType = typeof mode === 'string' && Object.hasOwn(modeTypes, mode) && pin?.modes.includes(mode as LogicalPin['modes'][number]) ? modeTypes[mode] : pin?.electricalType ?? 'unknown';
  const sourceFacts = definition ? (pin?.sourceIds ?? []).map(source => `${definition.definitionId}@${definition.definitionVersion}:${source}`) : [];
  return { component, definition, pin, assigned, electricalType, sourceFacts };
}
function reviewedVoltage(fact: NumericFact | null | undefined, definition?: ComponentDefinition): number | null {
  if (!fact || fact.value === null || fact.reviewStatus !== 'reviewed' || !['recommended', 'absolute-maximum'].includes(fact.classification) || !definition?.sources.some(source => source.sourceId === fact.sourceId && source.reviewStatus === 'reviewed' && !!source.reviewedBy)) return null;
  try { return convertFact(fact, 'V').value; } catch { return null; }
}
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, Math.abs(a), Math.abs(b)) * Number.EPSILON * 8;

export function validateWiring(manifest: WorkbenchManifest, catalog: readonly ComponentDefinition[]): WiringRuleResult[] {
  const results: WiringRuleResult[] = [];
  const report = (ruleId: string, outcome: WiringRuleResult['outcome'], affectedIds: string[], explanation: string, sourceFacts: string[] = [], severity: WiringRuleResult['severity'] = outcome === 'fail' ? 'error' : outcome === 'not-checked' ? 'warning' : 'info') => {
    results.push({ ruleId: `wiring.${ruleId}`, ruleVersion: '1', severity, outcome, affectedIds, projectRevision: manifest.projectRevision, sourceFacts: [...new Set(sourceFacts)], explanation });
  };
  let nets: WorkbenchManifest['nets'];
  try { nets = canonicalizeNets(manifest, catalog); }
  catch (error) { report('references', 'fail', [manifest.projectId], error instanceof WorkbenchError ? error.message : 'Connection references are invalid.'); return results; }
  report('references', 'pass', nets.map(net => net.netId), 'All represented connections resolve; unresolved definitions still lack electrical facts.');
  const resources = new Map<string, string>();
  for (const net of nets) {
    const details = net.members.map(endpoint => pinDetails(manifest, endpoint, catalog));
    const affected = [net.netId, ...new Set(net.members.map(endpoint => endpoint.componentId))];
    const facts = details.flatMap(item => item.sourceFacts);
    for (const endpoint of net.members) {
      const existing = resources.get(key(endpoint));
      if (existing && existing !== net.netId) report('resource-allocation', 'fail', [existing, net.netId, endpoint.componentId], `Logical pin ${endpoint.pinId} belongs to multiple separate nets; merge intended membership explicitly.`);
      else resources.set(key(endpoint), net.netId);
    }
    const knownModes = ['input', 'output', 'analog-input', 'pwm-output', 'open-drain', 'power', 'ground', 'passive', 'bidirectional', 'unknown'];
    const invalidModes = details.filter(item => item.assigned.length > 1 && new Set(item.assigned).size > 1 || item.assigned.some(mode => typeof mode !== 'string' || !knownModes.includes(mode) || item.pin && item.pin.modes.some(mode => mode !== 'unknown') && !item.pin.modes.includes(mode as LogicalPin['modes'][number])));
    report('pin-mode', invalidModes.length ? 'fail' : details.some(item => !item.pin || item.electricalType === 'unknown') ? 'not-checked' : 'pass', affected,
      invalidModes.length ? 'A canonical pin has conflicting or unsupported selected modes.' : 'Selected modes are scoped to canonical resources; absent electrical facts remain unknown.', facts);
    const driven = details.filter(item => ['output', 'power-out'].includes(item.electricalType));
    const grounded = details.some(item => item.electricalType === 'ground');
    const directionUnknown = details.some(item => !item.pin || ['unknown', 'bidirectional'].includes(item.electricalType));
    report('signal-direction', driven.length > 1 || driven.length > 0 && grounded ? 'fail' : directionUnknown || !driven.length && !details.every(item => ['ground', 'open-drain', 'passive'].includes(item.electricalType)) ? 'not-checked' : 'pass', affected,
      driven.length > 1 ? 'Multiple driven outputs share an intended net.' : driven.length && grounded ? 'A driven output is directly connected to a declared ground.' : directionUnknown ? 'Direction depends on unresolved identity or selected mode.' : 'This finite direction check does not establish circuit safety or physical continuity.', facts);

    const source = driven.length === 1 ? driven[0] : undefined;
    const voltage = source?.pin?.driveVoltage;
    const value = reviewedVoltage(voltage, source?.definition);
    let voltageOutcome: WiringRuleResult['outcome'] = details.every(item => item.electricalType === 'ground') ? 'not-applicable' : 'not-checked';
    let voltageExplanation = 'A reviewed source voltage and applicable reviewed operating ranges are required; unknown is not zero.';
    const voltageFacts = [...facts];
    if (source?.definition && voltage) voltageFacts.push(`${source.definition.definitionId}@${source.definition.definitionVersion}:${voltage.sourceId}`);
    if (value !== null && voltage?.classification === 'recommended') {
      const receivers = details.filter(item => item !== source && item.electricalType !== 'ground');
      let checked = receivers.length > 0, exceeded = false;
      for (const receiver of receivers) {
        const range = receiver.pin?.voltageRange;
        if (!range) { checked = false; continue; }
        const minimum = reviewedVoltage(range.minimum, receiver.definition), maximum = reviewedVoltage(range.maximum, receiver.definition);
        if (receiver.definition) voltageFacts.push(...[range.minimum, range.maximum].map(fact => `${receiver.definition!.definitionId}@${receiver.definition!.definitionVersion}:${fact.sourceId}`));
        if (minimum === null || maximum === null) checked = false;
        else if (value < minimum && !near(value, minimum) || near(value, minimum) && !range.minimumInclusive || value > maximum && !near(value, maximum) || near(value, maximum) && !range.maximumInclusive) exceeded = true;
        if (range.minimum.classification !== 'recommended' || range.maximum.classification !== 'recommended') checked = false;
      }
      voltageOutcome = exceeded ? 'fail' : checked ? 'pass' : 'not-checked';
      voltageExplanation = exceeded ? 'Declared intended source voltage exceeds a reviewed applicable bound.' : checked ? 'Declared intended voltage lies within reviewed recommended ranges; this is not a measurement.' : 'Absolute maxima, typical, candidate or missing limits cannot establish a recommended operating range.';
    }
    report('voltage', voltageOutcome, affected, voltageExplanation, voltageFacts);
    const busKinds = [...new Set(details.map(item => item.pin?.busKind).filter(Boolean))];
    if (!busKinds.length) report('bus', 'not-applicable', affected, 'No bus participation is declared.');
    else if (busKinds.length > 1) report('bus', 'fail', affected, 'Declared bus families are incompatible on this signal.', facts);
    else if (busKinds[0] === 'i2c' && details.every(item => ['open-drain', 'passive'].includes(item.electricalType))) report('bus', 'pass', affected, 'Shared open-drain membership is permitted. Address, pull-up, speed, loading and firmware conditions remain unchecked.', facts);
    else report('bus', 'not-checked', affected, 'Bus roles or electrical participation need review; address, pull-up, speed, loading and firmware conditions remain unchecked.', facts);
  }
  for (const component of manifest.components) {
    const definition = component.definition ? findDefinition(catalog, component.definition) : undefined;
    if (!definition) { report('required-connections', 'not-checked', [component.componentId], 'Required connections are unknown until the exact definition is resolved.'); continue; }
    const required = definition.pins.filter(pin => pin.required), missing = required.filter(pin => pinReviewed(pin, definition) && !resources.has(key({ componentId: component.componentId, pinId: pin.pinId })));
    report('required-connections', missing.length ? 'fail' : required.some(pin => !pinReviewed(pin, definition)) ? 'not-checked' : required.length ? 'pass' : 'not-applicable', [component.componentId], missing.length ? `Required logical pins are not connected: ${missing.map(pin => pin.pinId).join(', ')}.` : 'Required represented endpoints are scoped to reviewed facts; no physical continuity was measured.', definition.sources.map(source => `${definition.definitionId}@${definition.definitionVersion}:${source.sourceId}`));
  }
  for (const binding of manifest.codeBindings) {
    try { if (binding.pinId) canonicalEndpoint(manifest, { componentId: binding.componentId, pinId: binding.pinId }, catalog); else if (!componentById(manifest, binding.componentId)) throw Error();
      report('code-binding', 'not-checked', [binding.bindingId, binding.componentId], 'Explicit source binding retained. Source expression, selected mode and compiler configuration are not inferred from a numeric literal.');
    } catch { report('code-binding', 'fail', [binding.bindingId, binding.componentId], 'Binding references a missing component or logical pin.'); }
  }
  return results;
}
