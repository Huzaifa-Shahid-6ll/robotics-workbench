// Explicit live-provider spike. Ordinary build/test/verify commands never submit turns.
import { createOpencodeClient } from '@opencode-ai/sdk/client';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { once } from 'node:events';

const arguments_ = process.argv.slice(2);
const executable = arguments_[arguments_.indexOf('--executable') + 1];
assert.ok(arguments_.includes('--executable') && executable);
const live = arguments_.includes('--live');
const selectedModel = arguments_.includes('--model') ? arguments_[arguments_.indexOf('--model')+1] : undefined;
const inspectSession = arguments_.includes('--inspect-session') ? arguments_[arguments_.indexOf('--inspect-session')+1] : undefined;
assert.ok(!(inspectSession && live));
const destination = resolve('artifacts/compatibility/lifecycle');
const scratch = join(destination, 'OpenCode scratch space');
await mkdir(scratch, { recursive: true });
const password = randomBytes(32).toString('hex');
const env = {};
for (const key of ['SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','HOME','APPDATA','LOCALAPPDATA','PATH','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME','OPENCODE_CONFIG','OPENCODE_CONFIG_CONTENT']) {
  if (process.env[key]) env[key] = process.env[key];
}
env.OPENCODE_SERVER_PASSWORD = password;
env.OPENCODE_SERVER_USERNAME = 'opencode';
const server = spawn(executable, ['serve', '--hostname', '127.0.0.1', '--port', '0', '--pure'], {
  cwd: scratch, env, stdio: ['ignore','pipe','ignore'], windowsHide: true
});
const closed = once(server, 'close');
const record = { gateId: 'VG-03', startedAt: new Date().toISOString(), executablePath: executable,
  version: spawnSync(executable, ['--version'], { encoding: 'utf8' }).stdout.trim(), sdkVersion: '1.18.32',
  liveRequested: live, turnsSubmitted: 0, plugins: 'pure; external plugins disabled for selected bounded path', events: [] };
