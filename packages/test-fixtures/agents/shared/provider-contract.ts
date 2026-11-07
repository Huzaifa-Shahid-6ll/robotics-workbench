import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AgentEvent, OpenSession, ProviderAdapter, SessionRef, SubmitTurn, TurnRef } from '@robotics-workbench/contracts';

export interface ProviderContractFixture {
  adapter: ProviderAdapter; open: OpenSession; session: SessionRef; submit: SubmitTurn;
  finish(turn: TurnRef): void | Promise<void>;
  dispose?(): void | Promise<void>;
}
/** Both vendor fixtures run the same application-contract assertions. */
export function providerContract(name: string, create: (test: TestContext) => Promise<ProviderContractFixture>): void {
  test(`${name}: shared normalized-session lifecycle and duplicate submission contract`, { timeout: 5000 }, async context => {
    const fixture = await create(context);
    context.after(() => fixture.dispose?.());
    const descriptor = await fixture.adapter.inspect();
    assert.equal(descriptor.readiness, 'ready');
    assert.match(descriptor.protocolFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(fixture.session.providerId, descriptor.providerId);
    assert.equal(fixture.session.projectId, fixture.open.projectId);
    assert.equal(fixture.session.taskId, fixture.open.taskId);
    assert.equal(fixture.session.workspaceUri, fixture.open.workspaceUri);
    const turn = await fixture.adapter.submit(fixture.submit);
    assert.equal(turn.clientTurnId, fixture.submit.clientTurnId);
    assert.deepEqual(await fixture.adapter.submit(fixture.submit), turn);
    await fixture.finish(turn);
    const events: AgentEvent[] = [];
    for await (const event of fixture.adapter.observe(fixture.session)) {
      events.push(event);
      assert.equal(event.schemaVersion, 1);
      assert.equal(event.projectId, fixture.open.projectId);
      assert.equal(event.projectRevision, fixture.open.projectRevision);
      assert.ok(Number.isSafeInteger(event.sequence) && event.sequence > 0);
      assert.ok(Number.isFinite(Date.parse(event.occurredAt)));
      assert.ok(['agent.session.opened', 'agent.turn.started', 'agent.text.delta', 'agent.tool.started', 'agent.tool.finished', 'agent.approval.requested', 'agent.turn.finished', 'agent.connection.changed'].includes(event.type));
      if (event.type === 'agent.turn.finished') { assert.equal(event.payload.outcome, 'succeeded'); break; }
    }
    assert.equal(events.filter(event => event.type === 'agent.turn.finished').length, 1);
    const snapshot = await fixture.adapter.reconcile(fixture.session);
    assert.deepEqual(snapshot.session, fixture.session);
    assert.equal(snapshot.latestTurnStatus, 'succeeded');
    assert.equal(snapshot.activeTurn, null);
    assert.ok(snapshot.messages.every(message => message.role === 'assistant' || message.role === 'user'));
  });
  test(`${name}: shared capability and cross-project rejection contract`, { timeout: 5000 }, async context => {
    const fixture = await create(context);
    context.after(() => fixture.dispose?.());
    await assert.rejects(fixture.adapter.submit({ ...fixture.submit, session: { ...fixture.session, projectId: randomUUID() } }), { code: 'WORKSPACE_MISMATCH' });
    const descriptor = await fixture.adapter.inspect();
    if (!descriptor.capabilities.includes('images')) await assert.rejects(fixture.adapter.submit({ ...fixture.submit, attachments: [{ artifactId: randomUUID(), sha256: 'a'.repeat(64), mediaType: 'image/png', displayName: 'fixture.png', byteLength: 1 }] }), { code: 'CAPABILITY_UNSUPPORTED' });
    await assert.rejects(fixture.adapter.open({ ...fixture.open, resume: { ...fixture.session, projectId: randomUUID() } }), { code: 'WORKSPACE_MISMATCH' });
  });
}
