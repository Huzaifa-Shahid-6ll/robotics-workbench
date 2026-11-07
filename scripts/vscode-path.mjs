import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function vscodePath() {
  const candidates = [process.env.WORKBENCH_VSCODE_EXECUTABLE,
    join(process.env.LOCALAPPDATA ?? '', 'Programs/Microsoft VS Code/Code.exe'),
    join(process.env.ProgramFiles ?? '', 'Microsoft VS Code/Code.exe')];
  const found = candidates.find(path => path && existsSync(path));
  if (!found) throw new Error('Set WORKBENCH_VSCODE_EXECUTABLE to the existing Code.exe path.');
  return found;
}
