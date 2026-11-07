// Explicit live-provider check; ordinary tests never call this file.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OpenCodeAdapter } from '@robotics-workbench/opencode';

async function main() {
  assert.ok(process.argv.includes('--live'), 'Explicit --live required.');
  const executable = process.argv[process.argv.indexOf('--executable') + 1];
  const model = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : 'openai/gpt-6.1-sol';
  assert.ok(process.argv.includes('--executable') && executable);
  const destination = resolve('artifacts/task05-opencode-live');
  const directory = join(destination, 'scratch space');
  await mkdir(directory, { recursive: true });
  const source = 'int twice(int n) { return n+n+1; }\n';
  const file = join(directory, 'fixture.cpp');
  await writeFile(file, source);
  const sourceHash = createHash('sha256').update(source).digest('hex');
  const projectId = randomUUID(), taskId = randomUUID(), packetId = randomUUID();
  const context = JSON.stringify({ schemaVersion: 1, packetId, projectId, projectRevision: 1, sourceSnapshotId: null, source: { path: 'fixture.cpp', sha256: sourceHash, text: source }, unknowns: ['No hardware measurements exist.'], allowedEffects: ['explanation'], forbiddenEffects: ['edits', 'hardware', 'tools'] });
  let adapter: OpenCodeAdapter | undefined;
  const result: Record<string, unknown> = { taskId: 'TASK-05', provider: 'opencode', executable, model, startedAt: new Date().toISOString(), sourceHash, tests: [] };
  try {
    adapter = await OpenCodeAdapter.launch({ executable, directory, contextText: async id => { assert.equal(id, packetId); return context; }, runtimeConfig: { permission: { '*': 'deny' } } });
    result.descriptor = await adapter.inspect();
    const session = await adapter.open({ projectId, taskId, projectRevision: 1, workspaceUri: pathToFileURL(directory).href, routeId: randomUUID(), model: { modelId: model, profileId: null }, permissionProfileId: 'read-only', resume: null });
    const turn = await adapter.submit({ clientTurnId: randomUUID(), session, projectRevision: 1, sourceSnapshotId: null, userText: 'Explain the off-by-one error in fixture.cpp and propose the correct implementation of twice. Do not use tools, edit files or access hardware. Use only the revision-stamped source supplied below.', contextPacketId: packetId, attachments: [], model: { modelId: model, profileId: null } });
    const deadline = Date.now() + 120_000;
    let snapshot;
    do {
      await new Promise(resolve => setTimeout(resolve, 500));
      snapshot = await adapter.reconcile(session);
    } while (snapshot.activeTurn && Date.now() < deadline);
    assert.equal(snapshot.latestTurnStatus, 'succeeded');
    const text = snapshot.messages.filter(message => message.role === 'assistant').map(message => message.text).join('\n');
    assert.match(text, /n\s*\+\s*n|2\s*\*\s*n|n\s*\*\s*2/);
    assert.match(text, /\+\s*1|extra|one|off.by.one/i);
    assert.equal(await readFile(file, 'utf8'), source);
    result.reply = text; result.session = session; result.turn = turn; result.snapshot = snapshot; result.disposition = 'passed';
    result.tests = ['owned-loopback-authenticated-start', 'schema-fingerprint', 'revision-stamped-context-debugging', 'source-bytes-preserved', 'authoritative-terminal-message'];
  } catch (error) { result.disposition = 'failed'; result.error = { code: (error as { code?: string }).code ?? 'ASSERTION', message: error instanceof assert.AssertionError ? error.message : 'Provider check failed; private diagnostics omitted.' }; process.exitCode = 1; }
  finally { await adapter?.close({ stopOwnedProcess: true }); result.endedAt = new Date().toISOString(); await writeFile(join(destination, 'result.json'), JSON.stringify(result, null, 2) + '\n'); }
  console.log(JSON.stringify({ disposition: result.disposition, destination, error: result.error }));
}
void main();
