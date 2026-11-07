import type { AgentRecord } from '@robotics-workbench/agents';
import type { ContextViewItem } from '@robotics-workbench/contracts';

/** Only supplied packet rows and attributable retrieval references receive those facets. */
export function buildContextView(record: Pick<AgentRecord, 'packet' | 'events'> | null, currentRevision: number, pinnedIds: ReadonlySet<string>, available: readonly ContextViewItem[] = []): ContextViewItem[] {
  const rows = new Map<string, ContextViewItem>();
  for (const item of available.slice(0, 100)) rows.set(item.id, { ...structuredClone(item), facets: ['available'], reason: item.reason || 'Available to authorized retrieval; not supplied automatically.' });
  const retrieved = new Set(record?.events.flatMap(event => event.type === 'agent.tool.finished' && event.payload.outcome === 'succeeded' ? event.payload.artifactRefs : []) ?? []);
  for (const evidence of record?.packet.evidenceRefs ?? []) {
    const facets: ContextViewItem['facets'] = ['supplied-this-turn'];
    if (retrieved.has(evidence.evidenceId) || evidence.artifactId && retrieved.has(evidence.artifactId)) facets.push('observed-retrieved');
    if (evidence.projectRevision !== currentRevision || ['historical', 'stale', 'conflicting', 'unknown'].includes(evidence.applicability)) facets.push('stale');
    const location = evidence.location.kind === 'whole' ? 'Whole source' : `${evidence.location.kind} ${evidence.location.start}–${evidence.location.end}${evidence.location.timeBasis ? ` ms (${evidence.location.timeBasis})` : ''}`;
    rows.set(evidence.evidenceId, { id: evidence.evidenceId, title: evidence.sourceUri.split(/[\\/]/).at(-1) || evidence.evidenceId, sourceUri: evidence.sourceUri, revision: evidence.projectRevision, location, facets,
      summary: evidence.summary, reason: facets.includes('stale') ? 'Supplied in this historical packet; applicability requires refresh.' : facets.includes('observed-retrieved') ? 'An observed tool result referenced this evidence; model attention and artifact-byte retrieval are not established.' : 'Included in the exact application-owned context packet.', sha256: evidence.sha256 });
  }
  for (const omitted of record?.packet.omitted ?? []) {
    const existing = rows.get(omitted.ref);
    if (existing) { existing.reason = `Excluded: ${omitted.reason}. ${existing.reason}`; continue; }
    rows.set(omitted.ref, { id: omitted.ref, title: omitted.ref, sourceUri: '', revision: record!.packet.projectRevision, location: 'Excerpt not supplied', facets: omitted.reason === 'stale' ? ['stale'] : ['available'], summary: '', reason: `Excluded: ${omitted.reason}${omitted.expansionHandle ? '; a bounded expansion handle is retained in the packet.' : '; no source expansion was supplied.'}`, sha256: null });
  }
  for (const row of rows.values()) {
    if (retrieved.has(row.id) && !row.facets.includes('observed-retrieved')) { row.facets.push('observed-retrieved'); row.reason = 'An observed tool result referenced this evidence; model attention and artifact-byte retrieval are not established.'; }
    if (pinnedIds.has(row.id)) row.facets.push('pinned');
    if (row.revision !== currentRevision && !row.facets.includes('stale')) row.facets.push('stale');
  }
  return [...rows.values()].slice(0, 200);
}
