import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CodexAdapter } from '@robotics-workbench/codex';
import type { OpenSession, AgentEvent } from '@robotics-workbench/contracts';

async function main() {
  const executable = process.argv[2]; assert.ok(executable, 'Pass the absolute validated Codex executable.');
  const directory = resolve('artifacts/task05-codex-live'), workspace = join(directory, 'scratch space'); await mkdir(workspace, { recursive: true });
  const fixture = 'int twice(int n) { return n+n+1; }\n'; await writeFile(join(workspace, 'twice.cpp'), fixture);
  const projectId = randomUUID(), taskId = randomUUID(), packetId = randomUUID();
  const packet = JSON.stringify({ schemaVersion: 1, packetId, projectId, projectRevision: 1, task: 'Investigate twice off-by-one', source: { path: 'twice.cpp', sha256: createHash('sha256').update(fixture).digest('hex'), excerpt: fixture }, unknowns: ['No hardware measurement was made.'] });
  const record: Record<string, unknown> = { taskId: 'TASK-05', startedAt: new Date().toISOString(), fixtureSha256: createHash('sha256').update(fixture).digest('hex'), contextBytes: Buffer.byteLength(packet), procedure: 'Existing provider-managed route; isolated scratch project; read-only source diagnosis; text output, interrupt and restart/resume. No global config writes or hardware.' };
  let adapter = new CodexAdapter({ executable, contextPacket: async id => { assert.equal(id, packetId); return packet; } });
  const input: OpenSession = { projectId, taskId, projectRevision: 1, workspaceUri: pathToFileURL(workspace).href, routeId: randomUUID(), model: { modelId: 'gpt-6.1-sol', profileId: null }, permissionProfileId: 'read-only', resume: null };
  try {
    record.descriptor = await adapter.inspect(); const session = await adapter.open(input);
    const turn = await adapter.submit({ clientTurnId: randomUUID(), session, projectRevision: 1, sourceSnapshotId: null, userText: 'Text-only debugging fixture. Do not use tools or edit files. Explain the off-by-one in int twice(int n) { return n+n+1; } and propose the corrected implementation. Do not claim hardware verification.', contextPacketId: packetId, attachments: [], model: input.model });
    const events: AgentEvent[] = [];
    const timer = setTimeout(() => { void adapter.close({ stopOwnedProcess: true }); }, 150000);
    for await (const event of adapter.observe(session)) { events.push(event); if (event.type === 'agent.turn.finished' && event.payload.turn.clientTurnId === turn.clientTurnId) break; }
    clearTimeout(timer);
    const snapshot = await adapter.reconcile(session); assert.equal(snapshot.latestTurnStatus, 'succeeded');
    const answer = snapshot.messages.map(message => message.text).join('\n'); assert.match(answer, /n\s*\+\s*n|2\s*\*\s*n|n\s*\*\s*2/); assert.match(answer, /one|1|extra|off.by.one/i);
    record.answer = answer; record.eventTypes = events.map(event => event.type); record.firstTurnStatus = snapshot.latestTurnStatus;
    record.phase = 'second turn submission';
    const interrupted = await adapter.submit({ clientTurnId: randomUUID(), session, projectRevision: 1, sourceSnapshotId: null, userText: 'Do not use tools. Write the numbers from 1 through 1000, one per line.', contextPacketId: packetId, attachments: [], model: input.model });
    record.phase = 'wait for second turn output';
    for await (const event of adapter.observe(session)) if (event.type === 'agent.text.delta' && event.payload.turn.clientTurnId === interrupted.clientTurnId) break;
    record.phase = 'interrupt';
    await adapter.interrupt(interrupted);
    const deadline = setTimeout(() => { void adapter.close({ stopOwnedProcess: true }); }, 30000);
    for await (const event of adapter.observe(session)) if (event.type === 'agent.turn.finished' && event.payload.turn.clientTurnId === interrupted.clientTurnId) { assert.equal(event.payload.outcome, 'cancelled'); break; }
    clearTimeout(deadline); record.interruptStatus = (await adapter.reconcile(session)).latestTurnStatus;
    await adapter.close({ stopOwnedProcess: true });
    record.phase = 'resume'; adapter = new CodexAdapter({ executable, contextPacket: async () => packet }); const resumed = await adapter.open({ ...input, resume: session }); assert.equal(resumed.providerSessionId, session.providerSessionId);
    const reconciled = await adapter.reconcile(resumed); assert.equal(reconciled.latestTurnStatus, 'cancelled'); record.resume = 'passed';
    await adapter.close({ stopOwnedProcess: true }); record.phase = 'live one-time approval denial';
    adapter = new CodexAdapter({ executable, contextPacket: async () => packet, permissionProfiles: { 'approval-probe': { sandbox: 'read-only', approvalPolicy: 'on-request' } } });
    const approvalSession = await adapter.open({ ...input, taskId: randomUUID(), resume: null, permissionProfileId: 'approval-probe' });
    const approvalTurn = await adapter.submit({ clientTurnId: randomUUID(), session: approvalSession, projectRevision: 1, sourceSnapshotId: null, userText: 'This is a bounded permission-denial test. Try one shell command that writes the literal APPROVAL_FIXTURE into approval-probe.txt in the current working directory. The workspace is read-only: request permission escalation for that command. If denied, do not retry or use any other tool. Do not access any other file, network, or hardware.', contextPacketId: packetId, attachments: [], model: input.model });
    let approvalObserved = false;
    const approvalDeadline = setTimeout(() => { void adapter.close({ stopOwnedProcess: true }); }, 90000);
    for await (const event of adapter.observe(approvalSession)) {
      if (event.type === 'agent.approval.requested') { approvalObserved = true; const approval = event.payload.approval; await adapter.answerApproval({ approvalId: approval.approvalId, providerRequestId: approval.providerRequestId, turn: approval.turn, decision: 'deny', scope: 'once', expectedProjectRevision: 1, deviceId: null, artifactSha256: null }); }
      if (event.type === 'agent.turn.finished' && event.payload.turn.clientTurnId === approvalTurn.clientTurnId) break;
    }
    clearTimeout(approvalDeadline); assert.equal(approvalObserved, true, 'No attributable upstream approval was observed.'); record.liveApproval = 'one-time denial sent to exact upstream request'; record.result = 'passed';
  } catch (error) { record.result = 'failed'; record.error = error instanceof Error ? { name: error.name, code: 'code' in error ? error.code : undefined, message: error.message.slice(0, 300) } : 'Failure'; process.exitCode = 1; }
  finally { await adapter.close({ stopOwnedProcess: true }); record.endedAt = new Date().toISOString(); await writeFile(join(directory, 'result.json'), JSON.stringify(record, null, 2) + '\n'); console.log(JSON.stringify({ result: record.result, evidence: join(directory, 'result.json') })); }
}
void main();
