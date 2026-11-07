import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { CompanionClient } from '../../apps/extension/src/companion-client';
import { ProjectFiles, validateContextPacket, type ContextPacket } from '@robotics-workbench/application';
import { checkArtifactCredentials } from '@robotics-workbench/persistence';
import { isRequestId, isRecoverySnapshot, validateManifest, type ProjectMethod, type ProviderDescriptor, type ProviderId, type RecoveryOperationSummary } from '@robotics-workbench/contracts';
import type { AgentRecord } from '@robotics-workbench/agents';

type Configuration = { projectRoot: string; dataRoot: string; companion: string; codex: string; opencode: string; live: boolean; diagnoseSnapshot: boolean };
type Answer = { projectId: string; projectRevision: number; projectName: string; supplyVoltageV: null; hardwareVerified: false; uploaderSuccessProvesPhysicalBehavior: false; privateHistoryTransferred: false };
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const delay = (durationMs: number) => new Promise(resolve => setTimeout(resolve, durationMs));

function configuration(args: string[]): Configuration {
  const fields: Record<string, string> = {}; let live = false, diagnoseSnapshot = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--live') { assert.equal(live, false, 'Duplicate --live flag.'); live = true; continue; }
    if (args[index] === '--diagnose-snapshot') { assert.equal(diagnoseSnapshot, false, 'Duplicate diagnostic flag.'); diagnoseSnapshot = true; continue; }
    assert.ok(['--project-root', '--data-root', '--companion', '--codex', '--opencode'].includes(args[index]), 'Unknown runner argument.');
    const key = args[index].slice(2), value = args[++index];
    assert.ok(value && !value.startsWith('--') && !fields[key], 'Missing or duplicate runner argument.'); fields[key] = value;
  }
  for (const key of ['project-root', 'data-root', 'companion', 'codex', 'opencode']) assert.ok(fields[key] && isAbsolute(fields[key]) && !/^\\\\|^\/\//.test(fields[key]), `${key} requires an explicit absolute local path.`);
  assert.ok(!live || !diagnoseSnapshot, 'Read-only snapshot diagnosis and live inference must be separate runs.');
  return { projectRoot: fields['project-root'], dataRoot: fields['data-root'], companion: fields.companion, codex: fields.codex, opencode: fields.opencode, live, diagnoseSnapshot };
}

function descriptor(value: unknown, providerId: ProviderId): ProviderDescriptor {
  const result = value as ProviderDescriptor;
  assert.ok(result && result.providerId === providerId && typeof result.executableVersion === 'string' && result.executableVersion.length > 0
    && typeof result.adapterVersion === 'string' && /^[a-f0-9]{64}$/.test(result.protocolFingerprint) && Array.isArray(result.capabilities)
    && ['ready', 'blocked', 'unknown'].includes(result.readiness) && Array.isArray(result.problems), 'Invalid observed provider descriptor.');
  return result;
}

function answer(text: string, expected: Pick<Answer, 'projectId' | 'projectRevision' | 'projectName'>): Answer {
  const stripped = text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1');
  const value = JSON.parse(stripped) as Answer;
  assert.deepEqual(Object.keys(value).sort(), ['projectId', 'projectRevision', 'projectName', 'supplyVoltageV', 'hardwareVerified', 'uploaderSuccessProvesPhysicalBehavior', 'privateHistoryTransferred'].sort(), 'Reply must be only the requested bounded JSON facts.');
  assert.equal(value.projectId, expected.projectId); assert.equal(value.projectRevision, expected.projectRevision); assert.equal(value.projectName, expected.projectName);
  assert.equal(value.supplyVoltageV, null, 'An unmeasured voltage must remain unknown.'); assert.equal(value.hardwareVerified, false);
  assert.equal(value.uploaderSuccessProvesPhysicalBehavior, false); assert.equal(value.privateHistoryTransferred, false);
  return value;
}

