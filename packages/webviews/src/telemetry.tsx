import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import uPlot from 'uplot';
import { isRecordingSelection, type RecordingSelection, type TelemetryWindow } from '@robotics-workbench/contracts/telemetry';
import { freezeTelemetrySelection, isTelemetryViewResponse, type TelemetryViewAction, type TelemetryViewRequest, type TelemetryViewState } from './telemetry-protocol';
import 'uplot/dist/uPlot.min.css';
import './workbench.css';
import './telemetry.css';

export const emptyTelemetryState: TelemetryViewState = { schemaVersion: 1, trusted: false, loading: false, error: null, stale: false, project: null, recordings: [], profiles: [], selectedRecordingId: null, selectedProfileId: null, window: null, revealedSelection: null, live: null, procedures: [], runs: [], comparison: null };
export type SendTelemetryIntent = (type: TelemetryViewAction, payload?: Record<string, unknown>) => void;
interface TelemetryUi { projectId: string | null; frozen: RecordingSelection | null; styleKeys: string[] }
export function savedTelemetryUi(v: unknown): TelemetryUi | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const s = v as Record<string, unknown>;
  return Object.keys(s).length === 3 && (s.projectId === null || typeof s.projectId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(s.projectId)) && (s.frozen === null || isRecordingSelection(s.frozen)) && Array.isArray(s.styleKeys) && s.styleKeys.length <= 512 && s.styleKeys.every(k => typeof k === 'string' && k.length <= 512) ? s as unknown as TelemetryUi : undefined;
}
const palette = ['#0072B2', '#E69F00', '#009E73', '#CC79A7', '#56B4E9', '#D55E00'];
const dashes = [[], [8, 4], [2, 3], [8, 3, 2, 3], [12, 4], [3, 3, 8, 3]];
const pattern = ['solid', 'dashed', 'dotted', 'dash-dot', 'long-dash', 'dot-dash'];
export function contrastSeriesColor(index: number, background: string): string {
  const values = background.match(/[\d.]+/g)?.map(Number) ?? [30, 30, 30];
  const luminance = (rgb: number[]) => rgb.slice(0, 3).map(x => { const s = x / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; }).reduce((sum, x, i) => sum + x * [.2126, .7152, .0722][i], 0);
  const bg = luminance(values), base = palette[index % 6], rgb = [1, 3, 5].map(i => parseInt(base.slice(i, i + 2), 16));
  for (let n = 0; n <= 20; n++) {
    const amount = n / 20, target = bg < .5 ? 255 : 0, adjusted = rgb.map(c => Math.round(c * (1 - amount) + target * amount)), lum = luminance(adjusted);
    if ((Math.max(bg, lum) + .05) / (Math.min(bg, lum) + .05) >= 3) return `rgb(${adjusted.join(',')})`;
  }
  return bg < .5 ? 'white' : 'black';
}
type PlotSeries = { seriesKey: string; label: string; unit: string | null; window: TelemetryWindow; channelId: string; styleIndex: number };
export function alignedTelemetryData(series: PlotSeries[]): uPlot.AlignedData {
  const tables: uPlot.AlignedData[] = series.map(s => {
    const points = s.window.samples.filter(p => p.channelId === s.channelId && (s.window.timeBasis !== 'device' || p.deviceEpoch === s.window.deviceEpoch)).map(p => ({ x: s.window.timeBasis === 'device' ? p.deviceTimeMs : p.hostReceiveMs, y: p.value, host: p.hostReceiveMs })).filter(p => p.x !== null).sort((a, b) => a.x! - b.x!);
    const xs: number[] = [], ys: (number | null)[] = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i], previous = points[i - 1];
      if (previous && p.x! > previous.x! && (s.window.gaps.some(g => g.startHostReceiveMs >= previous.host && g.startHostReceiveMs <= p.host) || s.window.issues.some(issue => ['clock-reset', 'host-clock-reset', 'sequence-gap'].includes(issue.code) && issue.hostReceiveMs >= previous.host && issue.hostReceiveMs <= p.host))) { xs.push((previous.x! + p.x!) / 2); ys.push(null); }
      if (xs.at(-1) === p.x) { ys[ys.length - 1] = p.y; } else { xs.push(p.x!); ys.push(p.y); }
    }
    return [xs, ys];
  });
  return tables.length ? uPlot.join(tables) : [[], []];
}
function TelemetryPlot({ series, onInterval, visible }: { series: PlotSeries[]; onInterval?: (start: number, end: number) => void; visible: boolean }) {
  const element = useRef<HTMLDivElement>(null);
  const callback = useRef(onInterval); callback.current = onInterval;
  const [failure, setFailure] = useState(false);
  useEffect(() => {
    if (!visible || !element.current || !series.length) return;
    const host = element.current;
    let plot: uPlot | undefined;
    const draw = () => {
      plot?.destroy(); plot = undefined;
      try {
        const css = getComputedStyle(host), stroke = css.color, background = getComputedStyle(document.body).backgroundColor;
        const scales: uPlot.Options['scales'] = { x: { time: false } }, axes: uPlot.Axis[] = [{ stroke, label: `${series[0].window.timeBasis} elapsed (ms)`, grid: { stroke, width: .2 }, font: `${css.fontSize} ${css.fontFamily}` }];
        for (const unit of new Set(series.map(s => s.unit ?? 'unknown'))) { scales[`unit:${unit}`] = { auto: true }; axes.push({ scale: `unit:${unit}`, stroke, label: unit === 'unknown' ? 'Unit unknown' : unit, side: axes.length % 2 ? 3 : 1, grid: { show: false }, font: `${css.fontSize} ${css.fontFamily}` }); }
        plot = new uPlot({ width: Math.max(240, host.clientWidth), height: 260, scales, axes, legend: { show: false }, cursor: { drag: { x: true, y: false, setScale: false } }, series: [{}, ...series.map(s => ({ label: s.label, scale: `unit:${s.unit ?? 'unknown'}`, stroke: contrastSeriesColor(s.styleIndex, background), dash: dashes[s.styleIndex % 6], width: 2, spanGaps: false, points: { show: true, size: 4 } }))], hooks: { setSelect: [u => { if (u.select.width > 0) callback.current?.(Math.max(0, u.posToVal(u.select.left, 'x')), Math.max(0, u.posToVal(u.select.left + u.select.width, 'x'))); }] } }, alignedTelemetryData(series), host);
        setFailure(false);
      } catch { setFailure(true); }
    };
    draw();
    const resize = new ResizeObserver(() => plot?.setSize({ width: Math.max(240, host.clientWidth), height: 260 })); resize.observe(host);
    const theme = new MutationObserver(draw); theme.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-vscode-theme-kind'] }); theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    return () => { resize.disconnect(); theme.disconnect(); plot?.destroy(); };
  }, [series, visible]);
  return <><div ref={element} className="telemetry-plot" role="img" aria-label={`Telemetry chart: ${series.map(s => `${s.label}, ${s.channelId}, ${s.unit ?? 'unit unknown'}, ${pattern[s.styleIndex % 6]}`).join('; ')}. Exact displayed samples${onInterval ? ' and keyboard interval fields' : ''} follow.`} />{failure && <p role="alert">Plot unavailable. Use the exact sample table below.</p>}</>;
}
function SampleTable({ window: w }: { window: TelemetryWindow }) {
  const [page, setPage] = useState(0), current = Math.min(page, Math.max(0, Math.ceil(w.samples.length / 200) - 1));
  return <details className="telemetry-table"><summary>Exact displayed samples ({w.samples.length} of {w.totalSamples})</summary><p className="meta">Every listed value is a retained parsed sample. {w.downsampled ? 'This bounded table omits other samples; export the interval to inspect all underlying data.' : 'No display samples omitted.'} Host receive time is not sensor acquisition time.</p><div role="region" aria-label="Exact sample values" tabIndex={0} className="telemetry-scroll"><table><thead><tr><th>Channel</th><th>Value</th><th>Unit</th><th>Host ms</th><th>Device ms / epoch</th></tr></thead><tbody>{w.samples.slice(current * 200, (current + 1) * 200).map((s, i) => <tr key={i}><th scope="row">{s.channelId}</th><td>{s.value}</td><td>{s.unit ?? 'Unknown'}</td><td>{s.hostReceiveMs}</td><td>{s.deviceTimeMs === null ? 'Unavailable' : `${s.deviceTimeMs} / ${s.deviceEpoch}`}</td></tr>)}</tbody></table></div>{w.samples.length > 200 && <div className="actions"><button disabled={current === 0} onClick={() => setPage(current - 1)}>Previous sample page</button><span>Rows {current * 200 + 1}–{Math.min(w.samples.length, (current + 1) * 200)} of {w.samples.length} displayed samples</span><button disabled={(current + 1) * 200 >= w.samples.length} onClick={() => setPage(current + 1)}>Next sample page</button></div>}</details>;
}
export function TelemetryApp({ state, send, saved, onSave }: { state: TelemetryViewState; send: SendTelemetryIntent; saved?: TelemetryUi; onSave?: (ui: TelemetryUi) => void }) {
  const [tab, setTab] = useState<'detail' | 'comparison'>('detail'), [filter, setFilter] = useState(''), [runIds, setRunIds] = useState<string[]>([]);
  const [isolatedSeriesKey, setIsolatedSeriesKey] = useState('');
  const [frozen, setFrozen] = useState<RecordingSelection | null>(saved?.frozen ?? null), frozenProject = useRef(saved?.projectId ?? null);
  const styles = useRef(saved?.styleKeys ?? []);
  const [start, setStart] = useState('0'), [end, setEnd] = useState('1000'), [basis, setBasis] = useState<'host-receive' | 'device'>('host-receive'), [epoch, setEpoch] = useState('0'), [channels, setChannels] = useState<string[]>([]);
  const [paused, setPaused] = useState(false), pausedWindow = useRef<TelemetryWindow | null>(null), pausedRaw = useRef<TelemetryViewState['live']>(null), pausedWasActive = useRef(false);
  const [visible, setVisible] = useState(typeof document === 'undefined' || !document.hidden), [pending, setPending] = useState(false), lock = useRef(false);
  const [procedureId, setProcedureId] = useState('');
  const recordingHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { setPending(false); lock.current = false; }, [state]);
  useEffect(() => { const change = () => setVisible(!document.hidden); document.addEventListener('visibilitychange', change); return () => document.removeEventListener('visibilitychange', change); }, []);
  useEffect(() => { setStart(String(state.window?.start ?? 0)); setEnd(String(state.window?.end ?? 1000)); setBasis(state.window?.timeBasis ?? 'host-receive'); setEpoch(String(state.window?.deviceEpoch ?? 0)); setChannels(state.profiles.find(p => p.id === state.selectedProfileId)?.channels.map(c => c.channelId) ?? []); setPaused(false); }, [state.selectedRecordingId, state.selectedProfileId]);
  useEffect(() => {
    if (!state.revealedSelection) return;
    const selection = structuredClone(state.revealedSelection); frozenProject.current = state.project?.projectId ?? null;
    setFrozen(selection); setStart(String(selection.start)); setEnd(String(selection.end)); setBasis(selection.timeBasis); setEpoch(String(selection.deviceEpoch ?? 0)); setChannels([...selection.channelIds]); setPaused(false);
  }, [JSON.stringify(state.revealedSelection)]);
  useEffect(() => { onSave?.({ projectId: frozenProject.current, frozen, styleKeys: [...styles.current] }); }, [frozen, state.comparison, isolatedSeriesKey, onSave]);
  const act = (type: TelemetryViewAction, payload: Record<string, unknown> = {}) => { if (lock.current || state.loading) return; lock.current = true; setPending(true); send(type, payload); };
  const disabled = state.loading || pending || !state.project;
  const recording = state.recordings.find(r => r.recordingId === state.selectedRecordingId), profile = state.profiles.find(p => p.id === state.selectedProfileId);
  const live = state.live?.recordingId === recording?.recordingId ? state.live : null;
  const w = paused ? pausedWindow.current : state.window, raw = paused ? pausedRaw.current : live;
  const captureStatus = state.stale ? `${paused ? 'Display paused. ' : ''}Capture status may be out of date.`
    : recording?.completion === 'active' ? paused ? 'Display paused; capture continues independently.' : 'Capture and display are independent. Stopping capture does not stop hardware motion.'
    : recording?.completion === 'unavailable' ? 'Retained metadata is available for inspection.'
    : paused ? 'Display paused; capture finalized. Resume display to inspect retained derivation.' : 'Recorded evidence; replay performs zero serial writes.';
  const style = (key: string) => { let index = styles.current.indexOf(key); if (index < 0) { styles.current.push(key); index = styles.current.length - 1; } return index; };
  const series: PlotSeries[] = w ? channels.slice(0, 6).map(channelId => ({ seriesKey: `${w.recordingId}:${channelId}`, channelId, label: profile?.channels.find(c => c.channelId === channelId)?.label ?? channelId, unit: profile?.channels.find(c => c.channelId === channelId)?.unit ?? null, window: w, styleIndex: style(`${w.recordingId}:${channelId}`) })) : [];
  const validRange = !!start.trim() && !!end.trim() && Number.isFinite(Number(start)) && Number.isFinite(Number(end)) && Number(start) >= 0 && Number(end) >= Number(start) && (basis !== 'device' || !!epoch.trim() && Number.isSafeInteger(Number(epoch)) && Number(epoch) >= 0);
  const candidate = !(paused && pausedWasActive.current) && validRange && basis === w?.timeBasis && (basis !== 'device' || Number(epoch) === w.deviceEpoch) ? freezeTelemetrySelection({ ...state, window: w }, Number(start), Number(end), channels) : null;
  const frozenAvailable = frozen && frozenProject.current === state.project?.projectId && state.recordings.some(r => r.recordingId === frozen.recordingId);
  const query = () => { if (validRange && channels.length && recording && profile) act('query', { recordingId: recording.recordingId, profileId: profile.id, channelIds: channels, timeBasis: basis, start: Number(start), end: Number(end), ...(basis === 'device' ? { deviceEpoch: Number(epoch) } : {}) }); };
  const comp = state.comparison;
  const runLabel = (experimentId: string) => {
    const run = state.runs.find(r => r.experimentId === experimentId);
    if (!run) return undefined;
    const sameTitle = state.runs.filter(r => r.title === run.title && r.experimentId !== experimentId);
    if (!sameTitle.length) return run.title;
    const shortId = experimentId.slice(-8);
    return `${run.title} · ${sameTitle.some(r => r.experimentId.endsWith(shortId)) ? experimentId : shortId}`;
  };
  const comparedRuns = comp?.series.map(s => ({ ...s, label: runLabel(s.seriesKey.split(':')[0]) ?? s.label })) ?? [];
  const comparisonChannels = comparedRuns.flatMap(s => s.window.channelIds.map(channelId => ({
    ...s, seriesKey: `${s.seriesKey}:${channelId}`, channelId,
    unit: s.window.statistics.find(statistic => statistic.channelId === channelId)?.unit ?? null,
  })));
  const isolatedSeries = comparisonChannels.find(s => s.seriesKey === isolatedSeriesKey);
  const canOverlay = comp?.series.every(s => s.window.timeBasis === 'host-receive') ?? false;
  const comparisonSeries = (isolatedSeries ? [isolatedSeries] : canOverlay ? comparisonChannels.slice(0, 6) : [])
    .map(s => ({ ...s, styleIndex: style(s.seriesKey) }));
  return <div className="telemetry-app">
    <header className="telemetry-toolbar"><div className="row"><div><h1>Telemetry & experiments</h1><p className="meta">{state.project ? `${state.project.name} · current revision ${state.project.projectRevision}` : 'Open a workbench project to inspect retained recordings.'}</p></div><button disabled={state.loading || pending} onClick={() => act('refresh')}>Refresh evidence</button></div><p className="meta" role="status" aria-live="polite">{state.loading || pending ? 'Refreshing evidence…' : state.stale ? 'Stale snapshot — refresh to reconcile current evidence.' : 'Historical evidence is available without a connected board.'}</p></header>
    {!state.trusted && <p className="notice">Restricted Mode: execution and capture controls are unavailable. Retained evidence stays readable.</p>}
    {state.error && <div className="error" role="alert">{state.error}<p>Retained evidence is unchanged. Refresh evidence repeats a read.</p></div>}
    <nav className="tabs" aria-label="Telemetry surfaces"><button aria-current={tab === 'detail' ? 'page' : undefined} onClick={() => setTab('detail')}>Recording detail</button><button aria-current={tab === 'comparison' ? 'page' : undefined} onClick={() => setTab('comparison')}>Runs & comparison</button></nav>
    {tab === 'detail' ? <main className="telemetry-detail">
      <div className="actions"><button disabled={disabled || !state.trusted} onClick={() => act('editProfiles')}>Edit parser profiles</button>{state.revealedSelection && <button disabled={disabled || !recording || !profile} onClick={() => act('selectProfile', { recordingId: recording!.recordingId, profileId: profile!.id })}>Use current parser source</button>}</div><section className="telemetry-fields" aria-label="Recording and parser"><label>Recording<select value={state.selectedRecordingId ?? ''} disabled={disabled} onChange={e => act('selectRecording', { recordingId: e.target.value })}><option value="" disabled>Choose retained recording</option>{state.recordings.map(r => <option key={r.recordingId} value={r.recordingId}>{r.startedAt} · {r.completion} · {r.recordingId.slice(0, 8)}</option>)}</select></label><label>Explicit parser profile<select value={state.selectedProfileId ?? ''} disabled={disabled || !recording} onChange={e => act('selectProfile', { recordingId: recording!.recordingId, profileId: e.target.value })}><option value="" disabled>Select profile; never auto-detected</option>{state.profiles.map(p => <option key={p.id} value={p.id}>{p.mode} · {p.id.slice(0, 8)}</option>)}</select></label></section>
      {!state.recordings.length && <section className="empty"><h2>No retained recordings</h2><p>Use Robotics: Record Raw Serial to capture bytes. This view displays retained recordings.</p></section>}
      {recording && <section className="telemetry-panel" aria-label="Recording provenance">
        <div className="row">
          <h2 ref={recordingHeading} tabIndex={-1}>{recording.completion === 'active' ? '● Live display — provisional' : recording.completion === 'unavailable' ? '◇ Recording evidence unavailable' : '▣ Replay — read-only'} · {recording.completion}</h2>
          {(live?.captureActive || paused) && <div className="actions">
            <button onClick={() => {
              if (!paused) {
                pausedWasActive.current = recording.completion === 'active';
                pausedWindow.current = structuredClone(state.window);
                pausedRaw.current = structuredClone(live);
              } else if (!live?.captureActive) recordingHeading.current?.focus();
              setPaused(!paused);
            }}>{paused ? 'Resume display' : 'Pause display'}</button>
            <button disabled={disabled || !state.trusted || !live?.captureActive} onClick={() => act('stopCapture', { recordingId: recording.recordingId })}>Stop capture</button>
          </div>}
        </div>
        <p className="meta" role="status">{captureStatus}</p>
        <p className="meta">Recording <code>{recording.recordingId}</code> · revision {recording.projectRevision} · {recording.startedAt}</p>
        <p>Device: {recording.device} · Uploaded artifact: {recording.artifactSha256 ? <code>{recording.artifactSha256}</code> : 'Unknown association'}</p>
        {recording.limitations.map((l, i) => <p className="notice" key={i}>{l}</p>)}
        {profile && <details><summary>Parser configuration and channel meanings</summary><p>{profile.mode} · {profile.parserVersion}</p><code>{profile.configurationSha256}</code><ul>{profile.channels.map(c => <li key={c.channelId}>{c.label} ({c.channelId}) · {c.unit ?? 'unit unknown'} · source {c.source}</li>)}</ul></details>}
        {raw && raw.recordingId === recording.recordingId && <details open>
          <summary>Bounded raw text preview</summary>
          <pre className="mono telemetry-scroll" tabIndex={0} role="region" aria-label="Raw serial text preview">{raw.text || 'No received bytes in this preview.'}</pre>
          <p className="meta">{raw.omittedBytes ?? 'Unknown number of'} raw bytes omitted from preview. Replacement characters are display behavior; raw bytes are retained separately.</p>
        </details>}
      </section>}
      {profile?.mode === 'raw-text' && <p className="notice">Raw-text profile: no numeric samples inferred. Select an explicitly configured numeric profile for plots.</p>}
      {recording && !w && profile?.mode !== 'raw-text' && <p className="notice">Numeric derivation unavailable. Select a declared parser profile. Missing or corrupt evidence cannot become zero-valued samples.</p>}
      {w && <section className="telemetry-panel" aria-label="Channel plot"><h2>Channels · {w.timeBasis} elapsed milliseconds{w.deviceEpoch !== undefined ? ` · device epoch ${w.deviceEpoch}` : ''}</h2><p className="meta">{w.displayResolution} · {w.samples.length} displayed / {w.totalSamples} underlying samples{w.downsampled ? ' · downsampled display' : ''}. Plot merges repeated timestamps to the last value; the table retains each displayed sample. No interpolation is presented as measurement.</p><fieldset className="telemetry-channels"><legend>Visible channels (up to six; isolate to compare)</legend>{profile?.channels.map(c => <label key={c.channelId}><input type="checkbox" checked={channels.includes(c.channelId)} onChange={e => setChannels(e.target.checked ? [...channels, c.channelId] : channels.filter(id => id !== c.channelId))} />{c.label} · {c.unit ?? 'unit unknown'}</label>)}</fieldset>{channels.length > 6 && <p className="notice">Only the first six selected channels are plotted. Isolate channels for readable series; export retains the complete selection.</p>}<ul className="telemetry-legend">{series.map(s => <li key={s.seriesKey}>{s.label} · {s.unit ?? 'unit unknown'} · {pattern[s.styleIndex % 6]}</li>)}</ul><TelemetryPlot series={series} visible={visible && tab === 'detail'} onInterval={(a, b) => { setStart(String(Math.max(w.start, a))); setEnd(String(Math.min(w.end, b))); }} />
        <details open><summary>Gaps and parser issues ({w.gaps.length} / {w.issues.length})</summary>{!w.gaps.length && !w.issues.length && <p className="meta">No retained gap or parser issue in this interval; this is not proof of physical correctness.</p>}<ul>{w.gaps.map((g, i) => <li key={`g${i}`}>{g.cause} · host {g.startHostReceiveMs}–{g.endHostReceiveMs ?? 'open'} ms · lost bytes {g.lostBytes ?? 'unknown'}</li>)}{w.issues.map((issue, i) => <li key={`i${i}`}>{issue.code} · host {issue.hostReceiveMs} ms · {issue.message}</li>)}</ul></details>
        <details><summary>Deterministic interval statistics</summary><ul>{w.statistics.map(s => <li key={s.channelId}>{s.channelId} · {s.unit ?? 'unit unknown'} · count {s.count} · min {s.min ?? 'unavailable'} · max {s.max ?? 'unavailable'} · mean {s.mean ?? 'unavailable'}</li>)}</ul></details><details><summary>Exact derivation / raw identity</summary><p>Derivation <code>{w.derivationId}</code></p><p>Raw SHA-256 <code>{w.rawSha256}</code></p><p>Parser {w.parserVersion} · configuration <code>{w.configurationSha256}</code></p></details><SampleTable window={w} />
      </section>}
      {recording && profile && profile.mode !== 'raw-text' && <section className="telemetry-panel" aria-label="Exact interval selection"><h2>Exact interval</h2><div className="telemetry-fields"><label>Time basis<select value={basis} onChange={e => setBasis(e.target.value as typeof basis)}><option value="host-receive">Host receive elapsed ms</option><option value="device" disabled={!profile.deviceClock}>Device elapsed ms (explicit clock)</option></select></label>{basis === 'device' && <label>Device clock epoch<input type="number" min="0" step="1" value={epoch} onChange={e => setEpoch(e.target.value)} /></label>}<label>Start (ms)<input type="number" min="0" step="any" value={start} onChange={e => setStart(e.target.value)} /></label><label>End (ms)<input type="number" min="0" step="any" value={end} onChange={e => setEnd(e.target.value)} /></label></div><p className="meta">Host receive time and device acquisition time differ. Device epochs are never aligned implicitly.</p>{!validRange && <p className="error-text" role="alert">Enter finite, non-negative boundaries with end at or after start.</p>}<div className="actions"><button disabled={disabled || recording.completion === 'active' || !validRange || !channels.length} onClick={query}>Query interval</button><button disabled={disabled || !candidate} onClick={() => { frozenProject.current = state.project?.projectId ?? null; setFrozen(candidate && structuredClone(candidate)); }}>Freeze interval</button></div>{!candidate && <p className="meta">Freeze requires retained complete/partial evidence, matching clock/epoch, selected channels, and boundaries inside the loaded interval. Finalize active capture and resume display before freezing.</p>}</section>}
      {frozen && <section className="telemetry-panel" aria-label="Frozen interval"><h2>Frozen interval</h2><p className="mono">{frozen.recordingId} · {frozen.start}–{frozen.end} ms · {frozen.timeBasis}{frozen.deviceEpoch !== undefined ? ` / epoch ${frozen.deviceEpoch}` : ''}</p><p className="meta">{frozen.channelIds.join(', ')} · revision {frozen.projectRevision} · parser {frozen.parserVersion}</p><details><summary>Frozen derivation and parser hash</summary><code>{frozen.derivationId}</code><br /><code>{frozen.configurationSha256}</code></details><p className="meta">Later samples, profile changes and current source edits do not move this selection. Ask prepares exact context in the composer; sending remains separate.</p><div className="actions"><button className="primary" disabled={disabled || !state.trusted || !frozenAvailable} onClick={() => act('ask', { selection: structuredClone(frozen) })}>Ask about interval</button><button disabled={disabled || !frozenAvailable} onClick={() => act('exportSelection', { selection: structuredClone(frozen) })}>Export underlying interval</button><button onClick={() => setFrozen(null)}>Clear interval</button></div>{!frozenAvailable && <p className="meta">The frozen recording is unavailable in the current project. Its exact reference is preserved.</p>}</section>}
    </main> : <main className="telemetry-comparison">
      <aside className="telemetry-run-list"><h2>Runs</h2><label>Filter runs<input type="search" value={filter} onChange={e => setFilter(e.target.value)} /></label><p className="meta">Choose 2–6 runs. More series need isolation.</p>{state.runs.filter(r => `${r.title} ${r.lifecycle}`.toLowerCase().includes(filter.toLowerCase())).map(r => <article className="telemetry-run" key={r.experimentId}><label><input type="checkbox" checked={runIds.includes(r.experimentId)} disabled={!runIds.includes(r.experimentId) && runIds.length >= 6} onChange={e => setRunIds(e.target.checked ? [...runIds, r.experimentId] : runIds.filter(id => id !== r.experimentId))} />{runLabel(r.experimentId)}</label><p className="meta">{r.lifecycle} · judgment {r.outcome} · revision {r.projectRevision}</p><p className="meta">Procedure {r.procedureVersion} · {r.recordingIds.length} recordings</p><div className="actions">{r.recordingIds[0] && <button disabled={disabled} onClick={() => { act('selectRecording', { recordingId: r.recordingIds[0] }); setTab('detail'); }}>Inspect recording</button>}<button disabled={disabled} onClick={() => act('exportRun', { experimentId: r.experimentId })}>Export run</button><button disabled={disabled || !state.trusted || !['draft', 'ready'].includes(r.lifecycle)} onClick={() => act('startRun', { experimentId: r.experimentId })}>Start run</button><button disabled={disabled || !state.trusted || r.lifecycle !== 'running'} onClick={() => act('finishRun', { experimentId: r.experimentId, ...(frozenAvailable ? { selection: structuredClone(frozen) } : {}) })}>Finish run</button><button disabled={disabled || !state.trusted} onClick={() => act('appendNote', { experimentId: r.experimentId })}>Append note</button><button disabled={disabled || !state.trusted || !['completed', 'aborted', 'interrupted'].includes(r.lifecycle)} onClick={() => act('judgeRun', { experimentId: r.experimentId })}>Review judgment</button></div>{r.limitations.map((l, i) => <p className="meta" key={i}>{l}</p>)}</article>)}{!state.runs.length && <p className="empty">No experiment runs. Define a procedure before recording a judgment.</p>}<button className="primary" disabled={disabled || runIds.length < 2} onClick={() => act('compare', { experimentIds: runIds })}>Compare selected runs</button></aside>
      <section className="telemetry-run-main"><section className="telemetry-panel"><h2>Procedures & run records</h2><label>Versioned procedure<select value={procedureId} onChange={e => setProcedureId(e.target.value)}><option value="">Choose procedure</option>{state.procedures.map(p => <option key={`${p.procedureId}:${p.version}`} value={p.procedureId}>{p.title} · version {p.version}</option>)}</select></label><div className="actions"><button disabled={disabled || !state.trusted} onClick={() => act('createProcedure')}>Create procedure</button><button disabled={disabled || !procedureId} onClick={() => act('openProcedure', { procedureId })}>Open / edit procedure</button><button disabled={disabled || !state.trusted || !procedureId} onClick={() => act('createRun', { procedureId, ...(frozenAvailable ? { selection: structuredClone(frozen) } : {}) })}>Create run</button></div><p className="meta">Setup, criteria and observations are reviewed in native host prompts/files. A chart or agent assertion cannot create a passing judgment.</p></section>
      {comp ? <section className="telemetry-panel" aria-label="Run comparison">
        <h2>Run comparison</h2>
        <p className="notice">{comp.compatible ? 'Required comparison checks passed. A formal improvement still requires declared metrics and evidence.' : 'Incompatible evidence — formal improvement conclusion blocked.'}</p>
        {comp.warnings.length > 0 && <ul>{comp.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}
        <p className="meta">The exploratory overlay uses recording elapsed time and separate axes for different units. Each isolated series retains its recorded clock.</p>
        {comparisonChannels.length > 0 && <label><span id="comparison-series-label">Plot series</span><select aria-labelledby="comparison-series-label" value={isolatedSeries?.seriesKey ?? ''} onChange={e => setIsolatedSeriesKey(e.target.value)}>
          <option value="">{canOverlay ? 'Exploratory overlay' : 'Choose one series to plot'}</option>
          {comparisonChannels.map(s => <option key={s.seriesKey} value={s.seriesKey}>{s.label} · {s.channelId} · {s.unit ?? 'unit unknown'} · {s.window.timeBasis}{s.window.deviceEpoch !== undefined ? ` / epoch ${s.window.deviceEpoch}` : ''}</option>)}
        </select></label>}
        {!comparisonChannels.length && <p className="meta">No retained parsed series in the selected runs.</p>}
        {comparisonChannels.length > 0 && !canOverlay && <p className="notice">Device-clock series require explicit alignment before overlay. Choose one series or inspect the exact sample tables.</p>}
        {canOverlay && !isolatedSeries && comparisonChannels.length > 6 && <p className="notice">The overlay shows the first six series. Choose any series to inspect it on its own.</p>}
        {comparisonSeries.length > 0 && <>
          <ul className="telemetry-legend">{comparisonSeries.map(s => <li key={s.seriesKey}>{s.label} · {s.channelId} · {s.unit ?? 'unit unknown'} · {s.window.timeBasis} · {pattern[s.styleIndex % 6]}</li>)}</ul>
          <TelemetryPlot series={comparisonSeries} visible={visible && tab === 'comparison'} />
        </>}
        <div className="telemetry-scroll" role="region" aria-label="Run parameter differences" tabIndex={0}><table><thead><tr><th>Identity / parameter</th>{comp.experimentIds.map(id => <th key={id}>{runLabel(id) ?? id}</th>)}</tr></thead><tbody>{comp.differences.map((d, i) => <tr key={i}><th scope="row">{d.field}</th>{d.values.map((value, j) => <td key={j}>{value}</td>)}</tr>)}</tbody></table></div>
        {comparedRuns.map(s => <section key={s.seriesKey}><h3>{s.label}</h3><SampleTable window={s.window} /></section>)}
      </section> : <section className="empty"><h2>Select runs to compare</h2><p>Procedure, parser, channel meaning, units, clock and firmware differences remain visible. Missing samples remain gaps.</p></section>}</section>
    </main>}
  </div>;
}
class RenderBoundary extends Component<{ children: ReactNode; refresh: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div role="alert" className="error"><h1>Telemetry view could not render</h1><p>Raw recordings remain unchanged.</p><button onClick={() => { this.setState({ failed: false }); this.props.refresh(); }}>Reload view</button></div> : this.props.children; }
}
interface Api { postMessage(request: TelemetryViewRequest): void; getState(): unknown; setState(value: unknown): void }
declare const acquireVsCodeApi: (() => Api) | undefined;
function BrowserApp({ api }: { api: Api }) {
  const [state, setState] = useState(emptyTelemetryState), saved = useRef(savedTelemetryUi(api.getState()));
  const send: SendTelemetryIntent = (type, payload = {}) => api.postMessage({ schemaVersion: 1, requestId: crypto.randomUUID(), projectId: state.project?.projectId ?? null, type, payload });
  useEffect(() => { const receive = (event: MessageEvent<unknown>) => { if (isTelemetryViewResponse(event.data)) setState(event.data.state); }; window.addEventListener('message', receive); api.postMessage({ schemaVersion: 1, requestId: crypto.randomUUID(), projectId: null, type: 'ready', payload: {} }); return () => window.removeEventListener('message', receive); }, [api]);
  return <RenderBoundary refresh={() => send('refresh')}><TelemetryApp state={state} send={send} saved={saved.current} onSave={v => api.setState(v)} /></RenderBoundary>;
}
if (typeof document !== 'undefined' && typeof acquireVsCodeApi === 'function') { const root = document.getElementById('root'); if (root) createRoot(root).render(<BrowserApp api={acquireVsCodeApi()} />); }
