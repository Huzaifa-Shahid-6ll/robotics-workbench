import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/client';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AgentEvent, ApprovalAnswer, ApprovalRequest, AdapterProblem, OpenSession, ProviderAdapter, ProviderDescriptor, SessionRef, SessionSnapshot, SubmitTurn, TurnRef, Usage } from '@robotics-workbench/contracts';

export const OPEN_CODE_VERSION = '1.18.32';
export const OPEN_CODE_FINGERPRINT = '46db986090aae41846cd6dbe16225a1d883f0bbcb4c48814008d3f6ce140aa5c';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unknownUsage: Usage = { inputTokens: null, outputTokens: null, cachedInputTokens: null, source: 'unavailable' };
type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('PROTOCOL_ERROR', 'Malformed provider object.'); return value as RecordValue; }
function string(value: unknown, max = 512): string { if (typeof value !== 'string' || !value.length || value.length > max) fail('PROTOCOL_ERROR', 'Malformed provider string.'); return value as string; }
function fail(code: AdapterProblem['code'], message: string): never { throw Object.assign(new Error(message), { code }); }
function problem(code: AdapterProblem['code'], message: string): AdapterProblem { return { code, message, retryable: code === 'TRANSPORT_LOST', nextAction: 'Inspect the connection and reconcile the existing session before starting new work.' }; }
function safeSummary(value: string): string { return value.replace(/(?:Bearer\s+|(?:api[_-]?key|token|password|authorization)\s*[=:]\s*)[^\s'";]+/gi, '[redacted]').replace(/https?:\/\/[^\s]+/gi, '[URL omitted]').slice(0, 1800); }
type PermissionRule = { permission: string; pattern: string; action: 'allow' | 'ask' | 'deny' };
const reads = ['read', 'glob', 'grep', 'list', 'lsp', '*_project_snapshot', '*_component_inspect', '*_connections_query', '*_build_diagnostics', '*_device_status', '*_recording_query', '*_operation_get'];
const defaultProfiles: Record<string, PermissionRule[]> = {
  'read-only': [{ permission: '*', pattern: '*', action: 'deny' }, ...reads.map(permission => ({ permission, pattern: '*', action: 'allow' as const }))],
  'workspace-write': [{ permission: '*', pattern: '*', action: 'ask' }, ...reads.map(permission => ({ permission, pattern: '*', action: 'allow' as const }))]
};
function samePermissions(value: unknown, expected: PermissionRule[]): boolean { return Array.isArray(value) && JSON.stringify(value.map(rule => { const entry = object(rule); return [entry.permission, entry.pattern, entry.action]; })) === JSON.stringify(expected.map(rule => [rule.permission, rule.pattern, rule.action])); }
function normalize(error: unknown): Error & { code: AdapterProblem['code'] } {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string' && /^(PROVIDER_|AUTH_|MODEL_|RATE_|TRANSPORT_|PROTOCOL_|APPROVAL_|WORKSPACE_|REVISION_|CAPABILITY_)/.test(error.code)) return error as Error & { code: AdapterProblem['code'] };
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
  if (error && typeof error === 'object' && '_tag' in error && error._tag === 'PermissionNotFoundError') return Object.assign(new Error('Provider permission request is expired or already resolved.'), { code: 'APPROVAL_EXPIRED' as const });
  return Object.assign(new Error(status === 401 || status === 403 ? 'Provider authentication is required.' : status === 429 ? 'Provider route is rate limited.' : 'Provider transport failed; delivery may be unknown.'), { code: status === 401 || status === 403 ? 'AUTH_REQUIRED' as const : status === 429 ? 'RATE_LIMITED' as const : 'TRANSPORT_LOST' as const });
}
async function canonical(directory: string): Promise<string> { const resolved = await realpath(directory); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; }

export interface OpenCodeOptions {
  endpoint: string;
  directory: string;
  password: string;
  username?: string;
  contextText: (packetId: string) => Promise<string>;
  nextSequence?: () => number;
  expectedVersion?: string;
  expectedFingerprint?: string;
  fetch?: typeof fetch;
  permissionProfiles?: Record<string, PermissionRule[]>;
}
export interface LaunchOpenCodeOptions extends Omit<OpenCodeOptions, 'endpoint' | 'password'> {
  executable: string;
  runtimeConfig?: Record<string, unknown>;
}
type State = {
  ref: SessionRef; revision: number; active: TurnRef | null; status: SessionSnapshot['latestTurnStatus'];
  approvals: Map<string, ApprovalRequest>; texts: Map<string, { messageId: string; text: string; delta: number }>;
  messages: SessionSnapshot['messages']; submitted: Map<string, { turn: TurnRef; digest: string }>;
  tools: Set<string>; assistantParents: Map<string, string>; deltas: Map<string, number>; connection: SessionSnapshot['connection'];
};

export class OpenCodeAdapter implements ProviderAdapter {
  private readonly client: OpencodeClient;
  private readonly request: typeof fetch;
  private readonly headers: Record<string, string>;
  private readonly states = new Map<string, State>();
  private readonly events: AgentEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private sequence = 0;
  private descriptor?: ProviderDescriptor;
  private stream?: AbortController;
  private streaming?: Promise<void>;
  private owned?: ChildProcess;
  private closed = false;

  constructor(private readonly options: OpenCodeOptions) {
    const endpoint = new URL(options.endpoint);
    if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) fail('PROVIDER_UNSUPPORTED', 'OpenCode requires an authenticated loopback HTTP endpoint.');
    if (!options.password || !options.directory) fail('AUTH_REQUIRED', 'Local server credentials and workspace are required.');
    this.headers = { Authorization: `Basic ${Buffer.from(`${options.username ?? 'opencode'}:${options.password}`).toString('base64')}` };
    const baseFetch = options.fetch ?? fetch;
    this.request = async (input, init) => {
      try {
        const request = input instanceof Request ? input : new Request(input, init);
        const response = await baseFetch(request, { ...init, redirect: 'error', signal: new URL(request.url).pathname === '/event' ? request.signal : AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]) });
        if (response.status === 401 || response.status === 403 || response.status === 429) throw Object.assign(new Error('Provider request rejected.'), { status: response.status });
        return response;
      } catch (error) { throw normalize(error); }
    };
    this.client = createOpencodeClient({ baseUrl: endpoint.origin, directory: options.directory, headers: this.headers, throwOnError: true, fetch: this.request });
  }

  static async launch(options: LaunchOpenCodeOptions): Promise<OpenCodeAdapter> {
    const directory = await realpath(options.directory);
    if (options.runtimeConfig?.mcp) {
      const names = Object.keys(object(options.runtimeConfig.mcp));
      const probe = await OpenCodeAdapter.launch({ ...options, directory, runtimeConfig: undefined });
      try {
        const config = object((await probe.client.config.get()).data);
        const existing = config.mcp ? object(config.mcp) : {};
        if (names.some(name => name in existing)) fail('PROVIDER_UNSUPPORTED', 'Runtime MCP name collides with existing provider configuration.');
      } finally { await probe.close({ stopOwnedProcess: true }); }
    }
    const password = randomBytes(32).toString('hex');
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'PATH', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT']) if (process.env[key]) env[key] = process.env[key];
    if (options.runtimeConfig) {
      const inherited = env.OPENCODE_CONFIG_CONTENT ? object(JSON.parse(env.OPENCODE_CONFIG_CONTENT)) : {};
      if (inherited.mcp && options.runtimeConfig.mcp) {
        for (const name of Object.keys(object(options.runtimeConfig.mcp))) if (name in object(inherited.mcp)) fail('PROVIDER_UNSUPPORTED', 'Runtime MCP name collides with inherited configuration.');
      }
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...inherited, ...options.runtimeConfig, mcp: { ...(inherited.mcp ? object(inherited.mcp) : {}), ...(options.runtimeConfig.mcp ? object(options.runtimeConfig.mcp) : {}) } });
    }
    env.OPENCODE_SERVER_PASSWORD = password;
    env.OPENCODE_SERVER_USERNAME = options.username ?? 'opencode';
    const child = spawn(options.executable, ['serve', '--hostname', '127.0.0.1', '--port', '0', '--pure'], { cwd: directory, env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    try {
      const endpoint = await new Promise<string>((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => { cleanup(); reject(new Error('Provider startup timed out.')); }, 30_000);
        const cleanup = () => { clearTimeout(timer); child.stdout?.off('data', onData); child.off('error', onError); child.off('close', onClose); };
        const onError = () => { cleanup(); reject(new Error('Provider process could not start.')); };
        const onClose = () => { cleanup(); reject(new Error('Provider exited before readiness.')); };
        const onData = (bytes: Buffer) => { output = (output + bytes.toString()).slice(-4096); const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { cleanup(); resolve(match[0]); } };
        child.stdout?.on('data', onData); child.once('error', onError); child.once('close', onClose);
      });
      const adapter = new OpenCodeAdapter({ ...options, directory, endpoint, password });
      adapter.owned = child;
      child.on('error', () => adapter.disconnected(problem('TRANSPORT_LOST', 'Owned provider process failed.')));
      child.on('close', () => { if (!adapter.closed) adapter.disconnected(problem('TRANSPORT_LOST', 'Owned provider process exited.')); });
      await adapter.inspect();
      return adapter;
    } catch (error) { child.kill(); throw normalize(error); }
  }

  async inspect(): Promise<ProviderDescriptor> {
    if (this.closed) fail('TRANSPORT_LOST', 'Provider connection is closed.');
    const health = await this.json('/global/health');
    const version = string(health.version, 128);
    if (health.healthy !== true || version !== (this.options.expectedVersion ?? OPEN_CODE_VERSION)) fail('PROVIDER_UNSUPPORTED', 'OpenCode executable/SDK pair has not been validated.');
    const doc = await this.json('/doc');
    const fingerprint = createHash('sha256').update(JSON.stringify(doc)).digest('hex');
    if (fingerprint !== (this.options.expectedFingerprint ?? OPEN_CODE_FINGERPRINT)) fail('PROVIDER_UNSUPPORTED', 'OpenCode protocol fingerprint changed.');
    this.descriptor = { providerId: 'opencode', executableVersion: version, adapterVersion: '1', protocolFingerprint: fingerprint, capabilities: ['resume', 'interrupt', 'mcp', 'usage', 'approvals'], readiness: 'ready', problems: [] };
    return structuredClone(this.descriptor);
  }

  async open(input: OpenSession): Promise<SessionRef> {
    if (![input.projectId, input.taskId, input.routeId].every(id => uuid.test(id)) || !Number.isInteger(input.projectRevision) || input.projectRevision < 1) fail('PROTOCOL_ERROR', 'Invalid session identity or revision.');
    const directory = await canonical(this.options.directory);
    if (await canonical(fileURLToPath(input.workspaceUri)) !== directory) fail('WORKSPACE_MISMATCH', 'Session workspace differs from the authorized directory.');
    await this.inspect();
    await this.model(input.model.modelId);
    const profiles = this.options.permissionProfiles ?? defaultProfiles;
    const permission = Object.hasOwn(profiles, input.permissionProfileId) ? profiles[input.permissionProfileId] : undefined;
    if (!permission || !Array.isArray(permission) || !permission.length || permission.length > 100 || permission.some(rule => !rule || !['allow', 'ask', 'deny'].includes(rule.action) || !rule.permission || !rule.pattern)) fail('CAPABILITY_UNSUPPORTED', 'Unknown or invalid OpenCode permission profile.');
    let id: string;
    if (input.resume) {
      if (input.resume.providerId !== 'opencode' || input.resume.projectId !== input.projectId || input.resume.taskId !== input.taskId || await canonical(fileURLToPath(input.resume.workspaceUri)) !== directory) fail('WORKSPACE_MISMATCH', 'Saved session binding does not match this project/task.');
      const result = object((await this.client.session.get({ path: { id: input.resume.providerSessionId } })).data);
      if (await canonical(string(result.directory, 32768)) !== directory) fail('WORKSPACE_MISMATCH', 'Provider session belongs to another directory.');
      id = string(result.id);
      if (!samePermissions(result.permission, permission)) fail('CAPABILITY_UNSUPPORTED', 'Saved provider session permissions differ from the requested profile; start a new scoped session.');
      const statuses = object((await this.client.session.status()).data);
      if (statuses[id] && object(statuses[id]).type !== 'idle') fail('PROTOCOL_ERROR', 'Provider session already has active work; reconcile with its original owner.');
    } else {
      const body = { title: 'Robotics Workbench task', permission };
      const result = object((await this.client.session.create({ body })).data);
      id = string(result.id);
      if (!samePermissions(result.permission, permission)) fail('PROVIDER_UNSUPPORTED', 'Provider did not confirm the requested session permissions.');
      if (result.directory && await canonical(string(result.directory, 32768)) !== directory) fail('WORKSPACE_MISMATCH', 'Provider created a session in another directory.');
    }
    const ref: SessionRef = { providerId: 'opencode', projectId: input.projectId, taskId: input.taskId, providerSessionId: id, workspaceUri: pathToFileURL(await realpath(this.options.directory)).href };
    this.states.set(id, { ref, revision: input.projectRevision, active: null, status: null, approvals: new Map(), texts: new Map(), messages: [], submitted: new Map(), tools: new Set(), assistantParents: new Map(), deltas: new Map(), connection: 'connected' });
    await this.startStream();
    this.emit(this.state(ref), { type: 'agent.session.opened', payload: { session: ref, descriptor: this.descriptor! } });
    return structuredClone(ref);
  }

  async submit(input: SubmitTurn): Promise<TurnRef> {
    const state = this.state(input.session);
    if (!uuid.test(input.clientTurnId) || !uuid.test(input.contextPacketId) || !input.userText || input.userText.length > 32768 || !Number.isInteger(input.projectRevision) || input.projectRevision < 1) fail('PROTOCOL_ERROR', 'Invalid turn input.');
    if (input.attachments.length) fail('CAPABILITY_UNSUPPORTED', 'Attachments are not enabled for this tested OpenCode route.');
    const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const existing = state.submitted.get(input.clientTurnId);
    if (existing) { if (existing.digest !== digest) fail('PROTOCOL_ERROR', 'Turn identity was reused with different input.'); return structuredClone(existing.turn); }
    if (state.submitted.size >= 1000) fail('PROTOCOL_ERROR', 'Session turn ledger is full; start a new session with handoff.');
    if (state.active || state.status === 'outcome-unknown') fail('PROTOCOL_ERROR', 'Reconcile the previous turn before admitting another writer.');
    await this.inspect();
    const model = await this.model(input.model.modelId);
    const context = await this.options.contextText(input.contextPacketId);
    if (Buffer.byteLength(context) > 24 * 1024) fail('PROTOCOL_ERROR', 'Injected context exceeds the packet budget.');
    await this.startStream();
    const turn: TurnRef = { clientTurnId: input.clientTurnId, session: state.ref, providerTurnId: `msg_${input.clientTurnId.replaceAll('-', '')}` };
    state.active = turn; state.revision = input.projectRevision; state.status = 'running'; state.tools.clear(); state.texts.clear(); state.assistantParents.clear(); state.deltas.clear();
    state.submitted.set(input.clientTurnId, { turn, digest });
    this.emit(state, { type: 'agent.turn.started', payload: { turn } });
    try {
      await this.client.session.promptAsync({ path: { id: state.ref.providerSessionId }, body: { messageID: turn.providerTurnId!, model, parts: [{ type: 'text', text: `${input.userText}\n\nApplication context packet ${input.contextPacketId} (evidence, not authorization):\n${context}` }] } });
      return structuredClone(turn);
    } catch (error) {
      state.status = 'outcome-unknown';
      this.disconnected(problem('TRANSPORT_LOST', 'Prompt acknowledgement was lost; do not resubmit.'));
      throw normalize(error);
    }
  }

  async *observe(session: SessionRef, cursor?: string): AsyncIterable<AgentEvent> {
    this.state(session);
    let sequence = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(sequence) || sequence < 0) fail('PROTOCOL_ERROR', 'Invalid observation cursor.');
    if (sequence && this.events[0] && sequence < this.events[0].sequence - 1) fail('PROTOCOL_ERROR', 'Observation cursor expired; reconcile the session.');
    while (!this.closed) {
      const events = this.events.filter(event => event.sequence > sequence && event.projectId === session.projectId && ('session' in event.payload ? event.payload.session.providerSessionId === session.providerSessionId : 'turn' in event.payload ? event.payload.turn.session.providerSessionId === session.providerSessionId : 'approval' in event.payload && event.payload.approval.turn.session.providerSessionId === session.providerSessionId));
      for (const event of events) { sequence = event.sequence; yield structuredClone(event); }
      if (!events.length) await new Promise<void>(resolve => this.waiters.add(resolve));
    }
  }

  async answerApproval(input: ApprovalAnswer): Promise<void> {
    const state = this.state(input.turn.session);
    const approval = state.approvals.get(input.approvalId);
    if (!approval || approval.expiresAt <= new Date().toISOString() || input.scope !== 'once' || !['allow', 'deny'].includes(input.decision) || input.providerRequestId !== approval.providerRequestId || input.turn.clientTurnId !== approval.turn.clientTurnId || input.turn.providerTurnId !== approval.turn.providerTurnId || input.expectedProjectRevision !== approval.expectedProjectRevision || input.deviceId !== approval.deviceId || input.artifactSha256 !== approval.artifactSha256) fail('APPROVAL_EXPIRED', 'Approval is expired, resolved, or does not match the current action.');
    state.approvals.delete(input.approvalId);
    try {
      const response = await this.client.postSessionIdPermissionsPermissionId({ path: { id: state.ref.providerSessionId, permissionID: approval.providerRequestId }, body: { response: input.decision === 'allow' ? 'once' : 'reject' } });
      if (response.data !== true) fail('PROTOCOL_ERROR', 'Permission response was not confirmed.');
      state.status = 'running';
    } catch (error) { state.status = 'outcome-unknown'; throw normalize(error); }
  }

  async interrupt(turn: TurnRef): Promise<void> {
    const state = this.state(turn.session);
    if (!state.active || state.active.clientTurnId !== turn.clientTurnId || state.active.providerTurnId !== turn.providerTurnId) fail('PROTOCOL_ERROR', 'The requested turn is not active.');
    try { if ((await this.client.session.abort({ path: { id: state.ref.providerSessionId } })).data !== true) fail('PROTOCOL_ERROR', 'Provider did not acknowledge interruption.'); }
    catch (error) { state.status = 'outcome-unknown'; throw normalize(error); }
    await this.reconcile(state.ref);
  }

  async reconcile(session: SessionRef): Promise<SessionSnapshot> {
    const state = this.state(session);
    await this.inspect();
    const response = (await this.client.session.messages({ path: { id: session.providerSessionId } })).data;
    if (!Array.isArray(response) || response.length > 10000) fail('PROTOCOL_ERROR', 'Malformed provider message snapshot.');
    state.messages = response.slice(-100).map(entry => {
      const record = object(entry); const info = object(record.info); const id = string(info.id);
      if (info.sessionID !== session.providerSessionId || !['user', 'assistant'].includes(String(info.role)) || !Array.isArray(record.parts)) fail('PROTOCOL_ERROR', 'Provider message scope is invalid.');
      const text = record.parts.filter(part => object(part).type === 'text').map(part => string(object(part).text || ' ', 1024 * 1024)).join('\n');
      if (Buffer.byteLength(text) > 64 * 1024) fail('PROTOCOL_ERROR', 'Provider message exceeds the presentation budget.');
      return { messageId: id, role: info.role as 'user' | 'assistant', text, artifactRef: null, complete: info.role === 'user' || !!object(info.time).completed };
    });
    const statuses = object((await this.client.session.status()).data);
    const status = statuses[session.providerSessionId];
    const active = state.active;
    if (active && (!status || object(status).type === 'idle')) {
      const assistant = response.filter(entry => entry.info.role === 'assistant' && entry.info.parentID === active.providerTurnId).at(-1);
      if (assistant?.info.role === 'assistant' && assistant.info.time.completed) {
        const errorName = assistant.info.error?.name;
        const outcome = errorName === 'MessageAbortedError' ? 'cancelled' : errorName ? 'failed' : 'succeeded';
        this.finish(state, outcome, this.usage(assistant.info.tokens), errorName ? problem(errorName === 'ProviderAuthError' ? 'AUTH_REQUIRED' : 'PROTOCOL_ERROR', 'Provider reported a terminal error; private payload omitted.') : null);
      } else if (state.active?.clientTurnId === active.clientTurnId) state.status = 'outcome-unknown';
    }
    state.connection = 'connected';
    await this.startStream();
    return { session: structuredClone(state.ref), descriptor: structuredClone(this.descriptor!), connection: state.connection, activeTurn: structuredClone(state.active), latestTurnStatus: state.status, pendingApprovals: [...state.approvals.values()].filter(approval => approval.expiresAt > new Date().toISOString()).map(value => structuredClone(value)), messages: structuredClone(state.messages), nextCursor: null, observedAt: new Date().toISOString() };
  }

  async close(options: { stopOwnedProcess: boolean }): Promise<void> {
    this.closed = true; this.stream?.abort();
    for (const wake of this.waiters) wake(); this.waiters.clear();
    await this.streaming;
    if (this.owned && options.stopOwnedProcess) {
      const child = this.owned;
      if (child.exitCode === null) await new Promise<void>(resolve => { const timer = setTimeout(resolve, 5000); child.once('close', () => { clearTimeout(timer); resolve(); }); child.kill(); });
    }
  }

  private async json(path: string): Promise<RecordValue> {
    const response = await this.request(new Request(new URL(path, this.options.endpoint), { headers: this.headers }));
    if (!response.ok) fail('PROVIDER_UNSUPPORTED', 'OpenCode readiness endpoint was unavailable.');
    const text = await response.text();
    if (Buffer.byteLength(text) > 16 * 1024 * 1024) fail('PROTOCOL_ERROR', 'Provider schema exceeded the bound.');
    try { return object(JSON.parse(text)); } catch { fail('PROTOCOL_ERROR', 'Malformed provider readiness response.'); }
  }
  private state(session: SessionRef): State {
    const state = this.states.get(session.providerSessionId);
    if (!state || session.providerId !== 'opencode' || state.ref.projectId !== session.projectId || state.ref.taskId !== session.taskId || state.ref.workspaceUri !== session.workspaceUri) fail('WORKSPACE_MISMATCH', 'Session does not belong to this authorized project/task.');
    if (this.closed) fail('TRANSPORT_LOST', 'Provider connection is closed.');
    return state;
  }
  private async model(id: string): Promise<{ providerID: string; modelID: string }> {
    if (typeof id !== 'string' || id.length > 256 || id.indexOf('/') < 1) fail('MODEL_UNAVAILABLE', 'Choose an explicit provider/model route.');
    const slash = id.indexOf('/'); const providerID = id.slice(0, slash); const modelID = id.slice(slash + 1);
    const result = object((await this.client.provider.list()).data);
    if (!Array.isArray(result.connected) || !Array.isArray(result.all)) fail('PROTOCOL_ERROR', 'Malformed provider catalog.');
    const provider = result.all.map(object).find(item => item.id === providerID);
    if (!result.connected.includes(providerID)) fail('AUTH_REQUIRED', 'The selected provider route is not connected.');
    if (!provider || !object(provider.models)[modelID]) fail('MODEL_UNAVAILABLE', 'The selected model is not available; no route fallback was attempted.');
    return { providerID, modelID };
  }
  private async startStream(): Promise<void> {
    if (this.stream && !this.stream.signal.aborted) return;
    const controller = new AbortController(); this.stream = controller;
    const url = new URL('/event', this.options.endpoint); url.searchParams.set('directory', this.options.directory);
    // SDK 1.18.32 SSE ignores its configured fetch; keep authentication/redirect bounds here.
    const response = await this.request(new Request(url, { headers: this.headers, signal: controller.signal }));
    if (!response.ok || !response.body) { controller.abort(); fail('TRANSPORT_LOST', 'Provider event stream could not be opened.'); }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    controller.signal.addEventListener('abort', () => { void reader.cancel().catch(() => {}); }, { once: true });
    this.streaming = (async () => {
      let buffer = '';
      try {
        while (!controller.signal.aborted) {
          const result = await reader.read(); if (result.done) break;
          buffer = (buffer + result.value).replaceAll('\r\n', '\n');
          if (Buffer.byteLength(buffer) > 1024 * 1024) fail('PROTOCOL_ERROR', 'Provider event exceeds the bound.');
          let end: number;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (data) this.ingest(JSON.parse(data));
          }
        }
        if (!controller.signal.aborted) this.disconnected(problem('TRANSPORT_LOST', 'Provider event stream ended.'));
      } catch (error) { if (!controller.signal.aborted) this.disconnected(problem(normalize(error).code, 'Provider event stream failed; reconcile without resubmitting.')); }
      finally { controller.abort(); reader.releaseLock(); }
    })();
  }
  private ingest(value: unknown): void {
    const event = object(value); const type = string(event.type, 128); const properties = object(event.properties);
    const nested = properties.info ?? properties.part;
    const sessionId = properties.sessionID ?? (nested && object(nested).sessionID);
    if (typeof sessionId !== 'string') return;
    const state = this.states.get(sessionId); if (!state || !state.active) return;
    const turn = state.active;
    if (type === 'message.updated') {
      const info = object(properties.info);
      if (state.assistantParents.size >= 100) fail('PROTOCOL_ERROR', 'Too many provider messages in one turn.');
      if (info.role === 'assistant') state.assistantParents.set(string(info.id), string(info.parentID));
    } else if (type === 'message.part.updated') {
      const part = object(properties.part);
      if (state.assistantParents.get(string(part.messageID)) !== turn.providerTurnId) return;
      if (part.type === 'text') {
        const messageId = string(part.messageID); const id = string(part.id); const text = typeof part.text === 'string' ? part.text : fail('PROTOCOL_ERROR', 'Malformed text part.');
        if (Buffer.byteLength(text) > 64 * 1024) fail('PROTOCOL_ERROR', 'Provider text exceeds the display budget.');
        const prior = state.texts.get(id);
        if (prior?.text === text) return;
        if (prior && !text.startsWith(prior.text)) { state.status = 'outcome-unknown'; return; }
        if (!prior && state.texts.size >= 100) fail('PROTOCOL_ERROR', 'Too many provider text parts in one turn.');
        const delta = text.slice(prior?.text.length ?? 0); const index = state.deltas.get(messageId) ?? 0;
        state.texts.set(id, { messageId, text, delta: index + 1 });
        if (delta) { state.deltas.set(messageId, index + 1); this.emit(state, { type: 'agent.text.delta', payload: { turn, messageId, deltaIndex: index, text: delta } }); }
      } else if (part.type === 'tool') {
        const tool = string(part.tool, 128); const call = string(part.callID); const toolState = object(part.state); const status = string(toolState.status, 32);
        const key = `${call}:${status}`; if (state.tools.has(key)) return; if (state.tools.size >= 1000) fail('PROTOCOL_ERROR', 'Too many provider tool events.'); state.tools.add(key);
        if (status === 'running' || status === 'pending') { if (state.tools.has(`${call}:started`)) return; state.tools.add(`${call}:started`); this.emit(state, { type: 'agent.tool.started', payload: { turn, toolCallId: call, displayName: tool, redactedInputSummary: 'Provider-managed tool; inputs omitted.' } }); }
        else if (status === 'completed' || status === 'error') this.emit(state, { type: 'agent.tool.finished', payload: { turn, toolCallId: call, outcome: status === 'completed' ? 'succeeded' : 'failed', artifactRefs: [], summary: status === 'completed' ? 'Provider tool completed.' : 'Provider tool failed; private output omitted.' } });
      }
    } else if (type === 'permission.asked') {
      const id = string(properties.id); if ([...state.approvals.values()].some(value => value.providerRequestId === id)) return;
      if (state.approvals.size >= 32) fail('PROTOCOL_ERROR', 'Too many pending provider approvals.');
      const action = string(properties.permission, 128);
      if (!Array.isArray(properties.patterns) || properties.patterns.length > 100) fail('PROTOCOL_ERROR', 'Permission targets are missing or malformed.');
      const targets = properties.patterns.map(value => string(value, 4096)).join('; ');
      const approval: ApprovalRequest = { approvalId: randomUUID(), providerRequestId: id, turn, action, targetSummary: safeSummary(`${action}: ${targets || 'No target supplied; deny this request.'}`), expectedProjectRevision: state.revision, deviceId: null, artifactSha256: null, permittedScopes: ['once'], expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
      state.approvals.set(approval.approvalId, approval); state.status = 'awaiting-input'; this.emit(state, { type: 'agent.approval.requested', payload: { approval } });
    } else if (type === 'permission.replied') {
      for (const [id, approval] of state.approvals) if (approval.providerRequestId === properties.requestID) state.approvals.delete(id);
    } else if (type === 'session.idle' || type === 'session.error' || (type === 'session.status' && object(properties.status).type === 'idle')) {
      void this.reconcile(state.ref).catch(error => this.disconnected(problem(normalize(error).code, 'Session reconciliation failed.')));
    }
  }
  private usage(value: unknown): Usage {
    if (!value || typeof value !== 'object') return unknownUsage;
    const tokens = object(value); const cache = tokens.cache ? object(tokens.cache) : {};
    const number = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
    return { inputTokens: number(tokens.input), outputTokens: number(tokens.output), cachedInputTokens: number(cache.read), source: 'provider-reported' };
  }
  private finish(state: State, outcome: 'succeeded' | 'failed' | 'cancelled' | 'outcome-unknown', usage: Usage, issue: AdapterProblem | null): void {
    if (!state.active) return;
    const turn = state.active; state.active = null; state.status = outcome; state.approvals.clear();
    this.emit(state, { type: 'agent.turn.finished', payload: { turn, outcome, usage, problem: issue } });
  }
  private disconnected(issue: AdapterProblem): void {
    for (const state of this.states.values()) { if (state.connection === 'disconnected') continue; state.connection = 'disconnected'; if (state.active) state.status = 'outcome-unknown'; this.emit(state, { type: 'agent.connection.changed', payload: { session: state.ref, connection: 'disconnected', problem: issue } }); }
  }
  private emit(state: State, event: AgentEvent extends infer E ? E extends AgentEvent ? Pick<E, 'type' | 'payload'> : never : never): void {
    this.events.push({ schemaVersion: 1, eventId: randomUUID(), sequence: this.options.nextSequence?.() ?? ++this.sequence, projectId: state.ref.projectId, projectRevision: state.revision, occurredAt: new Date().toISOString(), ...event } as AgentEvent);
    if (this.events.length > 1000) this.events.shift();
    for (const wake of this.waiters) wake(); this.waiters.clear();
  }
}
