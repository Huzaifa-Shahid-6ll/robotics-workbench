// Explicit harmless live-tool check; never invoked by ordinary tests.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OpenCodeAdapter } from '@robotics-workbench/opencode';
import type { AgentEvent, OpenSession, SessionRef, SessionSnapshot } from '@robotics-workbench/contracts';

async function main() {
  assert.ok(process.argv.includes('--live'), 'Explicit --live required.');
  const executable = process.argv[process.argv.indexOf('--executable') + 1];
  assert.ok(process.argv.includes('--executable') && executable);
  const directory = resolve('artifacts/task05-opencode-lifecycle/scratch space');
  await mkdir(directory, { recursive: true });
  const destination = resolve('artifacts/task05-opencode-lifecycle/result.json');
  const result: Record<string, unknown> = { taskId: 'TASK-05', provider: 'opencode', startedAt: new Date().toISOString(), checks: [] };
  let adapter: OpenCodeAdapter | undefined;
  const events: AgentEvent[] = [];
  try {
    adapter = await OpenCodeAdapter.launch({ executable, directory, contextText: async () => '{"projectRevision":1,"unknowns":["No hardware measurements"]}', permissionProfiles: {
      'approval-probe': [{ permission: '*', pattern: '*', action: 'deny' }, { permission: 'bash', pattern: 'echo WORKBENCH_APPROVAL_PROBE*', action: 'ask' }]
    } });
    const base: OpenSession = { projectId: randomUUID(), taskId: randomUUID(), projectRevision: 1, workspaceUri: pathToFileURL(directory).href, routeId: randomUUID(), model: { modelId: 'openai/gpt-6.1-sol', profileId: null }, permissionProfileId: 'approval-probe', resume: null };
    const session = await adapter.open(base);
    const observing = (async () => { for await (const event of adapter!.observe(session)) events.push(event); })();
    const wait = async (session: SessionRef, predicate: (snapshot: SessionSnapshot) => boolean, maxMs = 90_000) => {
      const deadline = Date.now() + maxMs;
      while (Date.now() < deadline) { const snapshot = await adapter!.reconcile(session); if (predicate(snapshot)) return snapshot; await new Promise(resolve => setTimeout(resolve, 250)); }
      throw new Error('Expected provider state was not observed.');
    };
    for (const decision of ['allow', 'deny'] as const) {
      const turn = await adapter.submit({ clientTurnId: randomUUID(), session, projectRevision: 1, sourceSnapshotId: null, userText: 'Use the bash tool exactly once to execute echo WORKBENCH_APPROVAL_PROBE. Wait for permission. If permission is denied, do not retry any tool; explain that it was denied. Do not use any other tool or edit files.', contextPacketId: randomUUID(), attachments: [], model: base.model });
      const pending = await wait(session, snapshot => snapshot.pendingApprovals.length > 0 || snapshot.activeTurn === null);
      assert.ok(pending.pendingApprovals.length === 1, 'Expected an actual provider permission request.');
      const approval = pending.pendingApprovals[0];
      assert.equal(approval.action, 'bash'); assert.match(approval.targetSummary, /WORKBENCH_APPROVAL_PROBE/);
      await adapter.answerApproval({ ...approval, decision, scope: 'once' });
      const finished = await wait(session, snapshot => snapshot.activeTurn === null);
      assert.equal(finished.latestTurnStatus, 'succeeded');
      assert.ok(events.some(event => event.type === 'agent.tool.finished' && event.payload.turn.clientTurnId === turn.clientTurnId && event.payload.outcome === (decision === 'allow' ? 'succeeded' : 'failed')), 'Expected an attributable tool result.');
      (result.checks as unknown[]).push({ check: `approval-${decision}`, requestId: approval.providerRequestId, scope: 'once', target: approval.targetSummary, turnId: turn.clientTurnId, outcome: finished.latestTurnStatus });
    }
    const resumed = await adapter.open({ ...base, resume: session });
    assert.equal(resumed.providerSessionId, session.providerSessionId);
    const long = await adapter.submit({ clientTurnId: randomUUID(), session: resumed, projectRevision: 1, sourceSnapshotId: null, userText: 'Write the numbers 1 to 10000, one per line. Do not use any tools.', contextPacketId: randomUUID(), attachments: [], model: base.model });
    await wait(resumed, snapshot => snapshot.latestTurnStatus === 'running' && snapshot.activeTurn !== null, 15_000);
    await adapter.interrupt(long);
    const interrupted = await wait(resumed, snapshot => snapshot.activeTurn === null);
    assert.equal(interrupted.latestTurnStatus, 'cancelled');
    (result.checks as unknown[]).push({ check: 'resume-and-interrupt', sessionId: resumed.providerSessionId, outcome: interrupted.latestTurnStatus });
    result.events = events.map(event => ({ type: event.type, sequence: event.sequence }));
    result.disposition = 'passed';
    await adapter.close({ stopOwnedProcess: true }); await observing;
  } catch (error) { result.disposition = 'failed'; result.error = { code: (error as { code?: string }).code ?? 'ASSERTION', message: error instanceof assert.AssertionError ? error.message : 'Live lifecycle did not reach the expected state; private diagnostics omitted.' }; process.exitCode = 1; }
  finally { await adapter?.close({ stopOwnedProcess: true }); result.endedAt = new Date().toISOString(); await writeFile(destination, JSON.stringify(result, null, 2) + '\n'); }
  console.log(JSON.stringify({ disposition: result.disposition, destination, error: result.error }));
}
void main();
