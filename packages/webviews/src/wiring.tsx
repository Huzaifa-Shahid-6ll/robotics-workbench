import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlow, Handle, Position, Controls, Background, ConnectionMode, useNodesState, type Node, type NodeProps, type Edge, type Connection, type Viewport } from '@xyflow/react';
import type { WorkbenchManifest, WiringOperation, WiringViewAction, WiringViewRequest, WiringViewState } from '@robotics-workbench/contracts';
import '@xyflow/react/dist/style.css';
import './workbench.css';
import './wiring.css';
import { isWiringViewResponse } from './wiring-protocol';

export const emptyWiringState: WiringViewState = { schemaVersion: 1, trusted: false, loading: false, error: null, project: null, manifest: null, catalog: [], pins: {}, rules: [], confirmations: [], layout: { revision: 0, sha256: null, positions: {} }, selection: null, preview: null };
export type SendWiringIntent = (type: WiringViewAction, payload?: Record<string, unknown>) => void;
const endpointKey = (p: { componentId: string; pinId: string }) => `${p.componentId.toLowerCase()}:${p.pinId}`;
/** Graph gestures and the keyboard table propose the same unordered net transaction. */
export function connectionOperations(manifest: WorkbenchManifest, first: { componentId: string; pinId: string }, second: { componentId: string; pinId: string }, netId: string, label = ''): WiringOperation[] {
  if (endpointKey(first) === endpointKey(second)) return [];
  const matching = manifest.nets.filter(net => net.members.some(member => [endpointKey(first), endpointKey(second)].includes(endpointKey(member))));
  const members = [...new Map([...matching.flatMap(net => net.members), first, second].map(member => [endpointKey(member), member])).values()];
  const net = matching[0] ? { ...matching[0], members } : { netId, label: label || 'Intended connection', members, intent: { designState: 'proposed' as const, sourceRefs: [] } };
  return [{ type: 'net.set', net }, ...matching.slice(1).map(net => ({ type: 'net.remove' as const, netId: net.netId }))];
}
type Pin = WiringViewState['pins'][string][number];
type PartNode = Node<{ label: string; pins: Pin[]; unresolved: boolean }, 'part'>;
function ComponentNode({ data }: NodeProps<PartNode>) {
  return <div className="wiring-node"><strong>{data.label}</strong>{data.unresolved && <span className="meta">Identity unresolved</span>}<div className="node-pins">{data.pins.map(pin => <div className="node-pin" key={pin.pinId}><Handle type="source" id={pin.pinId} position={Position.Left} aria-label={pin.label} /><span>{pin.label}</span><small>{pin.electricalType}</small></div>)}</div></div>;
}
const nodeTypes = { part: ComponentNode };
const resolvePin = (state: WiringViewState, componentId: string, pinId: string) => state.pins[componentId]?.find(pin => pin.pinId === pinId || pin.aliases.includes(pinId))?.pinId ?? pinId;
export function wiringEdges(state: WiringViewState): Edge[] {
  return state.manifest?.nets.flatMap(net => {
    const members = [...net.members].sort((a, b) => endpointKey(a).localeCompare(endpointKey(b)));
    return members.slice(1).map((member, index) => ({ id: `${net.netId}:${index}`, source: members[0].componentId, target: member.componentId, sourceHandle: resolvePin(state, members[0].componentId, members[0].pinId), targetHandle: resolvePin(state, member.componentId, member.pinId), label: net.label || 'Intended net', data: { netId: net.netId }, selected: state.selection?.kind === 'net' && state.selection.id === net.netId, focusable: true, deletable: false, ariaLabel: `${net.label || 'Intended net'}; select to inspect` }));
  }) ?? [];
}
function Canvas({ state, send, editable, viewport, onViewport }: { state: WiringViewState; send: SendWiringIntent; editable: boolean; viewport?: Viewport; onViewport: (viewport: Viewport) => void }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<PartNode>([]);
  const key = JSON.stringify([state.manifest?.components, state.pins, state.layout, state.selection, editable]);
  useEffect(() => {
    setNodes(previous => (state.manifest?.components ?? []).map((component, index) => ({ id: component.componentId, type: 'part', position: state.layout.positions[component.componentId] ?? previous.find(node => node.id === component.componentId)?.position ?? { x: (index % 3) * 250, y: Math.floor(index / 3) * 220 }, data: { label: component.label, pins: state.pins[component.componentId] ?? [], unresolved: component.definition === null }, selected: state.selection?.kind === 'component' && state.selection.id === component.componentId, draggable: editable, deletable: false, ariaLabel: `${component.label}; intended component` })));
  }, [key, setNodes]);
  const connect = (connection: Connection) => {
    if (!editable || !state.manifest || !connection.sourceHandle || !connection.targetHandle) return;
    const operations = connectionOperations(state.manifest, { componentId: connection.source, pinId: connection.sourceHandle }, { componentId: connection.target, pinId: connection.targetHandle }, crypto.randomUUID());
    if (operations.length) send('propose', { operations });
  };
  const edges = useMemo(() => wiringEdges(state), [state.manifest, state.pins, state.selection]);
  return <section className="wiring-canvas" aria-label="Intended wiring canvas"><ReactFlow<PartNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} connectionMode={ConnectionMode.Loose} onConnect={connect}
    onNodeClick={(_, node) => send('select', { kind: 'component', id: node.id })} onEdgeClick={(_, edge) => send('select', { kind: 'net', id: edge.data?.netId })}
    onNodeDragStop={(_, node) => { if (editable) send('layout', { positions: Object.fromEntries(nodes.map(item => [item.id, item.id === node.id ? node.position : item.position])) }); }}
    nodesConnectable={editable} nodesDraggable={editable} nodesFocusable edgesFocusable deleteKeyCode={null} defaultViewport={viewport} onMoveEnd={(_, view) => onViewport(view)} fitView={!viewport} fitViewOptions={{ padding: 0.2 }} minZoom={0.2} maxZoom={2} ariaLabelConfig={{ 'node.a11yDescription.default': 'Press Enter to select. Use the component inspector for keyboard layout and connection editing.', 'edge.a11yDescription.default': 'Press Enter to select this intended net. Connections are edited in the connection table.' }}>
    <Background /><Controls showInteractive={false} /></ReactFlow><p className="canvas-note">Lines are intended net membership. Crossings do not create connections. Dragging changes layout only.</p></section>;
}
type Tab = 'components' | 'connections' | 'canvas';
interface Draft { label: string; definition: string; pins: string; from: string; fromPin: string; to: string; toPin: string; netLabel: string; bindingPath: string; bindingPin: string; symbol: string; line: string; rename: string; x: string; y: string; resolveDefinition: string; pinMapping: string }
const initialDraft: Draft = { label: '', definition: '', pins: '', from: '', fromPin: '', to: '', toPin: '', netLabel: '', bindingPath: '', bindingPin: '', symbol: '', line: '', rename: '', x: '', y: '', resolveDefinition: '', pinMapping: '' };
export interface WiringUiState { tab: Tab; draft: Draft; addOpen: boolean; connectOpen: boolean; viewport?: Viewport }
export interface WiringAppProps { state: WiringViewState; send: SendWiringIntent; saved?: Partial<WiringUiState>; onSave?: (state: WiringUiState) => void }
const safePath = (value: string) => !!value && !/[\\:\x00-\x1f]/.test(value) && !value.startsWith('/') && !value.split('/').some(part => !part || part === '..' || part === '.');
export function WiringApp({ state, send, saved, onSave }: WiringAppProps) {
  const [tab, setTab] = useState<Tab>(saved?.tab ?? 'components'), [draft, setDraft] = useState<Draft>({ ...initialDraft, ...saved?.draft });
  const [addOpen, setAddOpen] = useState(saved?.addOpen ?? false), [connectOpen, setConnectOpen] = useState(saved?.connectOpen ?? false), [filter, setFilter] = useState(''), [localError, setLocalError] = useState<string | null>(null), [sending, setSending] = useState(false);
  const [viewport, setViewport] = useState<Viewport | undefined>(saved?.viewport);
  const lock = useRef(false);
  const connectionTab = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!state.loading) { lock.current = false; setSending(false); } }, [state]);
  useEffect(() => { onSave?.({ tab, draft, addOpen, connectOpen, ...(viewport ? { viewport } : {}) }); }, [tab, draft, addOpen, connectOpen, viewport, onSave]);
  const manifest = state.manifest, selected = state.selection?.kind === 'component' ? manifest?.components.find(item => item.componentId === state.selection!.id) : undefined;
  const selectedNet = state.selection?.kind === 'net' ? manifest?.nets.find(item => item.netId === state.selection!.id) : undefined;
  useEffect(() => { setDraft(value => ({ ...value, rename: selected?.label ?? '', resolveDefinition: selected?.definition ? `${selected.definition.definitionId}@${selected.definition.definitionVersion}` : '', pinMapping: '', bindingPin: '', x: String(state.layout.positions[selected?.componentId ?? '']?.x ?? 0), y: String(state.layout.positions[selected?.componentId ?? '']?.y ?? 0) })); }, [selected?.componentId]);
  const editable = state.trusted && !!state.project && !!manifest && !state.loading && !state.error && !sending;
  const effect: SendWiringIntent = (type, payload = {}) => { if (!editable || lock.current) return; lock.current = true; setSending(true); setLocalError(null); send(type, payload); };
  const field = (key: keyof Draft, value: string) => setDraft(previous => ({ ...previous, [key]: value }));
  const propose = (operations: WiringOperation[]) => { if (operations.length) effect('propose', { operations }); };
  const add = () => {
    const definition = state.catalog.find(item => `${item.definitionId}@${item.definitionVersion}` === draft.definition);
    const pins = draft.pins.split(',').map(value => value.trim()).filter(Boolean);
    if (!draft.label.trim() || new Set(pins).size !== pins.length || pins.some(pin => pin.length > 128 || /[\x00-\x1f]/.test(pin))) { setLocalError('Enter a component label and unique provisional pin IDs.'); return; }
    propose([{ type: 'component.add', component: { componentId: crypto.randomUUID(), label: draft.label.trim(), definition: definition ? { definitionId: definition.definitionId, definitionVersion: definition.definitionVersion } : null, identityStatus: definition ? 'resolved' : 'unresolved', ...(!definition ? { provisionalPins: pins.map(pin => ({ pinId: pin, label: pin })) } : {}) } }]);
  };
  const connect = () => { if (!manifest || !draft.from || !draft.fromPin || !draft.to || !draft.toPin) return; const operations = connectionOperations(manifest, { componentId: draft.from, pinId: draft.fromPin }, { componentId: draft.to, pinId: draft.toPin }, crypto.randomUUID(), draft.netLabel.trim()); if (!operations.length) setLocalError('Choose two different logical endpoints.'); else propose(operations); };
  const resolveDefinition = () => {
    if (!selected) return;
    const reference = state.catalog.find(item => `${item.definitionId}@${item.definitionVersion}` === draft.resolveDefinition);
    const entries = draft.pinMapping.split(/[\n,]/).map(value => value.trim()).filter(Boolean).map(value => value.split('=').map(part => part.trim()));
    if (entries.some(parts => parts.length !== 2 || parts.some(part => !part || part.length > 128)) || new Set(entries.map(parts => parts[0])).size !== entries.length) { setLocalError('Pin migration uses unique oldPin=newPin mappings.'); return; }
    propose([{ type: 'component.resolve', componentId: selected.componentId, definition: reference ? { definitionId: reference.definitionId, definitionVersion: reference.definitionVersion } : null, ...(entries.length ? { pinMapping: Object.fromEntries(entries) } : {}) }]);
  };
  const componentLabel = (id: string) => manifest?.components.find(item => item.componentId === id)?.label ?? 'Missing component';
  const issues = (id: string) => state.rules.filter(rule => rule.outcome === 'fail' || rule.outcome === 'not-checked').filter(rule => rule.affectedIds.includes(id) || manifest?.nets.some(net => net.members.some(member => member.componentId === id) && rule.affectedIds.includes(net.netId)));
  const confirmation = (id: string) => { const observations = state.confirmations.filter(item => item.subjectIds.includes(id)); const current = observations.filter(item => item.applicability === 'current'); return current.length ? new Set(current.map(item => item.result)).size > 1 ? 'Conflicting reports' : `${current.some(item => item.basis === 'measured') ? 'Measured' : 'User reported'}: ${current[0].result}` : observations.length ? 'Stale report' : 'Unconfirmed'; };
  const pinOptions = (componentId: string) => (state.pins[componentId] ?? []).map(pin => <option key={pin.pinId} value={pin.pinId}>{pin.label} ({pin.pinId})</option>);
  const failures = state.rules.filter(rule => rule.outcome === 'fail').length, unchecked = state.rules.filter(rule => rule.outcome === 'not-checked').length;
  const query = filter.trim().toLowerCase();
  const visibleComponents = manifest?.components.filter(component => !query || `${component.label} ${component.definition?.definitionId ?? 'unresolved'} ${issues(component.componentId).map(rule => rule.explanation).join(' ')}`.toLowerCase().includes(query)) ?? [];
  const hasEndpoints = (manifest?.components.reduce((count, component) => count + (state.pins[component.componentId]?.length ?? 0), 0) ?? 0) >= 2;
  return <div className="wiring-app"><header className="project-header"><div><h1>Intended wiring</h1><p className="meta">{state.project ? `${state.project.name} · revision ${state.project.projectRevision}` : 'Open a robotics project'}</p></div><button onClick={() => send('refresh')} disabled={state.loading}>Refresh</button></header>
    <div className="wiring-toolbar"><div className="actions"><button disabled={!editable} onClick={() => setAddOpen(value => !value)} aria-expanded={addOpen}>Add component</button><button disabled={!editable || !hasEndpoints} onClick={() => { setConnectOpen(value => !value); setTab('connections'); }} aria-expanded={connectOpen}>Connect endpoints</button><button disabled={!editable} onClick={() => effect('undo')}>Undo design edit</button><button onClick={() => send('openManifest')} disabled={!state.project}>Open manifest</button><button onClick={() => send('openCatalog')} disabled={!state.project}>Open catalog</button></div>
      {editable && !hasEndpoints && <p className="meta">Connections require at least two logical pins.</p>}
      <p className="meta">{failures} failing rules · {unchecked} not checked. Rule results do not certify a circuit or physical continuity.</p></div>
    {!state.trusted && <p className="notice" role="note">Restricted Mode: source inspection is available; design mutations require workspace trust.</p>}
    {(state.error || localError) && <p className="error" role="alert">{localError || state.error}</p>}{state.loading && <p className="notice" role="status">Refreshing or validating intent…</p>}
    {state.preview && <section className="wiring-preview" aria-label="Design change preview"><h2>Review intended design changes</h2><ul>{state.preview.changes.map((change, index) => <li key={index}>{change}</li>)}</ul>{state.preview.confirmationInvalidated && <p>Committing makes revision-scoped physical observations stale. It does not move wires or upload firmware.</p>}<details><summary>Proposed rule results ({state.preview.rules.length})</summary>{state.preview.rules.map((rule, index) => <p key={`${rule.ruleId}:${index}`} className={rule.outcome === 'fail' ? 'error-text' : 'meta'}>{rule.outcome}: {rule.explanation}</p>)}</details><div className="actions"><button className="primary" disabled={!editable || state.preview.rules.some(rule => rule.outcome === 'fail' && rule.severity === 'error')} onClick={() => effect('commit', { previewId: state.preview!.previewId })}>Commit design</button><button disabled={state.loading} onClick={() => send('discard')}>Discard preview</button></div></section>}
    {addOpen && <section className="wiring-form" aria-label="Add component"><h2>Add intended component</h2><div className="form-grid"><label>Component label<input value={draft.label} maxLength={256} onChange={event => field('label', event.target.value)} /></label><label>Reference definition<select aria-label="Reference definition" value={draft.definition} onChange={event => field('definition', event.target.value)}><option value="">Unresolved identity</option>{state.catalog.map(item => <option key={`${item.definitionId}@${item.definitionVersion}`} value={`${item.definitionId}@${item.definitionVersion}`}>{item.label} · {item.definitionVersion}</option>)}</select></label>{!draft.definition && <label className="span-all">Provisional pin IDs, comma separated<input value={draft.pins} maxLength={4096} placeholder="vcc, trig, echo, gnd" onChange={event => field('pins', event.target.value)} /></label>}</div>{draft.definition && <p className="meta">Reference details: {state.catalog.find(item => `${item.definitionId}@${item.definitionVersion}` === draft.definition)?.detail}</p>}<p className="meta">A label does not identify the actual part. Reference definitions apply only after an explicit choice; unresolved pin facts remain unknown.</p><button disabled={!editable || !draft.label.trim()} onClick={add}>Preview component</button></section>}
    {connectOpen && <section className="wiring-form" aria-label="Connect endpoints"><h2>Propose intended connection</h2><div className="form-grid"><label>First component<select aria-label="First component" value={draft.from} onChange={event => { field('from', event.target.value); field('fromPin', ''); }}><option value="">Select component</option>{manifest?.components.map(item => <option key={item.componentId} value={item.componentId}>{item.label}</option>)}</select></label><label>First logical pin<select aria-label="First logical pin" value={draft.fromPin} onChange={event => field('fromPin', event.target.value)}><option value="">Select pin</option>{pinOptions(draft.from)}</select></label><label>Second component<select aria-label="Second component" value={draft.to} onChange={event => { field('to', event.target.value); field('toPin', ''); }}><option value="">Select component</option>{manifest?.components.map(item => <option key={item.componentId} value={item.componentId}>{item.label}</option>)}</select></label><label>Second logical pin<select aria-label="Second logical pin" value={draft.toPin} onChange={event => field('toPin', event.target.value)}><option value="">Select pin</option>{pinOptions(draft.to)}</select></label><label className="span-all">New net label<input value={draft.netLabel} maxLength={256} onChange={event => field('netLabel', event.target.value)} /></label></div><p className="meta">Existing endpoint nets are merged explicitly in the preview. Visual line crossings have no electrical meaning.</p><button disabled={!editable || !draft.fromPin || !draft.toPin} onClick={connect}>Preview connection</button></section>}
    <nav className="tabs" aria-label="Design views">{(['components', 'connections', 'canvas'] as const).map(value => <button key={value} ref={value === 'connections' ? connectionTab : undefined} aria-current={tab === value ? 'page' : undefined} onClick={() => setTab(value)}>{value === 'components' ? `Components (${manifest?.components.length ?? 0})` : value === 'connections' ? `Connections (${manifest?.nets.length ?? 0})` : 'Canvas'}</button>)}</nav>
    <main className="wiring-content">{!manifest && <section className="empty"><h2>Keep source and intended connections together</h2><p>Open an ordinary Arduino project. Components can remain unresolved while exact part facts are gathered.</p></section>}
      {manifest && tab === 'components' && <section aria-label="Components table">
        <label className="filter">Filter components<input value={filter} onChange={event => setFilter(event.target.value)} placeholder="Name, definition or issue" /></label>
        {visibleComponents.length > 0 && <div className="table-scroll" role="region" aria-label="Component rows" tabIndex={0}>
          <table><caption className="sr-only">Intended components; physical observations are separate records</caption>
            <thead><tr><th>Name</th><th>Type / model</th><th>Logical pins / interface</th><th>Power domain</th><th>Physical observation</th><th>Issues</th></tr></thead>
            <tbody>{visibleComponents.map(component => {
              const rules = issues(component.componentId);
              return <tr key={component.componentId} aria-selected={selected?.componentId === component.componentId}>
                <th scope="row"><button className="link-button" onClick={() => send('select', { kind: 'component', id: component.componentId })}>{component.label}</button></th>
                <td>{component.definition ? <>{component.definition.definitionId}<small>Version {component.definition.definitionVersion}</small></> : 'Unresolved identity'}</td>
                <td>{(state.pins[component.componentId] ?? []).map(pin => pin.label).join(', ') || 'Unknown'}</td>
                <td>{typeof component.properties?.powerDomain === 'string' ? component.properties.powerDomain : 'Unknown'}</td>
                <td>{confirmation(component.componentId)}</td>
                <td>{rules.length ? `${rules.filter(rule => rule.outcome === 'fail').length} failing · ${rules.filter(rule => rule.outcome === 'not-checked').length} not checked` : 'No reported issue; limits still apply'}</td>
              </tr>;
            })}</tbody>
          </table>
        </div>}
        {!manifest.components.length && <p className="empty">No intended components. Add a labelled instance without guessing its electrical limits.</p>}
        <div role="status">{manifest.components.length > 0 && !visibleComponents.length && <p className="empty">No components match this filter.</p>}</div>
      </section>}
      {manifest && tab === 'connections' && <section aria-label="Connection table">
        <h2>Intended nets</h2><p className="meta">Each net is an unordered set of logical endpoints; multiple rows or crossed lines do not imply continuity.</p>
        {manifest.nets.length > 0 ? <div className="table-scroll" role="region" aria-label="Connection rows" tabIndex={0}>
          <table><thead><tr><th>Net</th><th>Member endpoints</th><th>Physical observation</th><th>Actions</th></tr></thead><tbody>{manifest.nets.map(net => <tr key={net.netId} aria-selected={selectedNet?.netId === net.netId}>
            <th scope="row"><button className="link-button" onClick={() => send('select', { kind: 'net', id: net.netId })}>{net.label || 'Unnamed net'}</button></th>
            <td>{net.members.map(member => <span className="endpoint" key={endpointKey(member)}>{componentLabel(member.componentId)} · {member.pinId}</span>)}</td>
            <td>{confirmation(net.netId)}</td>
            <td><button disabled={!editable} onClick={() => propose([{ type: 'net.remove', netId: net.netId }])}>Preview removal</button></td>
          </tr>)}</tbody></table>
        </div> : <p className="empty">No intended nets.{hasEndpoints && ' Use Connect endpoints to propose a net.'}</p>}
      </section>}
      {manifest && tab === 'canvas' && (manifest.components.length ? <>
        <Canvas state={state} send={(type, payload) => ['propose', 'layout'].includes(type) ? effect(type, payload) : send(type, payload)} editable={editable} viewport={viewport} onViewport={setViewport} />
        <div className="wiring-canvas-fallback empty"><p>The canvas needs a wider editor. Inspect or edit endpoints in the connection table.</p><button onClick={() => { setTab('connections'); connectionTab.current?.focus(); }}>Open connection table</button></div>
      </> : <p className="empty">Add intended components to populate the wiring canvas.</p>)}
      {state.selection && !selected && !selectedNet && <p className="notice">The selected object is unavailable at this revision. No similarly named object was substituted.</p>}
      {(selected || selectedNet) && <section className="wiring-inspector" aria-label="Selected object"><div className="row"><h2>{selected?.label || selectedNet?.label || 'Selected net'}</h2><div className="actions"><button onClick={() => send('ask')}>Ask about selection</button><button disabled={!editable} onClick={() => effect('observe')}>Record observation…</button></div></div><p className="mono break meta">{selected?.componentId || selectedNet?.netId}</p>
        {selected && tab === 'components' && !visibleComponents.includes(selected) && <p className="meta">The selected component is hidden by the current filter.</p>}
        {selected && <><div className="form-grid"><label>Component name<input value={draft.rename} maxLength={256} onChange={event => field('rename', event.target.value)} /></label><div className="actions"><button disabled={!editable || !draft.rename.trim()} onClick={() => propose([{ type: 'component.rename', componentId: selected.componentId, label: draft.rename.trim() }])}>Preview rename</button><button disabled={!editable} onClick={() => propose([{ type: 'component.remove', componentId: selected.componentId, removeBindings: true }])}>Preview component removal</button></div></div>
          <details><summary>Reference definition and pin migration</summary><label>New reference definition<select aria-label="New reference definition" value={draft.resolveDefinition} onChange={event => field('resolveDefinition', event.target.value)}><option value="">Unresolved identity</option>{state.catalog.map(item => <option key={`${item.definitionId}@${item.definitionVersion}`} value={`${item.definitionId}@${item.definitionVersion}`}>{item.label} · {item.definitionVersion}</option>)}</select></label>{draft.resolveDefinition && <p className="meta">Reference details: {state.catalog.find(item => `${item.definitionId}@${item.definitionVersion}` === draft.resolveDefinition)?.detail}</p>}<label>Explicit pin migration<input value={draft.pinMapping} maxLength={8192} placeholder="oldPin=newPin, anotherOld=anotherNew" onChange={event => field('pinMapping', event.target.value)} /></label><p className="meta">A new reference version is reviewed as a migration. Unmapped connections remain unresolved; no wire is rerouted silently.</p><button disabled={!editable} onClick={resolveDefinition}>Preview definition migration</button></details>
          <details><summary>Logical pins and selected modes</summary>{(state.pins[selected.componentId] ?? []).map(pin => <div className="pin-detail" key={pin.pinId}><div><strong>{pin.label}</strong><p className="meta">{pin.electricalType}; aliases {pin.aliases.join(', ') || 'none'}</p></div><label>Mode for {pin.label}<select aria-label={`Mode for ${pin.label}`} disabled={!editable || !pin.modes.length} value={typeof (selected.properties?.pinModes as Record<string, unknown> | undefined)?.[pin.pinId] === 'string' ? String((selected.properties!.pinModes as Record<string, unknown>)[pin.pinId]) : ''} onChange={event => event.target.value && propose([{ type: 'pin.mode', componentId: selected.componentId, pinId: pin.pinId, mode: event.target.value }])}><option value="">Unspecified</option>{pin.modes.map(mode => <option key={mode} value={mode}>{mode}</option>)}</select></label></div>)}</details>
          <details><summary>Keyboard layout position</summary><div className="form-grid"><label>Layout X<input type="number" value={draft.x} onChange={event => field('x', event.target.value)} /></label><label>Layout Y<input type="number" value={draft.y} onChange={event => field('y', event.target.value)} /></label></div><button disabled={!editable || !Number.isFinite(Number(draft.x)) || !Number.isFinite(Number(draft.y))} onClick={() => effect('layout', { positions: { ...state.layout.positions, [selected.componentId]: { x: Number(draft.x), y: Number(draft.y) } } })}>Save layout only</button></details>
          <details><summary>Explicit source bindings</summary>{manifest?.codeBindings.filter(binding => binding.componentId === selected.componentId).map(binding => <div className="row binding" key={binding.bindingId}><button className="link-button grow" onClick={() => send('openCode', { bindingId: binding.bindingId })}>{binding.path}{binding.line ? `:${binding.line}` : ''} · {binding.symbol || 'Unresolved symbol'}{binding.pinId ? ` · ${binding.pinId}` : ''}</button><button disabled={!editable} onClick={() => propose([{ type: 'binding.remove', bindingId: binding.bindingId }])}>Preview unlink</button></div>)}<p className="meta">Bindings are explicit references. Computed pin expressions are not inferred as verified equivalence.</p><div className="form-grid"><label>Source path<input value={draft.bindingPath} maxLength={4096} onChange={event => field('bindingPath', event.target.value)} placeholder="DistanceProbe.ino" /></label><label>Binding pin<select aria-label="Binding pin" value={draft.bindingPin} onChange={event => field('bindingPin', event.target.value)}><option value="">Component-level binding</option>{pinOptions(selected.componentId)}</select></label><label>Symbol or expression<input value={draft.symbol} maxLength={512} onChange={event => field('symbol', event.target.value)} /></label><label>Source line<input type="number" min="1" value={draft.line} onChange={event => field('line', event.target.value)} /></label></div><button disabled={!editable || !safePath(draft.bindingPath) || !!draft.line && (!Number.isSafeInteger(Number(draft.line)) || Number(draft.line) < 1)} onClick={() => propose([{ type: 'binding.set', binding: { bindingId: crypto.randomUUID(), componentId: selected.componentId, path: draft.bindingPath, ...(draft.bindingPin ? { pinId: draft.bindingPin } : {}), ...(draft.symbol.trim() ? { symbol: draft.symbol.trim() } : {}), ...(draft.line ? { line: Number(draft.line) } : {}) } }])}>Preview source binding</button></details>
          {!!manifest?.documents.filter(document => document.componentIds?.includes(selected.componentId)).length && <details><summary>Linked documents</summary>{manifest.documents.filter(document => document.componentIds?.includes(selected.componentId)).map(document => <button className="link-button" key={document.documentId} onClick={() => send('openDocument', { documentId: document.documentId })}>{document.title || document.path}</button>)}</details>}
        </>}
        {selectedNet && <p>{selectedNet.members.map(member => `${componentLabel(member.componentId)} · ${member.pinId}`).join(' ↔ ')}</p>}
      </section>}
      {!!state.confirmations.length && <details className="wiring-records"><summary>Physical observation history ({state.confirmations.length})</summary>{state.confirmations.map(item => <article key={item.observationId}><strong>{item.basis === 'reported' ? 'User reported' : 'Measured'} · {item.result} · {item.applicability}</strong><p>{item.procedure}</p><p>{item.note}</p><p className="meta">Revision {item.projectRevision} · {item.observedAt}</p></article>)}</details>}
      {!!state.rules.length && <details className="wiring-records"><summary>Design rule details ({state.rules.length})</summary>{state.rules.map((rule, index) => <article key={`${rule.ruleId}:${index}`}><strong className={rule.outcome === 'fail' ? 'error-text' : ''}>{rule.outcome} · {rule.ruleId}</strong><p>{rule.explanation}</p><p className="meta">Rule {rule.ruleVersion} · revision {rule.projectRevision}</p></article>)}</details>}
    </main><footer className="wiring-footer meta">Intended design, uploaded firmware and measured behavior are separate claims. Unknown facts stay unknown.</footer>
  </div>;
}
class RenderBoundary extends Component<{ children: ReactNode; refresh: () => void }, { failed: boolean }> { state = { failed: false }; static getDerivedStateFromError() { return { failed: true }; } render() { return this.state.failed ? <div className="error" role="alert"><h1>Wiring view could not render</h1><p>Source files and recorded observations remain unchanged. Open the connection table after refreshing.</p><button onClick={() => { this.setState({ failed: false }); this.props.refresh(); }}>Reload view</button></div> : this.props.children; } }
interface Api { postMessage(request: WiringViewRequest): void; getState(): unknown; setState(value: unknown): void }
declare const acquireVsCodeApi: (() => Api) | undefined;
export function savedWiringUi(value: unknown): Partial<WiringUiState> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const saved = value as Record<string, unknown>;
  if (!['components', 'connections', 'canvas'].includes(String(saved.tab)) || typeof saved.addOpen !== 'boolean' || typeof saved.connectOpen !== 'boolean' || !saved.draft || typeof saved.draft !== 'object' || Array.isArray(saved.draft)) return undefined;
  if (Object.entries(saved.draft).some(([key, entry]) => !Object.hasOwn(initialDraft, key) || typeof entry !== 'string' || entry.length > 8192)) return undefined;
  if (saved.viewport !== undefined && (!saved.viewport || typeof saved.viewport !== 'object' || !['x', 'y', 'zoom'].every(key => Object.hasOwn(saved.viewport!, key)) || Object.keys(saved.viewport).length !== 3 || !Object.entries(saved.viewport).every(([key, number]) => ['x', 'y', 'zoom'].includes(key) && typeof number === 'number' && Number.isFinite(number)) || !('zoom' in saved.viewport) || Number(saved.viewport.zoom) < 0.2 || Number(saved.viewport.zoom) > 2)) return undefined;
  return saved as unknown as Partial<WiringUiState>;
}
function BrowserApp({ api }: { api: Api }) {
  const [state, setState] = useState(emptyWiringState); const saved = useRef(api.getState());
  const send: SendWiringIntent = (type, payload = {}) => api.postMessage({ schemaVersion: 1, requestId: crypto.randomUUID(), projectId: state.project?.projectId ?? null, type, payload });
  useEffect(() => { const receive = (event: MessageEvent<unknown>) => { if (isWiringViewResponse(event.data)) setState(event.data.state); }; window.addEventListener('message', receive); api.postMessage({ schemaVersion: 1, requestId: crypto.randomUUID(), projectId: null, type: 'ready', payload: {} }); return () => window.removeEventListener('message', receive); }, [api]);
  const ui = savedWiringUi(saved.current);
  return <RenderBoundary refresh={() => send('refresh')}><WiringApp state={state} send={send} saved={ui} onSave={value => api.setState(value)} /></RenderBoundary>;
}
if (typeof document !== 'undefined' && typeof acquireVsCodeApi === 'function') { const root = document.getElementById('root'); if (root) createRoot(root).render(<BrowserApp api={acquireVsCodeApi()} />); }
