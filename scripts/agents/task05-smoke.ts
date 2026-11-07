import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectService } from '../../apps/companion/src/project-service';
import { HardwareService } from '../../apps/companion/src/hardware-service';
import { AgentService } from '../../apps/companion/src/agent-service';
import type { ProjectMethod } from '@robotics-workbench/contracts';
import type { AgentRecord } from '@robotics-workbench/agents';

async function main() {
  const providerId = process.argv[2] as 'codex' | 'opencode';
  assert.ok(['codex', 'opencode'].includes(providerId));
  const executable = process.argv[3]; assert.ok(executable);
  const temporary = mkdtempSync(join(tmpdir(), 'robotics-agent-service-'));
  const root = join(temporary, 'Probe'); mkdirSync(root);
  const projectId = randomUUID(), targetId = randomUUID();
  writeFileSync(join(root, 'workbench.json'), JSON.stringify({ schemaVersion: 1, projectId, projectRevision: 1, name: 'Agent service debugging fixture', sketches: [{ path: '.', targetId }], targets: [{ targetId, fqbn: 'arduino:avr:uno', options: {} }], components: [], nets: [], codeBindings: [], documents: [], extensions: {} }));
  const source = 'int twice(int n) { return n+n+1; }\nvoid setup() {}\nvoid loop() {}\n';
  writeFileSync(join(root, 'Probe.ino'), source);
  const project = new ProjectService(root, join(temporary, 'data'));
  const hardware = new HardwareService(project, '');
  const agents = new AgentService(project, hardware, { codexPath: providerId === 'codex' ? executable : '', opencodePath: providerId === 'opencode' ? executable : '', nodePath: process.execPath, mcpScript: resolve('apps/extension/dist/mcp-stdio.js') });
  const call = async (method: ProjectMethod, params: Record<string, unknown>, expectedProjectRevision?: number) => {
    const response = await agents.handle({ schemaVersion: 1, requestId: randomUUID(), projectId, method, params, ...(expectedProjectRevision ? { expectedProjectRevision } : {}) });
    assert.ok(!response.error, JSON.stringify(response.error)); return response.result;
  };
  const taskId = randomUUID();
  const record: Record<string, unknown> = { taskId: 'TASK-05', providerId, startedAt: new Date().toISOString(), temporary, checks: [] };
  try {
    record.descriptor = await call('agent.inspect', { providerId });
    await call('agent.start', { taskId, clientTurnId: randomUUID(), providerId, modelId: providerId === 'codex' ? 'gpt-6.1-sol' : 'openai/gpt-6.1-sol', permissionProfileId: 'read-only', sourceSnapshotId: null,
      userText: 'Use the robotics project_snapshot MCP tool exactly once with a new UUID requestId and params {}. Then explain the off-by-one in int twice(int n) { return n+n+1; } and propose its corrected implementation. Do not edit source, run shell commands, compile, upload, or use hardware. State the observed projectRevision and project name from the tool.' }, 1);
    let result: AgentRecord | undefined;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      result = await call('agent.get', { taskId }) as AgentRecord;
      if (['succeeded', 'failed', 'cancelled', 'outcome-unknown'].includes(result.task.status)) break;
      if (result.pendingApprovals.length) throw Error('Unexpected approval: ' + result.pendingApprovals[0].action);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.equal(result?.task.status, 'succeeded', JSON.stringify(result));
    record.reply = result.messages.filter(item => item.role === 'assistant').map(item => item.text).join('\n');
    assert.match(String(record.reply), /n\s*\+\s*n|2\s*\*\s*n|n\s*\*\s*2/);
    assert.match(String(record.reply), /Agent service debugging fixture/);
    assert.equal(readFileSync(join(root, 'Probe.ino'), 'utf8'), source);
    const events = project.store.eventsSince(projectId, 0, project.store.epoch, 500).events;
    record.events = events;
    assert.ok(events.some(event => event.type === 'agent.tool.finished'), 'Expected real MCP tool completion observation.');
    record.sourceSha256 = createHash('sha256').update(source).digest('hex'); record.status = 'passed'; record.endedAt = new Date().toISOString();
  } catch (error) { record.status = 'failed'; record.error = String(error); process.exitCode = 1; }
  finally { await agents.close(); await project.shutdown(); }
  const output = `verification/evidence/task-05/integration-${providerId}`; mkdirSync(output, { recursive: true }); writeFileSync(join(output, 'result.json'), JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify({ providerId, status: record.status, error: record.error }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
