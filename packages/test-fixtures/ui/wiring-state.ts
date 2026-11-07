import type { WiringViewState } from '@robotics-workbench/contracts';

export const wiringFixtureIds = { project: '11111111-1111-4111-8111-111111111111', board: '22222222-2222-4222-8222-222222222222', sensor: '33333333-3333-4333-8333-333333333333', second: '44444444-4444-4444-8444-444444444444', net: '55555555-5555-4555-8555-555555555555', binding: '66666666-6666-4666-8666-666666666666', target: '77777777-7777-4777-8777-777777777777', document: '88888888-8888-4888-8888-888888888888' };
/** Synthetic display records: none of these fields identifies physical hardware. */
export function wiringViewFixture(): WiringViewState {
  const i = wiringFixtureIds;
  return { schemaVersion: 1, trusted: true, loading: false, error: null, project: { projectId: i.project, projectRevision: 4, name: 'Distance sensor fixture', manifestSha256: 'a'.repeat(64) },
    manifest: { schemaVersion: 1, projectId: i.project, projectRevision: 4, name: 'Distance sensor fixture', sketches: [{ path: '.', targetId: i.target }], targets: [{ targetId: i.target, fqbn: 'arduino:avr:uno', options: {} }],
      components: [{ componentId: i.board, label: 'Reference controller', definition: { definitionId: 'fixture:board', definitionVersion: '1' }, identityStatus: 'resolved', properties: { pinModes: { trig: 'output' } } }, { componentId: i.sensor, label: 'Front range module', definition: null, identityStatus: 'unresolved', candidateLabels: ['Part markings unconfirmed'], provisionalPins: [{ pinId: 'trig', label: 'TRIG' }, { pinId: 'echo', label: 'ECHO' }, { pinId: 'sda', label: 'SDA' }] }, { componentId: i.second, label: 'Second fixture device', definition: { definitionId: 'fixture:device', definitionVersion: '1' }, identityStatus: 'resolved' }],
      nets: [{ netId: i.net, label: 'Shared fixture bus', members: [{ componentId: i.board, pinId: 'sda' }, { componentId: i.sensor, pinId: 'sda' }, { componentId: i.second, pinId: 'sda' }], intent: { designState: 'proposed', sourceRefs: [] } }],
      codeBindings: [{ bindingId: i.binding, componentId: i.sensor, pinId: 'trig', path: 'DistanceProbe.ino', symbol: 'TRIGGER_PIN', line: 7 }], documents: [{ documentId: i.document, path: 'docs/part-notes.txt', title: 'Part identification notes', componentIds: [i.sensor] }], extensions: {} },
    catalog: [{ definitionId: 'fixture:board', definitionVersion: '1', label: 'Synthetic controller', detail: 'Synthetic pin facts for rendering only.' }, { definitionId: 'fixture:device', definitionVersion: '1', label: 'Synthetic bus device', detail: 'Synthetic shared-bus behavior; no real rating.' }],
    pins: {
      [i.board]: [{ pinId: 'trig', label: 'D8', aliases: ['digital-8'], modes: ['input', 'output'], electricalType: 'digital' }, { pinId: 'sda', label: 'SDA', aliases: ['A4', 'D18'], modes: ['open-drain'], electricalType: 'open-drain' }],
      [i.sensor]: [{ pinId: 'trig', label: 'TRIG', aliases: [], modes: [], electricalType: 'unknown' }, { pinId: 'echo', label: 'ECHO', aliases: [], modes: [], electricalType: 'unknown' }, { pinId: 'sda', label: 'SDA', aliases: [], modes: [], electricalType: 'unknown' }],
      [i.second]: [{ pinId: 'sda', label: 'SDA', aliases: [], modes: ['open-drain'], electricalType: 'open-drain' }]
    },
    rules: [{ ruleId: 'voltage-domain', ruleVersion: '1', severity: 'warning', outcome: 'not-checked', affectedIds: [i.sensor, i.net], projectRevision: 4, sourceFacts: [], explanation: 'Part identity and reviewed voltage limits are missing. No compatible-voltage verdict is available.' }],
    confirmations: [{ observationId: '99999999-9999-4999-8999-999999999999', subjectIds: [i.sensor, i.net], projectRevision: 3, basis: 'reported', result: 'passed', procedure: 'Synthetic visual inspection record', note: 'Historical user report, not an instrument measurement.', observedAt: '2026-11-01T10:00:00Z', applicability: 'stale' }],
    layout: { revision: 1, sha256: 'b'.repeat(64), positions: { [i.board]: { x: 0, y: 0 }, [i.sensor]: { x: 300, y: 0 }, [i.second]: { x: 300, y: 230 } } }, selection: { kind: 'component', id: i.sensor }, preview: null };
}