function selfTest(): void {
  const valid = { projectId: randomUUID(), projectRevision: 7, projectName: 'Synthetic parser fixture', supplyVoltageV: null, hardwareVerified: false, uploaderSuccessProvesPhysicalBehavior: false, privateHistoryTransferred: false } as Answer;
  assert.deepEqual(answer(JSON.stringify(valid), valid), valid);
  assert.deepEqual(answer('```json\n' + JSON.stringify(valid) + '\n```', valid), valid);
  assert.throws(() => answer(JSON.stringify({ ...valid, supplyVoltageV: 5 }), valid));
  assert.throws(() => answer(JSON.stringify({ ...valid, hardwareVerified: true }), valid));
  assert.throws(() => configuration(['--live', '--project-root', 'relative']));
  const base = resolve('artifacts');
  const parsed = configuration(['--project-root', base, '--data-root', base, '--companion', join(base, 'companion.js'), '--codex', join(base, 'codex.exe'), '--opencode', join(base, 'opencode.exe')]);
  assert.equal(parsed.live, false);
  assert.equal(parsed.diagnoseSnapshot, false);
  assert.equal(descriptor({ providerId: 'codex', executableVersion: 'fixture', adapterVersion: '1', protocolFingerprint: 'a'.repeat(64), capabilities: ['mcp'], readiness: 'blocked', problems: [] }, 'codex').readiness, 'blocked');
  assert.throws(() => descriptor({ providerId: 'opencode' }, 'codex'));
  console.log('TASK-11 live runner configuration, readiness and no-invented-measurement self-tests passed. No provider was launched.');
}

function safeError(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).slice(0, 2048);
  try { checkArtifactCredentials(Buffer.from(text)); return text; }
  catch { return 'Credential-like provider error content excluded. Use the provider-supported readiness/sign-in flow.'; }
}
function save(path: string, value: unknown): void {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  checkArtifactCredentials(bytes); writeFileSync(path, bytes);
}
function source(files: ProjectFiles) {
  const manifest = files.inspectManifest().manifest;
  const paths = new Set<string>();
  const privateName = /^(?:\.git|node_modules|\.robotics-workbench|\.codex|\.opencode|\.claude|\.config|\.aws|\.ssh|\.azure|\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx)|auth\.json|credentials(?:\..*)?)$/i;
  const visit = (path: string) => {
    if (path.split('/').some(part => privateName.test(part))) return;
    const full = files.resolvePath(path);
    if (statSync(full).isDirectory()) for (const name of readdirSync(full)) visit(path === '.' ? name : `${path}/${name}`);
    else paths.add(path);
    assert.ok(paths.size <= 10000, 'Protected source inventory exceeds its bound.');
  };
  for (const path of ['workbench.json', ...manifest.sketches.map(sketch => sketch.path), ...['components', 'telemetry', 'experiments', 'mechanical', 'schematic'].filter(path => existsSync(files.resolvePath(path, true)))]) visit(path);
  return files.snapshotSource({ paths: [...paths], host: () => ({ dirtyPaths: [] }) });
}

