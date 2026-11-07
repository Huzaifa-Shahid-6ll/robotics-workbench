import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import * as fs from 'node:fs/promises';
import { ProjectFiles, type SourceSnapshot, type SourceFile, type ProcessRunner, type ProcessResult, type ProcessSpec } from '@robotics-workbench/application';
import { isRequestId, WorkbenchError } from '@robotics-workbench/contracts';

export type ToolchainInspection = {
  schemaVersion: 1; executablePath: string; executableSha256: string; version: string; checkedAt: string;
  configuration: { directories: { data: string; user: string; downloads: string } };
  cores: { id: string; version: string }[]; libraries: unknown[];
  capabilities: { compileJson: true; exactFileUpload: true; supportedUploadFqbns: readonly string[] };
  helpSha256: { compile: string; upload: string };
};
export type DiscoveredPort = { address: string; protocol: 'serial'; label: string; properties: Record<string, string>; matchingBoards: { name: string; fqbn: string }[] };
export type CompileDiagnostic = { path: string | null; line: number | null; column: number | null; severity: 'error' | 'warning' | 'information'; message: string; sourceSnapshotId: string };
export type InputTree = { path: string; sha256: string; files: number; sizeBytes: number };
export type BuildOutput = { path: string; sha256: string; sizeBytes: number; mediaType: string };
export type CompileResult = {
  succeeded: boolean; sourceSnapshotId: string; inputFingerprint: string; sourceSha256: string;
  fqbn: string; boardOptions: Record<string, string>; warnings: 'none' | 'default' | 'more' | 'all';
  toolchain: ToolchainInspection; buildProperties: Record<string, string>; libraryInputs: InputTree[];
  diagnostics: CompileDiagnostic[]; outputs: BuildOutput[]; uploadArtifact?: BuildOutput;
  process: ProcessResult; limitations: string[]; operationDirectory: string;
};
export type BuildResult = CompileResult;
export type CompileInput = { snapshot: SourceSnapshot; sketchRelativePath: string; rootSketchName?: string; fqbn: string; boardOptions: Record<string, string>; warnings?: 'none' | 'default' | 'more' | 'all'; signal?: AbortSignal };
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}` : JSON.stringify(value);
function fail(code: string, message: string): never { throw new WorkbenchError(code, message); }
function string(value: unknown, maximum = 32768): string { if (typeof value !== 'string' || value.length > maximum) return fail('INVALID_REQUEST', 'Arduino CLI returned an invalid string field.'); return value; }
function json(result: ProcessResult): Record<string, unknown> {
  if (result.stdoutTruncated || result.logsTruncated) return fail('INVALID_REQUEST', 'Arduino JSON exceeded the bounded parser; inspect retained logs.');
  try { const value: unknown = JSON.parse(result.stdout); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); return value as Record<string, unknown>; }
  catch { return fail('INVALID_REQUEST', 'Arduino CLI returned malformed JSON; no prior artifact will be substituted.'); }
}
function successful(result: ProcessResult, action: string): void {
  if (!result.terminationObserved) fail('OUTCOME_UNKNOWN', `${action} termination was not observed.`);
  if (result.cancelled) fail('CANCELLED', `${action} was interrupted after observed termination.`);
  if (result.timedOut) fail('TIMEOUT', `${action} exceeded its execution deadline.`);
  if (result.exitCode !== 0) fail('TOOL_UNAVAILABLE', `${action} failed; inspect its retained process diagnostics.`);
}
function contained(root: string, path: string): boolean { const part = relative(root, path); return !part || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)); }
function hashFile(path: string): string {
  const info = lstatSync(path); if (!info.isFile() || info.isSymbolicLink()) return fail('UNAUTHORIZED_SCOPE', 'Tool input must be an ordinary file.');
  const handle = openSync(path, 'r');
  try {
    const before = fstatSync(handle, { bigint: true }), digest = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    let count: number; while ((count = readSync(handle, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, count));
    const after = fstatSync(handle, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail('REVISION_CONFLICT', 'A toolchain input changed while hashing.');
    return digest.digest('hex');
  } finally { closeSync(handle); }
}
export function fingerprintTree(path: string): InputTree {
  const root = realpathSync(path); if (!statSync(root).isDirectory() || lstatSync(path).isSymbolicLink()) return fail('UNAUTHORIZED_SCOPE', 'Library and platform inputs must be ordinary directories.');
  const files: { path: string; sha256: string; sizeBytes: number }[] = []; let bytes = 0;
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['.git', '.svn'].includes(entry.name)) continue;
      const child = join(directory, entry.name), info = lstatSync(child);
      if (info.isSymbolicLink()) fail('UNAUTHORIZED_SCOPE', 'Linked toolchain input needs explicit scope before compilation.');
      if (info.isDirectory()) visit(child);
      else if (info.isFile()) {
        bytes += info.size;
        if (bytes > 2 * 1024 ** 3 || files.length >= 100000) fail('INVALID_REQUEST', 'Toolchain inventory exceeds the 2 GiB / 100,000-file bound.');
        files.push({ path: relative(root, child).replaceAll('\\', '/'), sha256: hashFile(child), sizeBytes: info.size });
      } else fail('UNAUTHORIZED_SCOPE', 'Unsupported non-file toolchain input.');
    }
  };
  visit(root); return { path: root, sha256: sha(stable(files)), files: files.length, sizeBytes: bytes };
}
export async function fingerprintTreeAsync(path: string, signal?: AbortSignal): Promise<InputTree> {
  const cancelled = () => { if (signal?.aborted) fail('CANCELLED', 'Toolchain input inspection was cancelled before further execution.'); };
  cancelled();
  const root = await fs.realpath(path);
  if (!(await fs.stat(root)).isDirectory() || (await fs.lstat(path)).isSymbolicLink()) fail('UNAUTHORIZED_SCOPE', 'Library and platform inputs must be ordinary directories.');
  const files: { path: string; sha256: string; sizeBytes: number }[] = []; let bytes = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      cancelled(); if (['.git', '.svn'].includes(entry.name)) continue;
      const child = join(directory, entry.name), info = await fs.lstat(child);
      if (info.isSymbolicLink()) fail('UNAUTHORIZED_SCOPE', 'Linked toolchain input needs explicit scope before compilation.');
      if (info.isDirectory()) { await visit(child); continue; }
      if (!info.isFile()) fail('UNAUTHORIZED_SCOPE', 'Unsupported non-file toolchain input.');
      bytes += info.size;
      if (bytes > 2 * 1024 ** 3 || files.length >= 100000) fail('INVALID_REQUEST', 'Toolchain inventory exceeds the 2 GiB / 100,000-file bound.');
      const handle = await fs.open(child, 'r');
      try {
        const before = await handle.stat({ bigint: true }), digest = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
        while (true) { cancelled(); const read = await handle.read(buffer, 0, buffer.length, null); if (!read.bytesRead) break; digest.update(buffer.subarray(0, read.bytesRead)); }
        const after = await handle.stat({ bigint: true });
        if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail('REVISION_CONFLICT', 'A toolchain input changed while hashing.');
        files.push({ path: relative(root, child).replaceAll('\\', '/'), sha256: digest.digest('hex'), sizeBytes: info.size });
      } finally { await handle.close(); }
    }
  };
  await visit(root); cancelled(); return { path: root, sha256: sha(stable(files)), files: files.length, sizeBytes: bytes };
}
function boardArguments(fqbn: string, options: Record<string, string>): string[] {
  if (!/^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(fqbn)) fail('INVALID_REQUEST', 'Use a base FQBN and separate explicit board options.');
  const args = ['--fqbn', fqbn];
  for (const [key, value] of Object.entries(options).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^[A-Za-z0-9_-]+$/.test(key) || typeof value !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(value)) fail('INVALID_REQUEST', 'Board options require explicit literal key/value selections.');
    args.push('--board-options', `${key}=${value}`);
  }
  return args;
}
function properties(value: unknown): Record<string, string> {
  if (!Array.isArray(value) || value.length > 10000) return fail('INVALID_REQUEST', 'Arduino CLI did not return bounded build properties.');
  const result: Record<string, string> = {};
  for (const item of value) { const line = string(item); const at = line.indexOf('='); if (at < 1) fail('INVALID_REQUEST', 'Malformed Arduino build property.'); result[line.slice(0, at)] = line.slice(at + 1); }
  return result;
}
function normalizedProperties(input: Record<string, string>, operation: string): Record<string, string> {
  return Object.fromEntries(Object.entries(input).filter(([key]) => !['build.path', 'build.source.path', 'archive_file_path'].includes(key)).map(([key, value]) => [key, value.replaceAll(operation, '<operation>').replaceAll(operation.replaceAll('\\', '/'), '<operation>')]));
}

export class ArduinoAdapter {
  readonly executable: string;
  readonly workRoot: string;
  constructor(private readonly runner: Pick<ProcessRunner, 'run'>, executable: string, workRoot: string) {
    if (!isAbsolute(executable) || /\.(?:cmd|bat)$/i.test(executable) || !isAbsolute(workRoot) || /^\\\\|^\/\//.test(workRoot)) fail('INVALID_REQUEST', 'Select an existing native CLI executable and a local owned work directory.');
    try { this.executable = realpathSync(executable); if (!statSync(this.executable).isFile()) throw Error(); }
    catch { fail('TOOL_UNAVAILABLE', 'Arduino CLI is unavailable at the selected path; editing remains available.'); }
    mkdirSync(workRoot, { recursive: true }); this.workRoot = realpathSync(workRoot);
  }
  private run(args: string[], signal?: AbortSignal, cwd = this.workRoot, timeoutMs = 15000, logDirectory?: string): Promise<ProcessResult> {
    return this.runner.run({ executable: this.executable, args, cwd, signal, timeoutMs, maxOutputBytes: 1024 * 1024, ...(logDirectory ? { logDirectory } : {}) });
  }
  async inspect(signal?: AbortSignal): Promise<ToolchainInspection> {
    const commands = [['version', '--json'], ['config', 'get', 'directories', '--json'], ['core', 'list', '--json'], ['lib', 'list', '--json'], ['compile', '--help'], ['upload', '--help']];
    const results: ProcessResult[] = [];
    for (const args of commands) { const result = await this.run(args, signal); successful(result, `Arduino ${args[0]} inspection`); results.push(result); }
    const version = string(json(results[0]).VersionString, 128);
    if (version !== '1.5.1') fail('UNSUPPORTED_ENVIRONMENT', 'This adapter is validated for Arduino CLI 1.5.1; run a compatibility probe for another version.');
    const dirs = json(results[1]); const data = string(dirs.data), user = string(dirs.user), downloads = string(dirs.downloads ?? '');
    if (!isAbsolute(data) || !isAbsolute(user)) fail('INVALID_REQUEST', 'Arduino effective directories are unresolved.');
    const platforms = json(results[2]).platforms, libraries = json(results[3]).installed_libraries;
    if (!Array.isArray(platforms) || !Array.isArray(libraries) || platforms.length > 1000 || libraries.length > 10000) fail('INVALID_REQUEST', 'Arduino installation inventory is malformed.');
    if (!['--output-dir', '--build-path', '--show-properties', '--board-options'].every(flag => results[4].stdout.includes(flag)) || !results[5].stdout.includes('--input-file')) fail('UNSUPPORTED_ENVIRONMENT', 'Selected CLI lacks the tested exact-artifact workflow.');
    return { schemaVersion: 1, executablePath: this.executable, executableSha256: hashFile(this.executable), version, checkedAt: new Date().toISOString(),
      configuration: { directories: { data, user, downloads } }, cores: platforms.filter(item => object(item).installed_version).map(item => ({ id: string(object(item).id, 256), version: string(object(item).installed_version, 128) })),
      libraries, capabilities: { compileJson: true, exactFileUpload: true, supportedUploadFqbns: platforms.some(item => object(item).id === 'arduino:avr' && object(item).installed_version === '1.8.8') ? ['arduino:avr:uno'] : [] }, helpSha256: { compile: sha(results[4].stdout), upload: sha(results[5].stdout) } };
  }
  async discover(signal?: AbortSignal): Promise<DiscoveredPort[]> {
    const result = await this.run(['board', 'list', '--json'], signal); successful(result, 'Arduino discovery');
    const ports = json(result).detected_ports;
    if (!Array.isArray(ports) || ports.length > 500) fail('INVALID_REQUEST', 'Arduino discovery returned malformed or oversized ports.');
    return ports.filter(item => object(object(item).port).protocol === 'serial').map(item => {
      const value = object(item), port = object(value.port), address = string(port.address, 256);
      if (!/^(?:\\\\\.\\)?COM[1-9][0-9]{0,5}$/i.test(address)) fail('UNSUPPORTED_ENVIRONMENT', 'Discovery returned a nonlocal serial address.');
      const raw = object(port.properties), matching = value.matching_boards ?? [];
      if (!Array.isArray(matching) || matching.length > 100) fail('INVALID_REQUEST', 'Invalid discovered board candidates.');
      return { address, protocol: 'serial' as const, label: string(port.label ?? address, 1024), properties: Object.fromEntries(Object.entries(raw).map(([key, value]) => [string(key, 128), string(value, 512)])), matchingBoards: matching.map(board => ({ name: string(object(board).name, 256), fqbn: string(object(board).fqbn, 256) })) };
    });
  }
  private materialize(snapshot: SourceSnapshot, destination: string, rootSketchName?: string): { root: string; libraries: string[] } {
    if (!isRequestId(snapshot.sourceSnapshotId) || !/^[a-f0-9]{64}$/.test(snapshot.sha256) || !snapshot.files.length) fail('INVALID_REQUEST', 'Compile requires an identified immutable saved source snapshot.');
    const write = (root: string, files: SourceFile[]) => {
      mkdirSync(root, { recursive: true }); const scope = new ProjectFiles(root), seen = new Set<string>();
      for (const file of files) {
        if (!(file.bytes instanceof Uint8Array) || file.bytes.byteLength !== file.sizeBytes || sha(file.bytes) !== file.sha256 || seen.has(file.path.toLowerCase())) fail('ARTIFACT_MISMATCH', 'Source snapshot bytes or paths do not match their immutable inventory.');
        seen.add(file.path.toLowerCase()); const path = scope.resolvePath(file.path, true); mkdirSync(dirname(path), { recursive: true }); writeFileSync(scope.resolvePath(file.path, true), file.bytes, { flag: 'wx' });
      }
    };
    if (rootSketchName !== undefined && (!rootSketchName || /[\\/:<>"|?*\x00-\x1f]/.test(rootSketchName) || /[. ]$/.test(rootSketchName) || ['.', '..'].includes(rootSketchName))) fail('INVALID_REQUEST', 'Preserve the original ordinary root sketch folder name.');
    const root = join(destination, rootSketchName ?? 'source'); write(root, snapshot.files);
    const libraries = snapshot.libraries.map((library, index) => { const path = join(destination, 'libraries', String(index)); write(path, library.files); return path; });
    return { root, libraries };
  }
  private async inputTrees(toolchain: ToolchainInspection, buildProperties: Record<string, string>, signal?: AbortSignal): Promise<InputTree[]> {
    const dirs = toolchain.configuration.directories;
    const roots = [buildProperties['runtime.platform.path'], ...Object.entries(buildProperties).filter(([key]) => /^runtime\.tools\..+\.path$/.test(key)).map(([, value]) => value), join(dirs.user, 'libraries')].filter((path): path is string => !!path && existsSync(path));
    const data = realpathSync(dirs.data), user = existsSync(dirs.user) ? realpathSync(dirs.user) : resolve(dirs.user);
    const canonical = [...new Set(roots.map(path => realpathSync(path)))].sort();
    for (const path of canonical) if (!contained(data, path) && !contained(user, path)) fail('UNAUTHORIZED_SCOPE', 'Resolved toolchain input is outside the effective Arduino roots.');
    const trees: InputTree[] = [];
    for (const path of canonical.filter(path => !canonical.some(other => other !== path && contained(other, path)))) trees.push(await fingerprintTreeAsync(path, signal));
    return trees;
  }
  async assertCurrent(build: Pick<CompileResult, 'toolchain' | 'buildProperties' | 'libraryInputs'>, signal?: AbortSignal): Promise<void> {
    const current = await this.inspect(signal);
    const identity = (value: ToolchainInspection) => ({ path: value.executablePath, sha256: value.executableSha256, version: value.version, cores: value.cores, configuration: value.configuration, helpSha256: value.helpSha256 });
    if (stable(identity(current)) !== stable(identity(build.toolchain)) || stable(await this.inputTrees(current, build.buildProperties, signal)) !== stable(build.libraryInputs)) {
      fail('REVISION_CONFLICT', 'CLI, board platform, compiler or local library inputs changed; compile a new identified build.');
    }
  }
  async compile(input: CompileInput): Promise<CompileResult> {
    const warnings = input.warnings ?? 'default'; if (!['none', 'default', 'more', 'all'].includes(warnings)) fail('INVALID_REQUEST', 'Invalid compiler warning selection.');
    const boardArgs = boardArguments(input.fqbn, input.boardOptions);
    const operationDirectory = join(this.workRoot, randomUUID()); mkdirSync(operationDirectory);
    const rootSketch = input.sketchRelativePath === '.';
    if (rootSketch && !input.rootSketchName) fail('INVALID_REQUEST', 'A root sketch needs its original folder name.');
    const materialized = this.materialize(input.snapshot, operationDirectory, rootSketch ? input.rootSketchName : undefined), scope = new ProjectFiles(materialized.root);
    const sketch = rootSketch ? materialized.root : scope.resolvePath(input.sketchRelativePath), primary = scope.resolvePath(`${rootSketch ? '' : `${input.sketchRelativePath}/`}${basename(sketch)}.ino`);
    if (!existsSync(sketch) || !existsSync(primary) || !statSync(sketch).isDirectory() || !statSync(primary).isFile()) fail('INVALID_REQUEST', 'Preserve the ordinary sketch folder and matching primary .ino filename.');
    // shortcut: profiles can auto-install dependencies; enable only after a separately tested explicit profile policy.
    if (existsSync(join(sketch, 'sketch.yaml'))) fail('UNSUPPORTED_ENVIRONMENT', 'Profile-bearing sketches require explicit dependency-policy validation; sketch.yaml was preserved and no compiler was launched.');
    const toolchain = await this.inspect(input.signal);
    const buildPath = join(operationDirectory, 'build'), outputPath = join(operationDirectory, 'output'), logs = join(operationDirectory, 'logs');
    const common = ['compile', ...boardArgs, '--warnings', warnings, '--build-path', buildPath, '--output-dir', outputPath, '--jobs', '1', ...materialized.libraries.flatMap(path => ['--library', path])];
    const probe = await this.run([...common, '--show-properties=expanded', '--json', sketch], input.signal, operationDirectory);
    successful(probe, 'Arduino build-property inspection');
    const buildProperties = properties(object(json(probe).builder_result).build_properties);
    const before = await this.inputTrees(toolchain, buildProperties, input.signal);
    const processResult = await this.run([...common, '--json', sketch], input.signal, operationDirectory, 180000, logs);
    if (!processResult.terminationObserved || processResult.cancelled || processResult.timedOut) successful(processResult, 'Arduino compile');
    const response = json(processResult), success = processResult.exitCode === 0 && response.success === true;
    const builder = object(response.builder_result), diagnosticText = [typeof response.compiler_err === 'string' ? response.compiler_err : '', processResult.stderr].filter(Boolean).join('\n');
    const diagnostics: CompileDiagnostic[] = [];
    for (const line of diagnosticText.split(/\r?\n/)) {
      const match = /^(.*?):(\d+):(\d+):\s*(fatal error|error|warning|note):\s*(.*)$/.exec(line);
      if (!match) continue;
      const full = resolve(match[1]); const known = contained(materialized.root, full);
      diagnostics.push({ path: known ? relative(materialized.root, full).replaceAll('\\', '/') : null, line: known ? Number(match[2]) : null, column: known ? Number(match[3]) : null,
        severity: match[4] === 'warning' ? 'warning' : match[4] === 'note' ? 'information' : 'error', message: match[5].slice(0, 4096), sourceSnapshotId: input.snapshot.sourceSnapshotId });
      if (diagnostics.length === 500) break;
    }
    const actualProperties = builder.build_properties ? properties(builder.build_properties) : buildProperties;
    const after = await this.inputTrees(toolchain, actualProperties, input.signal);
    if (stable(before) !== stable(after) || hashFile(this.executable) !== toolchain.executableSha256) fail('REVISION_CONFLICT', 'Toolchain or library contents changed during compilation.');
    const saved = scope.snapshotSource({ paths: input.snapshot.files.map(file => file.path), host: () => ({ dirtyPaths: [] }),
      libraryRoots: input.snapshot.libraries.map((library, index) => ({ id: library.id, root: materialized.libraries[index], paths: library.files.map(file => file.path) })) });
    if (saved.sha256 !== input.snapshot.sha256) fail('ARTIFACT_MISMATCH', 'Compiled staged source no longer matches the immutable input snapshot.');
    const inputFingerprint = sha(stable({ source: input.snapshot.sha256, fqbn: input.fqbn, boardOptions: input.boardOptions, warnings,
      cli: { path: toolchain.executablePath, version: toolchain.version, sha256: toolchain.executableSha256 }, cores: toolchain.cores,
      configuration: toolchain.configuration, properties: normalizedProperties(actualProperties, operationDirectory), inputs: before }));
    const outputs: BuildOutput[] = [];
    if (success && existsSync(outputPath)) for (const name of readdirSync(outputPath).sort()) {
      const path = join(outputPath, name), info = lstatSync(path); if (!info.isFile() || info.isSymbolicLink()) fail('ARTIFACT_MISMATCH', 'Compiler output must be an ordinary file.');
      if (info.size) outputs.push({ path, sizeBytes: info.size, sha256: hashFile(path), mediaType: name.endsWith('.hex') ? 'application/vnd.intel.hex' : 'application/octet-stream' });
    }
    const uploadArtifact = input.fqbn === 'arduino:avr:uno' ? outputs.find(item => basename(item.path) === `${basename(sketch)}.ino.hex`) : undefined;
    if (success && !outputs.length) fail('ARTIFACT_MISMATCH', 'Compiler reported success without nonempty output artifacts.');
    if (success && input.fqbn === 'arduino:avr:uno' && !uploadArtifact) fail('ARTIFACT_MISMATCH', 'Uno compilation did not produce the expected ordinary .ino.hex artifact.');
    return { succeeded: success, sourceSnapshotId: input.snapshot.sourceSnapshotId, sourceSha256: input.snapshot.sha256, inputFingerprint, fqbn: input.fqbn, boardOptions: { ...input.boardOptions }, warnings,
      toolchain, buildProperties: actualProperties, libraryInputs: before, diagnostics, outputs, ...(uploadArtifact ? { uploadArtifact } : {}), process: processResult, operationDirectory,
      limitations: input.fqbn === 'arduino:avr:uno' ? [] : ['Physical uploading for this FQBN is unverified and disabled.'] };
  }
  async upload(input: { artifactPath: string; artifactSha256: string; fqbn: string; port: string; boardOptions?: Record<string, string>; signal?: AbortSignal; beforeExecute?: (inspection: ToolchainInspection) => void | Promise<void> }): Promise<ProcessResult> {
    if (input.fqbn !== 'arduino:avr:uno') fail('UNSUPPORTED_ENVIRONMENT', 'Only the separately validated Uno upload recipe is enabled.');
    if (!isAbsolute(input.artifactPath) || !/^[a-f0-9]{64}$/.test(input.artifactSha256) || !/^(?:\\\\\.\\)?COM[1-9][0-9]{0,5}$/i.test(input.port) || !input.artifactPath.endsWith('.hex') || /with_bootloader/i.test(basename(input.artifactPath))) fail('INVALID_REQUEST', 'Upload requires the exact ordinary Uno hex and selected local serial port.');
    if (hashFile(input.artifactPath) !== input.artifactSha256) fail('ARTIFACT_MISMATCH', 'Selected artifact bytes changed; no uploader was launched.');
    const inspection = await this.inspect(input.signal);
    if (!inspection.capabilities.exactFileUpload || !inspection.capabilities.supportedUploadFqbns.includes(input.fqbn)) fail('UNSUPPORTED_ENVIRONMENT', 'Exact-artifact upload requires the validated Arduino AVR 1.8.8 core.');
    if (hashFile(input.artifactPath) !== input.artifactSha256) fail('ARTIFACT_MISMATCH', 'Selected artifact changed during upload preflight.');
    const directory = join(this.workRoot, randomUUID()); mkdirSync(directory);
    await input.beforeExecute?.(inspection);
    if (input.signal?.aborted) fail('CANCELLED', 'Upload was cancelled before external execution.');
    if (hashFile(input.artifactPath) !== input.artifactSha256) fail('ARTIFACT_MISMATCH', 'Selected artifact changed before uploader launch.');
    return this.run(['upload', ...boardArguments(input.fqbn, input.boardOptions ?? {}), '--port', input.port, '--input-file', input.artifactPath, '--json'], input.signal, directory, 120000, join(directory, 'logs'));
  }
}
