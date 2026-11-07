import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { WorkbenchError, type WorkbenchManifest } from '@robotics-workbench/contracts';

export function languagePlan(root: string, sketch: WorkbenchManifest['sketches'][number], target: WorkbenchManifest['targets'][number], tools: { server: string; clangd: string; cli: string; config: string }) {
  const scope = realpathSync(root), cwd = realpathSync(resolve(scope, sketch.path));
  const rel = relative(scope, cwd);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Sketch leaves the project root.');
  for (const [name, path] of Object.entries(tools)) {
    let valid = false;
    try { valid = isAbsolute(path) && statSync(path).isFile(); } catch { /* Missing/inaccessible optional tools do not prevent ordinary editing. */ }
    if (!valid) throw new WorkbenchError('TOOL_UNAVAILABLE', `Configure an absolute installed ${name} file.`);
  }
  if (!/^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(target.fqbn) || sketch.targetId !== target.targetId) throw new WorkbenchError('INVALID_REQUEST', 'Language service needs the sketch’s explicit base FQBN.');
  const options = Object.entries(target.options).sort().map(([key, value]) => {
    if (!/^[A-Za-z0-9_-]+$/.test(key) || !/^[A-Za-z0-9_.-]+$/.test(value)) throw new WorkbenchError('INVALID_REQUEST', 'Invalid board option.');
    return `${key}=${value}`;
  });
  return { command: tools.server, args: ['-clangd', tools.clangd, '-cli', tools.cli, '-cli-config', tools.config, '-fqbn', target.fqbn + (options.length ? ':' + options.join(',') : '')], cwd };
}