let streamController;
let createdSession;
let client;
try {
  const endpoint = await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('Loopback startup timeout')), 30000);
    let output = '';
    server.stdout.on('data', bytes => {
      output = (output + bytes).slice(-4096);
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); accept(match[0]); }
    });
    server.once('error', reject);
    server.once('close', () => { clearTimeout(timer); reject(new Error('Server exited before readiness')); });
  });
  const makeClient = () => createOpencodeClient({ baseUrl: endpoint, directory: scratch,
    headers: { Authorization: 'Basic '+Buffer.from('opencode:'+password).toString('base64') },
    throwOnError: true,
    fetch: request => fetch(request, { signal: request.signal.aborted ? request.signal : AbortSignal.any([request.signal, AbortSignal.timeout(120000)]) })
  });
  client = makeClient();
  const config = (await client.config.get()).data;
  const providers = (await client.provider.list()).data;
  assert.ok(config && providers && Array.isArray(providers.connected));
  record.configuredModel = config.model ?? null;
  record.connectedProviders = providers.connected;
  record.defaultModelIds = Object.fromEntries(providers.connected.map(id => [id, providers.default[id]]));
  record.openaiMatchingModels = Object.keys(providers.all.find(provider => provider.id === 'openai')?.models ?? {}).filter(id => id.includes('6.1-sol'));
  const doc = await fetch(endpoint+'/doc', { headers: { Authorization: 'Basic '+Buffer.from('opencode:'+password).toString('base64') } }).then(response => response.json());
  record.openapiSha256 = createHash('sha256').update(JSON.stringify(doc)).digest('hex');
  if (inspectSession) {
    const messages = (await client.session.messages({ path: { id: inspectSession } })).data;
    record.diagnosedSessionId = inspectSession;
    record.messageDiagnostics = messages.filter(message => message.info.role === 'assistant').map(message => ({
      id: message.info.id, finish: message.info.finish, errorName: message.info.error?.name,
      errorMessage: String(message.info.error?.data?.message ?? '').replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/g, '[redacted]').slice(0, 400),
      partTypes: message.parts.map(part => part.type)
    }));
    record.disposition = 'not-run';
  } else if (!live) record.disposition = 'not-run';
  else {
    let route = selectedModel ?? config.model;
    if (!route && providers.connected.length === 1) {
      const providerID = providers.connected[0];
      if (providers.default[providerID]) route = `${providerID}/${providers.default[providerID]}`;
    }
    assert.ok(route, 'No unambiguous existing model route; choose one before inference');
    const slash = route.indexOf('/');
    const model = { providerID: route.slice(0, slash), modelID: route.slice(slash+1) };
    assert.ok(slash > 0 && providers.connected.includes(model.providerID), 'Configured route is not connected; no fallback selected');
    assert.ok(providers.all.find(provider => provider.id === model.providerID)?.models?.[model.modelID], 'Requested test model is absent from installed provider catalog');
    record.route = model;
    console.log('Using existing OpenCode route: '+route);
    const tools = (await client.tool.ids()).data;
    assert.ok(Array.isArray(tools));
    const deniedTools = Object.fromEntries(tools.map(name => [name, false]));
    const session = (await client.session.create({ body: { title: 'Robotics Workbench compatibility probe' } })).data;
    assert.ok(session?.id);
    createdSession = session.id;
    record.sessionId = session.id;
    const path = { id: session.id };
    streamController = new AbortController();
    const stream = await client.event.subscribe({ signal: streamController.signal, sseMaxRetryAttempts: 0 });
    const observed = [];
    const observing = (async () => {
      try { for await (const event of stream.stream) {
        if (event.properties?.sessionID === session.id || event.properties?.info?.sessionID === session.id || event.properties?.part?.sessionID === session.id) {
          observed.push(event);
          record.events.push({ type: event.type, sessionID: session.id });
        }
      } } catch (error) { if (!streamController.signal.aborted) throw error; }
    })();
    const first = (await client.session.prompt({ path, body: { model, tools: deniedTools,
      parts: [{ type: 'text', text: 'Reply with exactly WORKBENCH_COMPAT_OK. Do not use any tools or read files.' }] } })).data;
    record.turnsSubmitted++;
    record.firstReply = { finish: first?.info?.finish, errorName: first?.info?.error?.name, partTypes: first?.parts?.map(part => part.type) };
    assert.ok(first?.info?.role === 'assistant');
    assert.ok(first.parts.some(part => part.type === 'text' && part.text.includes('WORKBENCH_COMPAT_OK')), 'No attributable text reply');
    record.completedMessageId = first.info.id;
    record.firstMessageFinish = first.info.finish;
    await client.session.promptAsync({ path, body: { model, tools: deniedTools,
      parts: [{ type: 'text', text: 'Write the numbers 1 to 1000, one per line. Do not use tools.' }] } });
    record.turnsSubmitted++;
    const deadline = Date.now()+10000;
    while (Date.now() < deadline) {
      const statuses = (await client.session.status()).data;
      if (statuses?.[session.id]?.type === 'busy') break;
      await new Promise(accept => setTimeout(accept, 50));
    }
    assert.equal((await client.session.status()).data?.[session.id]?.type, 'busy', 'Active turn not observed before abort');
    assert.equal((await client.session.abort({ path })).data, true);
    streamController.abort();
    await observing;
    client = makeClient();
    const resumed = (await client.session.get({ path })).data;
    assert.equal(resumed.id, session.id);
    const messages = (await client.session.messages({ path })).data;
    const users = messages.filter(message => message.info.role === 'user');
    assert.equal(users.length, 2, 'Reconnect must not submit duplicate messages');
    record.userMessageIdsAfterReconnect = users.map(message => message.info.id);
    record.interruptedMessages = messages.filter(message => message.info.role === 'assistant' && message.info.error).map(message => ({ id: message.info.id, error: message.info.error.name }));
    assert.ok(record.interruptedMessages.some(message => message.error === 'MessageAbortedError'), 'Abort acknowledgement alone is insufficient');
    const secondController = new AbortController();
    const reconnected = await client.event.subscribe({ signal: secondController.signal, sseMaxRetryAttempts: 0 });
    const iterator = reconnected.stream[Symbol.asyncIterator]();
    const next = await iterator.next();
    assert.ok(!next.done);
    secondController.abort();
    await iterator.return();
    assert.ok(record.events.some(event => event.type.startsWith('message.')), 'No session-bound activity observed');
    record.disposition = 'passed';
  }
} catch (error) {
  record.disposition = 'failed';
  record.errorType = error.name;
  record.error = error instanceof assert.AssertionError ? error.message : 'Provider/API operation failed; private payload omitted.';
} finally {
  streamController?.abort();
  if (createdSession && client) {
    try { await client.session.abort({ path: { id: createdSession } }); } catch {}
  }
  server.kill();
  await closed;
  record.processExitObserved = true;
  record.endedAt = new Date().toISOString();
  await writeFile(join(destination, 'opencode.json'), JSON.stringify(record, null, 2)+'\n');
}
console.log(JSON.stringify({ disposition: record.disposition, configuredModel: record.configuredModel, connectedProviders: record.connectedProviders, route: record.route, error: record.error }));
assert.notEqual(record.disposition, 'failed', 'OpenCode compatibility did not pass; see safe report.');
