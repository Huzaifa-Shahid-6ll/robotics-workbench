import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { languagePlan } from '../src/language-plan';

test('language tools use exact installed files, selected sketch/FQBN/options and argument arrays', () => {
  const root = mkdtempSync(join(tmpdir(), 'language-plan-'));
  try {
    mkdirSync(join(root, 'Sketch with spaces')); const executable = join(root, 'installed tools.exe'); writeFileSync(executable, 'fixture');
    const tools = { server: executable, clangd: executable, cli: executable, config: executable };
    const sketch = { path: 'Sketch with spaces', targetId: 'target' }, target = { targetId: 'target', fqbn: 'arduino:avr:uno', options: { cpu: 'atmega328' } };
    const plan = languagePlan(root, sketch, target, tools);
    assert.equal(plan.command, executable); assert.equal(plan.cwd, join(root, sketch.path));
    assert.deepEqual(plan.args, ['-clangd', executable, '-cli', executable, '-cli-config', executable, '-fqbn', 'arduino:avr:uno:cpu=atmega328']);
    assert.throws(() => languagePlan(root, { ...sketch, path: '..' }, target, tools), { code: 'UNAUTHORIZED_SCOPE' });
    assert.throws(() => languagePlan(root, sketch, { ...target, options: { cpu: 'bad,other=value' } }, tools), { code: 'INVALID_REQUEST' });
    assert.throws(() => languagePlan(root, sketch, target, { ...tools, server: 'relative.exe' }), { code: 'TOOL_UNAVAILABLE' });
    assert.throws(() => languagePlan(root, sketch, target, { ...tools, config: join(root, 'missing.yaml') }), { code: 'TOOL_UNAVAILABLE' });
    assert.throws(() => languagePlan(root, sketch, target, { ...tools, server: root }), { code: 'TOOL_UNAVAILABLE' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
