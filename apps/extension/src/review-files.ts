import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { WorkbenchError } from '@robotics-workbench/contracts';
import { assertSafeAgentText } from '@robotics-workbench/application';

export const REVIEW_FILE_BYTES = 128 * 1024;
export const reviewHash = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex');
export function reviewPath(root: string, path: string, missing = false): string {
  if (!path || path.includes('\\') || /[:<>"|?*\x00-\x1f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part))) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Review paths must remain normalized inside this project.');
  if (privateFile.test(path) || path.split('/').some(part => directories.has(part) || part === '.codex' || part === '.opencode')) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Private configuration and generated/dependency directories are excluded from source review.');
  const canonicalRoot = realpathSync(root);
  let current = canonicalRoot;
  for (const part of path.split('/')) {
    current = join(current, part);
    if (!existsSync(current)) { if (missing) continue; throw new WorkbenchError('NOT_FOUND', 'Reviewed source is missing.'); }
    const info = lstatSync(current);
    if (info.isSymbolicLink() || info.isFile() && info.nlink !== 1) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Linked review paths require explicit reconciliation.');
    const scoped = relative(canonicalRoot, realpathSync(current));
    if (isAbsolute(scoped) || scoped === '..' || scoped.startsWith(`..${sep}`)) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Review path leaves its project.');
  }
  return current;
}
export function reviewText(root: string, path: string): { text: string; sha256: string } | null {
  const full = reviewPath(root, path, true);
  if (!existsSync(full)) return null;
  const fd = openSync(full, 'r');
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(REVIEW_FILE_BYTES)) throw new WorkbenchError('INVALID_REQUEST', 'Review retains at most 128 KiB per ordinary text file.');
    const bytes = readFileSync(fd); const after = fstatSync(fd, { bigint: true });
    if (bytes.length > REVIEW_FILE_BYTES || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new WorkbenchError('REVISION_CONFLICT', 'Source changed during review capture.');
    reviewPath(root, path);
    const text = bytes.toString('utf8');
    if (text.includes('\0') || !Buffer.from(text).equals(bytes)) throw new WorkbenchError('CAPABILITY_UNSUPPORTED', 'Binary or non-UTF-8 source requires external artifact review.');
    assertSafeAgentText(text);
    return { text, sha256: reviewHash(bytes) };
  } finally { closeSync(fd); }
}
const directories = new Set(['.git', '.robotics-workbench', '.codex', '.opencode', 'node_modules', 'dist', 'artifacts', '.venv', '.venv-validation']);
const supported = /\.(ino|c|cpp|cxx|cc|h|hpp|hxx|hh|json|md|txt|py|kicad_sch|kicad_pcb)$/i;
const privateFile = /(^|\/)(\.env(?:\..*)?|auth\.json|credentials(?:\..*)?|id_rsa|id_ed25519)$|\.(pem|key|p12|pfx)$/i;
export function reviewInventory(root: string): { paths: string[]; omitted: { path: string; reason: string }[] } {
  const paths: string[] = [], omitted: { path: string; reason: string }[] = [];
  const walk = (path: string): void => {
    const full = path ? reviewPath(root, path) : realpathSync(root);
    for (const entry of readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path ? `${path}/${entry.name}` : entry.name;
      if (entry.isDirectory() && directories.has(entry.name)) { if (entry.name === '.codex' || entry.name === '.opencode') omitted.push({ path: name, reason: 'Provider configuration is excluded from source review.' }); continue; }
      if (privateFile.test(name)) { omitted.push({ path: name, reason: 'Private credential path excluded from review.' }); continue; }
      if (paths.length + omitted.length >= 256) { if (omitted.length < 100) omitted.push({ path: name, reason: 'Review inventory limit reached; inspect further files outside this preview.' }); return; }
      if (entry.isSymbolicLink()) { omitted.push({ path: name, reason: 'Linked file/directory is not followed.' }); continue; }
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile() && supported.test(name)) paths.push(name);
    }
  };
  walk(''); return { paths, omitted: omitted.slice(0, 100) };
}
export function minimalReviewEdit(current: string, next: string): { start: number; end: number; text: string } {
  let start = 0;
  while (start < current.length && start < next.length && current[start] === next[start]) start++;
  let end = current.length, nextEnd = next.length;
  while (end > start && nextEnd > start && current[end - 1] === next[nextEnd - 1]) { end--; nextEnd--; }
  return { start, end, text: next.slice(start, nextEnd) };
}