async function diagnoseSnapshot(options: Configuration): Promise<void> {
  const runId = randomUUID(), directory = resolve('verification/evidence/task11/providers/snapshot-diagnosis', runId); mkdirSync(directory, { recursive: true });
  const files = new ProjectFiles(options.projectRoot), manifest = files.inspectManifest().manifest, baseline = source(files);
  const result: Record<string, unknown> = { schemaVersion: 1, taskId: 'TASK-11', runId, testId: 'provider.snapshot-diagnosis', evidenceClass: 'actual-companion-read-only', startedAt: new Date().toISOString(), environment: { platform: platform(), release: release(), arch: arch(), node: process.version }, projectRoot: files.root, dataRoot: options.dataRoot, projectId: manifest.projectId, projectRevision: manifest.projectRevision, sourceSha256: baseline.sha256, companionSha256: hash(readFileSync(options.companion)), timings: [], stderr: [], result: 'running', limitations: ['Only companion hello and project.snapshot are requested. No provider path, inference, compile, upload or serial operation is configured.', 'The production read and shutdown deadlines remain unchanged. An extra bounded observation interval may reveal an attributable late response but never converts the timed-out request to passed.'] };
  const recordPath = join(directory, 'result.json'), retain = () => save(recordPath, result);
  const timed = async <T>(phase: string, action: () => Promise<T>): Promise<T> => {
    const start = performance.now(), timing: Record<string, unknown> = { phase, startedAt: new Date().toISOString(), result: 'running' }; (result.timings as unknown[]).push(timing); result.phase = phase; retain();
    try { const value = await action(); timing.result = 'passed'; return value; }
    catch (error) { timing.result = 'failed'; timing.error = safeError(error); throw error; }
    finally { timing.durationMs = performance.now() - start; timing.endedAt = new Date().toISOString(); retain(); }
  };
  const client = new CompanionClient(options.companion, process.execPath, line => { const logs = result.stderr as unknown[]; if (logs.length < 64) logs.push({ occurredAt: new Date().toISOString(), text: safeError(line) }); retain(); }, () => { result.disconnectedAt = new Date().toISOString(); retain(); }, { projectRoot: files.root, dataRoot: options.dataRoot });
  retain();
  try {
    const hello = await timed('hello', () => client.start()); result.hello = hello; result.pid = client.pid;
    const requestId = randomUUID(); result.snapshotRequestId = requestId;
    // Observe only attributable response metadata, never raw project/provider payloads.
    const child = (client as unknown as { child?: import('node:child_process').ChildProcess }).child;
    child?.on('message', (message: unknown) => { const response = message as { requestId?: string; error?: { code?: string } }; if (response.requestId === requestId) { result.snapshotResponseObservedAt = new Date().toISOString(); result.snapshotResponseCode = response.error?.code ?? 'result'; retain(); } });
    const snapshot = await timed('project.snapshot', () => client.requestProject({ schemaVersion: 1, requestId, projectId: manifest.projectId, method: 'project.snapshot', params: {} })) as { manifest: unknown; builds: unknown[] };
    const actual = validateManifest(snapshot.manifest); assert.equal(actual.projectId, manifest.projectId); assert.equal(actual.projectRevision, manifest.projectRevision); result.snapshot = { buildCount: snapshot.builds.length, bytes: Buffer.byteLength(JSON.stringify(snapshot)) }; result.result = 'passed';
  } catch (error) {
    result.result = 'failed'; result.error = safeError(error);
    await timed('bounded-late-response-observation', () => delay(20000));
  } finally {
    try { await timed('shutdown', () => client.stop()); result.companionExitObserved = true; } catch (error) {
      result.shutdownError = safeError(error); result.result = 'failed';
      const child = (client as unknown as { child?: import('node:child_process').ChildProcess }).child;
      if (child?.pid) {
        result.forcedStop = { pid: child.pid, reason: 'Bounded read-only diagnostic shutdown failed; this process has no provider or hardware operations.' };
        const closed = new Promise<boolean>(resolve => child.once('close', () => resolve(true))); child.kill('SIGKILL');
        result.forcedExitObserved = await Promise.race([closed, delay(2000).then(() => false)]);
      }
    }
    result.sourceAfterSha256 = source(files).sha256; result.sourceUnchanged = result.sourceAfterSha256 === baseline.sha256; assert.equal(result.sourceUnchanged, true, 'Read-only snapshot changed protected project input bytes.'); result.endedAt = new Date().toISOString(); retain();
    console.log(JSON.stringify({ result: result.result, evidence: recordPath, timings: result.timings }));
  }
  if (result.result !== 'passed') process.exitCode = 1;
}

