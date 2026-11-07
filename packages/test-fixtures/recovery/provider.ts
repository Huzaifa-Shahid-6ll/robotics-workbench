import { randomUUID } from 'node:crypto';
import type { AgentEvent, OpenSession, ProviderAdapter, ProviderDescriptor, ProviderId, SessionRef, SessionSnapshot, SubmitTurn, TurnRef } from '@robotics-workbench/contracts';

/** Synthetic normalized adapter only; no vendor process, model or physical effect exists. */
export class JourneyProvider implements ProviderAdapter {
  submits = 0;
  session!: SessionRef;
  turn: TurnRef | null = null;
  private closed = false;
  private readonly events: AgentEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private status: SessionSnapshot['latestTurnStatus'] = null;
  private projectRevision = 1;
  constructor(readonly providerId: ProviderId) {}
  async inspect(): Promise<ProviderDescriptor> {
    return { providerId: this.providerId, executableVersion: 'synthetic', adapterVersion: '1', protocolFingerprint: 'a'.repeat(64), capabilities: ['resume', 'interrupt'], readiness: 'ready', problems: [] };
  }
  async open(input: OpenSession): Promise<SessionRef> {
    return this.session = input.resume ?? { providerId: this.providerId, projectId: input.projectId, taskId: input.taskId, providerSessionId: randomUUID(), workspaceUri: input.workspaceUri };
  }
  async submit(input: SubmitTurn): Promise<TurnRef> {
    this.submits++; this.status = 'running'; this.projectRevision = input.projectRevision;
    return this.turn = { clientTurnId: input.clientTurnId, session: input.session, providerTurnId: randomUUID() };
  }
  async *observe(): AsyncIterable<AgentEvent> {
    let cursor = 0;
    while (!this.closed || cursor < this.events.length) {
      while (cursor < this.events.length) yield structuredClone(this.events[cursor++]);
      if (!this.closed) await new Promise<void>(resolve => this.waiters.add(resolve));
    }
  }
  finish(outcome: 'succeeded' | 'cancelled' = 'succeeded'): void {
    const turn = this.turn; this.turn = null; this.status = outcome;
    this.events.push({ schemaVersion: 1, eventId: randomUUID(), sequence: this.events.length + 1, projectId: this.session.projectId, projectRevision: this.projectRevision, occurredAt: new Date().toISOString(), type: 'agent.turn.finished', payload: { turn, outcome, usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, source: 'unavailable' }, problem: null } } as AgentEvent);
    this.wake();
  }
  private wake(): void { for (const wake of this.waiters) wake(); this.waiters.clear(); }
  async answerApproval(): Promise<void> { throw Error('Synthetic provider has no approval capability.'); }
  async interrupt(): Promise<void> { this.finish('cancelled'); }
  async reconcile(): Promise<SessionSnapshot> {
    return { session: this.session, descriptor: await this.inspect(), connection: this.closed ? 'disconnected' : 'connected', activeTurn: this.turn, latestTurnStatus: this.status, pendingApprovals: [], messages: [], nextCursor: null, observedAt: new Date().toISOString() };
  }
  async close(): Promise<void> { this.closed = true; this.wake(); }
}
