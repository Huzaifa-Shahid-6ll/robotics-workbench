import { glob } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const tests = [];
for await (const file of glob(['packages/**/test/*.test.ts', 'apps/**/test/*.test.ts'], { exclude: ['**/node_modules/**', '**/dist/**'] })) {
  tests.push(`artifacts/tests/${file.replaceAll('\\', '/').replace(/\.ts$/, '.cjs')}`);
}
if (!tests.length) throw new Error('No built tests found. Run npm run build.');
const result = spawnSync(process.execPath, ['--test', ...tests.sort()], { stdio: 'inherit', windowsHide: true,
  env: { ...process.env, DOCUMENT_WORKER_PATH: resolve('apps/extension/dist/documents-worker.cjs') } });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
if (process.exitCode === 0) {
  const output = resolve('artifacts/controller-audits', randomUUID());
  const env = { ...process.env,
    WORKBENCH_READINESS_AUDIT_EVIDENCE_ROOT: resolve(output, 'readiness'),
    WORKBENCH_READINESS_AUDIT_NAME: 'result.json',
    WORKBENCH_CONTROLLER_AUDIT_EVIDENCE_ROOT: resolve(output, 'engineering') };
  for (const script of ['scripts/ui/controller-readiness-audit.cjs', 'scripts/engineering/controller-audit.cjs']) {
    const audit = spawnSync(process.execPath, [script], { stdio: 'inherit', windowsHide: true, env });
    if (audit.error) throw audit.error;
    if (audit.status !== 0) { process.exitCode = audit.status ?? 1; break; }
  }
}