async function main(): Promise<void> {
  if (process.argv.includes('--self-test')) { assert.equal(process.argv.length, 3); selfTest(); return; }
  const options = configuration(process.argv.slice(2));
  if (options.diagnoseSnapshot) { await diagnoseSnapshot(options); return; }
  assert.ok(options.live, 'Live provider inference requires the explicit --live flag.');
  for (const path of [options.companion, options.codex, options.opencode]) assert.ok(existsSync(path) && statSync(path).isFile(), 'Configured executable/companion was not found. No alternate route will be chosen.');
  assert.ok(existsSync(options.dataRoot) && statSync(options.dataRoot).isDirectory(), 'Use the existing persistent bench data directory.');
  const files = new ProjectFiles(options.projectRoot), initial = files.inspectManifest(), baselineSource = source(files);
  const projectId = initial.manifest.projectId, projectRevision = initial.manifest.projectRevision;
  const runId = randomUUID(), directory = resolve(`verification/evidence/task11/providers/${runId}`); mkdirSync(directory, { recursive: true });
  const suite: Record<string, unknown> = { schemaVersion: 1, taskId: 'TASK-11', runId, startedAt: new Date().toISOString(), appVersion: JSON.parse(readFileSync('package.json', 'utf8')).version,
    environment: { platform: platform(), release: release(), arch: arch(), node: process.version }, evidenceClass: 'live-provider', projectId, projectRevision,
    projectRoot: files.root, dataRoot: options.dataRoot, companionSha256: hash(readFileSync(options.companion)), runnerSha256: hash(readFileSync(resolve(process.argv[1]))),
    sourceSha256: baselineSource.sha256, repetitionsPerProvider: 3, runs: [], handoff: null,
    limitations: ['No new physical measurement, upload, build, serial write or source edit is authorized.', 'Provider-managed reasoning and private history are not inspected.', 'Codex normalizes MCP start events as mcpToolCall; exact private tool input/name is not exposed. The test requires one successful MCP observation plus exact project facts from its response.', 'Byte checks cover manifest, declared sketches and existing ordinary feature-source directories. Provider permission profiles and absence of mutating operation receipts are separate assertions.'] };
  suite.sourceDigest = hash(Buffer.from(JSON.stringify({ companionSha256: suite.companionSha256, runnerSha256: suite.runnerSha256 })));
  suite.sourceDigestScope = 'SHA256 of exact companion and live-runner byte digest JSON; firmware input identity is separately sourceSha256.';
  const rows = suite.runs as Record<string, unknown>[];
  let baselineOperations: RecoveryOperationSummary[] | undefined, handoffTaskId: string | undefined, lastCodexTaskId: string | undefined, fatal = false;
  const recordPath = join(directory, 'result.json'); save(recordPath, suite);
  for (const providerId of ['codex', 'opencode'] as const) {
    for (let repetition = 1; repetition <= 3 && !fatal; repetition++) {
      const taskId = randomUUID(), attemptId = randomUUID(), row: Record<string, unknown> = { attemptId, runId: attemptId, suiteRunId: runId, providerId, repetition, taskId, testId: `provider.task11-${providerId}-${repetition}`,
        startedAt: new Date().toISOString(), submitted: false, result: 'not-run', appVersion: suite.appVersion, sourceDigest: suite.sourceDigest, environment: suite.environment,
        dependencyVersions: { node: process.version }, evidenceClass: 'live-provider', commandOrProcedure: JSON.stringify([process.execPath, ...process.argv.slice(1)]) };
      rows.push(row);
      const client = new CompanionClient(options.companion, process.execPath, () => {}, () => {}, { projectRoot: files.root, dataRoot: options.dataRoot, codexPath: options.codex, opencodePath: options.opencode });
      const call = <T>(method: ProjectMethod, params: Record<string, unknown> = {}, expectedProjectRevision?: number) => client.requestProject({ schemaVersion: 1, requestId: randomUUID(), projectId, method, params, ...(expectedProjectRevision === undefined ? {} : { expectedProjectRevision }) }) as Promise<T>;
      const history = async () => {
        const operations: RecoveryOperationSummary[] = []; let cursor: string | null = null;
        do { const page: unknown = await call('recovery.inspect', cursor ? { cursor } : {}); assert.ok(isRecoverySnapshot(page)); operations.push(...page.operations); cursor = page.nextCursor; assert.ok(operations.length <= 10000, 'Bench operation history exceeds this runner bound.'); } while (cursor);
        return operations.sort((a, b) => a.operationId.localeCompare(b.operationId));
      };
      let active = false;
      try {
        const snapshot = await call<{ manifest: unknown; builds: { sourceSnapshotId: string; succeeded: boolean; sourceCurrent: boolean }[] }>('project.snapshot');
        const manifest = validateManifest(snapshot.manifest); assert.equal(manifest.projectId, projectId); assert.equal(manifest.projectRevision, projectRevision);
        assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 15 * 1024, 'The snapshot exceeds one bounded MCP result; retain that limitation instead of requesting unbounded context.');
        const before = await history(); baselineOperations ??= before;
        assert.ok(before.every(item => !['queued', 'running', 'awaiting-input'].includes(item.status)), 'Finish the physical bench before live-provider validation.');
        const observed = descriptor(await call('agent.inspect', { providerId }), providerId); row.descriptor = observed;
        row.dependencyVersions = { node: process.version, provider: observed.executableVersion, adapter: observed.adapterVersion, protocolFingerprint: observed.protocolFingerprint };
        if (observed.readiness !== 'ready' || !observed.capabilities.includes('mcp')) { row.result = 'blocked'; row.reason = 'The current provider path is not ready with MCP. No login, account or billing route was changed.'; continue; }
        let selection: ContextPacket['selection'] = null, pinnedIds: string[] = [];
        try {
          type Listed = { documentId: string; versions: { artifactSha256: string; extractorVersion: string; status: string; pageCount: number }[] };
          const documents = await call<Listed[]>('document.list');
          const selected = documents.flatMap(doc => doc.versions.filter(version => version.status === 'extracted' && version.pageCount > 0).map(version => ({ doc, version }))).at(-1);
          if (selected) {
            const citation = { documentId: selected.doc.documentId, artifactSha256: selected.version.artifactSha256, extractorVersion: selected.version.extractorVersion, page: 1 };
            await call('document.excerpt', citation); selection = { kind: 'document-page', ...citation, projectRevision };
          }
        } catch (error) { row.documentSelectionLimitation = safeError(error); }
        if (!selection && manifest.components.length) { const id = manifest.components[0].componentId; selection = { kind: 'component', id, revision: projectRevision }; pinnedIds = [id]; }
        row.selection = selection; row.pinnedIds = pinnedIds;
        if (!selection) row.selectionLimitation = 'No extracted document page or component selection was exposed. Numeric recording derivation IDs are not invented from raw capture IDs.';
        const sourceSnapshotId = snapshot.builds.findLast(item => item.succeeded && item.sourceCurrent && isRequestId(item.sourceSnapshotId))?.sourceSnapshotId ?? null;
        const userText = 'Read-only TASK-11 evidence check. Use the robotics project_snapshot MCP tool exactly once with a new UUID requestId and params {}. Use no other tools. Do not edit files, invoke a shell, compile, upload, open or write serial, or change any configuration. Read the project ID, projectRevision and project name from that snapshot result. Physical supply voltage has not been measured for this request; preserve that as unknown. Uploader success cannot verify physical behavior. Application-owned handoff does not transfer provider-private history. Reply with ONLY one JSON object, no commentary, containing exactly: projectId (observed string), projectRevision (observed integer), projectName (observed string), supplyVoltageV:null, hardwareVerified:false, uploaderSuccessProvesPhysicalBehavior:false, privateHistoryTransferred:false.';
        row.request = { taskId, clientTurnId: randomUUID(), providerId, modelId: providerId === 'codex' ? 'gpt-6.1-sol' : 'openai/gpt-6.1-sol', permissionProfileId: 'read-only', sourceSnapshotId, userText, selection, pinnedIds,
          ...(providerId === 'opencode' && handoffTaskId ? { handoffTaskId } : {}) };
        let latest = await call<AgentRecord>('agent.start', row.request as Record<string, unknown>, projectRevision); active = true; row.submitted = true;
        row.suppliedPacket = validateContextPacket(latest.packet); save(join(directory, `${providerId}-${repetition}.json`), row);
        const observedEvents = new Map(latest.events.filter(event => event.type !== 'agent.text.delta').map(event => [event.eventId, event]));
        const deadline = Date.now() + 180000;
        while (Date.now() < deadline) {
          latest = await call<AgentRecord>('agent.get', { taskId });
          for (const event of latest.events) if (event.type !== 'agent.text.delta') observedEvents.set(event.eventId, event);
          assert.equal(latest.pendingApprovals.length, 0, 'Unexpected permission request; this runner never grants approvals.');
          if (['succeeded', 'failed', 'cancelled', 'outcome-unknown'].includes(latest.task.status)) { active = false; break; }
          await delay(100);
        }
        row.finalTask = latest.task; row.providerOutcome = latest.providerOutcome; row.lastProblem = latest.lastProblem; row.messages = latest.messages; row.observedEvents = [...observedEvents.values()];
        assert.equal(latest.task.status, 'succeeded', 'Provider did not complete this bounded task successfully.');
        assert.equal(latest.task.projectId, projectId); assert.equal(latest.task.projectRevision, projectRevision); assert.deepEqual(latest.task.operationIds, []);
        const events = [...observedEvents.values()], starts = events.filter(event => event.type === 'agent.tool.started'), finished = events.filter(event => event.type === 'agent.tool.finished');
        assert.equal(starts.length, 1, 'Expected exactly one observable snapshot MCP tool call.'); assert.equal(finished.length, 1);
        assert.match(starts[0].payload.displayName, /mcpToolCall|project_snapshot/i, 'Unexpected non-snapshot/shell tool.');
        assert.equal(finished[0].payload.toolCallId, starts[0].payload.toolCallId); assert.equal(finished[0].payload.outcome, 'succeeded');
        const reply = latest.messages.filter(message => message.role === 'assistant' && message.text.trim()).at(-1)?.text; assert.ok(reply);
        row.checkedAnswer = answer(reply, { projectId, projectRevision, projectName: manifest.name });
        assert.equal(source(files).sha256, baselineSource.sha256, 'Protected ordinary project inputs changed during read-only inference.');
        const after = await history(); row.newUploadReceipts = after.filter(item => item.kind === 'upload' && !before.some(old => old.operationId === item.operationId)).map(item => item.operationId);
        assert.deepEqual(after.map(item => item.operationId), before.map(item => item.operationId), 'A read-only explanation created a hardware/build operation.'); assert.deepEqual(row.newUploadReceipts, []);
        if (providerId === 'codex') lastCodexTaskId = taskId;
        if (providerId === 'opencode' && handoffTaskId) {
          assert.ok(latest.packet.constraints.includes(`Handoff task: ${handoffTaskId}`));
          assert.ok(latest.packet.unknowns.some(text => /private.*not.*transfer/i.test(text))); row.applicationHandoffObserved = true;
        }
        row.result = 'passed';
        if (providerId === 'codex' && repetition === 3 && lastCodexTaskId) {
          const handoff = await call<{ checkpointId: string; context: ContextPacket; unknowns: string[] }>('agent.handoff', { taskId: lastCodexTaskId });
          validateContextPacket(handoff.context); assert.equal(handoff.context.projectId, projectId); assert.ok(handoff.unknowns.some(text => /physical|wiring/i.test(text)));
          suite.handoff = handoff; handoffTaskId = lastCodexTaskId;
        }
      } catch (error) {
        row.result = 'failed'; row.error = safeError(error);
        if (/inputs changed|created a hardware|Unexpected non-snapshot|exactly one observable|Unexpected permission/.test(String(row.error))) fatal = true;
      } finally {
        if (active) { try { row.interrupted = await call('agent.interrupt', { taskId }); } catch (error) { row.interruptError = safeError(error); } }
        if (baselineOperations) {
          try {
            const retained = await history(); row.newUploadReceipts = retained.filter(item => item.kind === 'upload' && !baselineOperations!.some(old => old.operationId === item.operationId)).map(item => item.operationId);
            assert.deepEqual(retained.map(item => item.operationId), baselineOperations.map(item => item.operationId), 'Read-only validation created an operation; stop further provider runs.');
          } catch (error) { row.boundaryCheckError = safeError(error); row.result = 'failed'; fatal = true; }
        }
        try { await client.stop(); row.companionExitObserved = true; } catch (error) { row.shutdownError = safeError(error); row.result = 'failed'; fatal = true; }
        try { assert.equal(source(files).sha256, baselineSource.sha256, 'Protected ordinary project inputs changed; stop further provider runs.'); }
        catch (error) { row.sourceCheckError = safeError(error); row.result = 'failed'; fatal = true; }
        row.endedAt = new Date().toISOString(); save(join(directory, `${providerId}-${repetition}.json`), row); save(recordPath, suite);
        console.log(JSON.stringify({ providerId, repetition, result: row.result, error: row.error ?? null, evidence: join(directory, `${providerId}-${repetition}.json`) }));
      }
    }
  }
  suite.endedAt = new Date().toISOString(); suite.fatalInvariantFailure = fatal;
  suite.result = rows.length === 6 && rows.every(row => row.result === 'passed') && !!suite.handoff ? 'passed' : 'failed';
  save(recordPath, suite); console.log(JSON.stringify({ result: suite.result, evidence: recordPath }));
  if (suite.result !== 'passed') process.exitCode = 1;
}
main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
