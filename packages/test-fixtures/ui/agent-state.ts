import type { WorkbenchViewState } from '@robotics-workbench/contracts';

/** Synthetic display evidence only; no board or provider was exercised. */
export function agentViewFixture(): WorkbenchViewState {
  const projectId = '11111111-1111-4111-8111-111111111111', taskId = '22222222-2222-4222-8222-222222222222';
  return { schemaVersion: 1, project: { projectId, projectRevision: 4, name: 'Distance sensor fixture' }, loading: false, trusted: true, error: null,
    providers: [
      { providerId: 'codex', readiness: 'ready', capabilities: ['resume', 'interrupt', 'mcp', 'approvals'], detail: 'Synthetic Codex readiness; model/account are checked when a task opens.' },
      { providerId: 'opencode', readiness: 'ready', capabilities: ['resume', 'interrupt', 'mcp', 'approvals'], detail: 'Synthetic OpenCode readiness; existing provider-managed route.' }
    ],
    tasks: [{ taskId, providerId: 'codex', status: 'succeeded', summary: 'Explain missing range readings' }],
    task: { taskId, providerId: 'codex', modelId: 'fixture-model', status: 'succeeded', providerOutcome: 'succeeded', contextPacketId: '33333333-3333-4333-8333-333333333333', sourceSnapshotId: '44444444-4444-4444-8444-444444444444',
      messages: [
        { messageId: 'fixture-user', role: 'user', text: 'Explain why the front sensor has no readings.', artifactRef: null, complete: true },
        { messageId: 'fixture-assistant', role: 'assistant', text: 'The intended trigger pin is D8. The last recording belongs to older firmware. Actual wiring is unconfirmed; no voltage measurement was supplied. Review the source change before compiling.', artifactRef: null, complete: true }
      ], pendingApprovals: [], activities: [{ id: 'fixture-activity', title: 'project.snapshot · observed', summary: 'Revision 4; selected component and source references retained.' }], problem: null },
    context: [
      { id: '99999999-9999-4999-8999-999999999999', title: 'Front range sensor', sourceUri: 'file:///C:/synthetic/workbench.json', revision: 4, location: 'Component: front range sensor', facets: ['pinned', 'supplied-this-turn'], summary: 'Planned TRIG D8; ECHO D9. Physical continuity is unknown.', reason: 'Selected component and explicit code binding.', sha256: 'a'.repeat(64) },
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'Earlier raw recording', sourceUri: 'artifact://55555555-5555-4555-8555-555555555555', revision: 3, location: 'Host receive time 0–1000 ms', facets: ['observed-retrieved', 'stale'], summary: 'Historical bytes; previous firmware identity.', reason: 'Firmware/design applicability differs from the current snapshot.', sha256: 'b'.repeat(64) },
      { id: 'fixture-document', title: 'Attached datasheet', sourceUri: 'file:///C:/synthetic/datasheet.pdf', revision: 4, location: 'Page 2', facets: ['available'], summary: 'Available for explicit retrieval; not claimed as read by the provider.', reason: 'Linked reference; excluded from this turn by the context budget.', sha256: 'c'.repeat(64) }
    ],
    changes: [
      { id: 'fixture-written', path: 'DistanceProbe.ino', effect: 'written', baselineSha256: 'd'.repeat(64), currentSha256: 'e'.repeat(64), summary: 'Provider wrote a startup timeout change; review the native diff.' },
      { id: 'fixture-proposed', path: 'workbench.json', effect: 'proposed', baselineSha256: 'f'.repeat(64), currentSha256: 'f'.repeat(64), summary: 'Proposed intended pin update; no physical rewiring occurred.' }
    ],
    operations: [{ operationId: '66666666-6666-4666-8666-666666666666', kind: 'compile', status: 'failed' }]
  };
}
