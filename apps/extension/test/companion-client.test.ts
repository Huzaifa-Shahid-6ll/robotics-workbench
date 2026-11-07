import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { CompanionClient } from '../src/companion-client';
import { isControlResponse } from '@robotics-workbench/contracts';

const script = resolve('apps/extension/dist/companion.js');
test('real Windows companion handshake, invalid request isolation, second owner refusal, shutdown and reconnect', async () => {
  const logs: string[] = [];
  const client = new CompanionClient(script, process.execPath, line => logs.push(line));
  try {
    const [hello, duplicate] = await Promise.all([client.start(), client.start()]);
    assert.deepEqual(hello, duplicate);
    assert.equal(hello.state, 'ready');
    assert.ok(client.pid);
    const second = new CompanionClient(script, process.execPath, line => logs.push(line));
    await assert.rejects(second.start());
    assert.ok(logs.some(line => line.includes('DEVICE_BUSY')));
    const pid = client.pid!;
    await client.stop();
    assert.throws(() => process.kill(pid, 0));
    assert.equal((await client.start()).state, 'ready');
  } finally { await client.stop(); }

  const child = fork(script, [], { execArgv: [], silent: true });
  try {
    const response = once(child, 'message');
    child.send({ schemaVersion: 99, requestId: randomUUID(), method: 'companion.hello', params: {} });
    const [message] = await response;
    assert.ok(isControlResponse(message));
    assert.equal(message.error?.code, 'UNSUPPORTED_SCHEMA');
    const exit = once(child, 'exit');
    const pid = child.pid!;
    child.disconnect();
    const [code] = await exit;
    assert.equal(code, 0);
    assert.throws(() => process.kill(pid, 0));
  } finally { if (child.exitCode === null) child.kill(); }
});

test('missing runtime fails without leaving a child', async () => {
  const client = new CompanionClient(script, resolve('artifacts/missing-node.exe'), () => {});
  await assert.rejects(client.start(), /ENOENT/);
  await client.stop();
  assert.equal(client.pid, undefined);
});
