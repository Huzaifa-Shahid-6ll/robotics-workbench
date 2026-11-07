import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { isProjectRequest, isProjectResponse, WorkbenchError, type KicadCapability, type KicadExport, type KicadGeneration, type KicadPreview, type KicadSnapshot, type OperationReceipt, type ProjectRequest, type ProjectResponse } from '@robotics-workbench/contracts';
import { assertKicadProcess, digest, generateSchematic, inertSvg, inspectKicad, inspectNative, inspectSymbolTable, kicadEnvironmentSha256, netlistEndpoints, parseErc, type KicadConfig } from '@robotics-workbench/kicad';
import { referenceCatalog, validateCatalog } from '@robotics-workbench/domain';
import { canonicalJson } from '@robotics-workbench/persistence';
import type { ProjectService } from './project-service';

type FileInput = { path: string; sha256: string | null };
type RetainedGeneration = KicadGeneration & { kind: 'kicad-generation'; inputs: FileInput[]; capability: KicadCapability; endpointMappings: ReturnType<typeof generateSchematic>['mappings'] };
const fileLimit = 4 * 1024 * 1024;
const limits = ['Single-sheet saved schematics with complete embedded symbols; hierarchy, buses and embedded resources require native KiCad.', 'Generation supports explicit pin-block-v1 mappings: maximum 16 resolved components and 16 pins each. Blocks describe logical design intent, not physical header positions.', 'Save external KiCad edits before checking. Unsaved native editor state is unavailable.', 'ERC and connectivity are software checks; physical wiring, power/thermal capacity and firmware behavior remain unverified.'];
const ref = ({ artifactId, sha256, mediaType, relativePath }: OperationReceipt['artifacts'][number]) => ({ artifactId, sha256, mediaType, relativePath });

/** Ordinary source files stay authoritative. Every generated/check result is a new immutable version. */
export class KicadService {
  constructor(private readonly project: ProjectService, private readonly config: KicadConfig = {}) {}
  supports(method: string): boolean { return ['kicad.snapshot', 'kicad.generate', 'kicad.validate', 'kicad.preview', 'kicad.export'].includes(method); }
  private current(request?: ProjectRequest) {
    const response = this.project.handle({ schemaVersion: 1, requestId: randomUUID(), projectId: this.project.projectId, method: 'project.snapshot', params: {} }, { includeBuilds: false });
    if (response.error) throw new WorkbenchError(response.error.code, response.error.message);
    const snapshot = this.project.files.inspectManifest();
    if (request?.expectedProjectRevision !== undefined && request.expectedProjectRevision !== snapshot.manifest.projectRevision) throw new WorkbenchError('REVISION_CONFLICT', 'Refresh the design before creating or exporting schematic evidence.');
    return snapshot;
  }
  private read(path: string): Buffer {
    const full = this.project.files.resolvePath(path);
    if (!statSync(full).isFile() || statSync(full).size > fileLimit) throw new WorkbenchError('KICAD_INPUT_LIMIT', 'Schematic input must be an ordinary file at most 4 MiB.');
    const bytes = readFileSync(full); if (bytes.length > fileLimit) throw new WorkbenchError('REVISION_CONFLICT', 'Schematic input grew during read.'); return bytes;
  }
  private fingerprint(path: string): string | null { return existsSync(this.project.files.resolvePath(path, true)) ? digest(this.read(path)) : null; }
  private assertInputs(inputs: FileInput[]): void { for (const input of inputs) if (this.fingerprint(input.path) !== input.sha256) throw new WorkbenchError('REVISION_CONFLICT', `Saved schematic input changed: ${input.path}. Both native source and staged output were preserved.`); }
  private history(): RetainedGeneration[] { return this.project.store.listRecords<RetainedGeneration>('sessions', this.project.projectId).filter(item => item.kind === 'kicad-generation').sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  private generation(id: string): RetainedGeneration { const item = this.history().find(item => item.generationId === id); if (!item) throw new WorkbenchError('NOT_FOUND', 'Schematic generation is not retained in this project.'); return item; }
  private stale(item: RetainedGeneration): boolean {
    try {
      const current = this.current();
      if (item.projectRevision !== current.manifest.projectRevision || item.manifestSha256 !== current.sha256 || digest(readFileSync(item.nativePath)) !== item.sourceSha256) return true;
      this.assertInputs(item.inputs);
      if (!this.config.executable || this.config.executable !== item.capability.executable || digest(readFileSync(this.config.executable)) !== item.capability.executableSha256 || kicadEnvironmentSha256() !== item.capability.environmentSha256) return true;
      const latest = this.project.store.listOperations(this.project.projectId).filter(operation => operation.kind === 'kicad-export' && ['failed', 'cancelled', 'outcome-unknown'].includes(operation.status)).some(operation => operation.createdAt >= item.createdAt && operation.operationId !== item.operationId);
      return latest;
    } catch { return true; }
  }
  private inputGuard(request: ProjectRequest): FileInput[] {
    const p = request.params;
    if (p.sourcePath === undefined) { if (p.expectedSourceSha256 !== undefined) throw new WorkbenchError('INVALID_REQUEST', 'A native hash guard requires its source path.'); return []; }
    const path = String(p.sourcePath);
    if (extname(path).toLowerCase() !== '.kicad_sch' || p.expectedSourceSha256 === undefined) throw new WorkbenchError('INVALID_REQUEST', 'Select a native .kicad_sch path with its exact saved hash (or null for an absent file).');
    const inputs: FileInput[] = [{ path, sha256: p.expectedSourceSha256 as string | null }];
    for (const name of ['sym-lib-table', 'Workbench.kicad_sym', `${basename(path, '.kicad_sch')}.kicad_pro`]) {
      const dependency = dirname(path) === '.' ? name : `${dirname(path).replaceAll('\\', '/')}/${name}`;
      inputs.push({ path: dependency, sha256: this.fingerprint(dependency) });
    }
    const table = inputs.find(item => basename(item.path) === 'sym-lib-table');
    if (table?.sha256) {
      inspectSymbolTable(this.read(table.path).toString('utf8'));
      if (!inputs.find(item => basename(item.path) === 'Workbench.kicad_sym')?.sha256) throw new WorkbenchError('KICAD_MISSING_LIBRARY', 'The native project symbol table requires its local Workbench.kicad_sym library.');
    }
    this.assertInputs(inputs); return inputs;
  }
  private async snapshot(request: ProjectRequest): Promise<KicadSnapshot> {
    const current = this.current(request); let readiness: KicadSnapshot['readiness'];
    try { const capability = await inspectKicad(this.project.runner, this.config, this.project.files.root); readiness = { available: true, reason: `Fixture-tested KiCad ${capability.version}; CLI capabilities and executable fingerprint match.`, capability }; }
    catch (error) { readiness = { available: false, reason: error instanceof Error ? error.message : 'KiCad is unavailable.' }; }
    const generations = this.history().slice(0, 20).map(item => { const { inputs, capability, kind, endpointMappings, ...summary } = item; return { ...summary, stale: this.stale(item) }; });
    let source: KicadSnapshot['source'] = null;
    if (request.params.sourcePath) {
      const path = String(request.params.sourcePath), sha256 = this.fingerprint(path), previous = this.history().find(item => item.sourcePath === path);
      source = { path, sha256, diverged: !!previous && (previous.inputs.find(item => item.path === path)?.sha256 !== sha256 || this.stale(previous)) };
    }
    return { schemaVersion: 1, readiness, projectRevision: current.manifest.projectRevision, manifestSha256: current.sha256, source, generations, limitations: limits };
  }
  private async start(request: ProjectRequest): Promise<OperationReceipt> {
    let previous: OperationReceipt | undefined;
    try { previous = this.project.store.getOperationByRequest(request.projectId, request.requestId); } catch (error) { if (!(error instanceof WorkbenchError) || error.code !== 'NOT_FOUND') throw error; }
    if (previous) { const { startedAt, finishedAt, error, result, ...queued } = previous; return this.project.store.createOperation({ ...queued, status: 'queued', artifacts: [] }, request); }
    const current = this.current(request), inputs = this.inputGuard(request), p = request.params;
    if (request.expectedProjectRevision === undefined) throw new WorkbenchError('INVALID_REQUEST', 'Schematic operations require the selected project revision.');
    if (request.method === 'kicad.generate' && current.sha256 !== p.expectedManifestSha256) throw new WorkbenchError('REVISION_CONFLICT', 'Manifest bytes changed; refresh before generating.');
    const capability = await inspectKicad(this.project.runner, this.config, this.project.files.root);
    let generated: ReturnType<typeof generateSchematic> | undefined, source: Buffer, nativeName = 'design.kicad_sch';
    if (request.method === 'kicad.generate') {
      const mappingPath = String(p.mappingPath), mapping = this.read(mappingPath), catalogPath = 'components/catalog.json', catalogBytes = this.fingerprint(catalogPath) === null ? null : this.read(catalogPath);
      inputs.push({ path: mappingPath, sha256: digest(mapping) }, { path: catalogPath, sha256: catalogBytes ? digest(catalogBytes) : null });
      let supplied: unknown[] = [];
      if (catalogBytes) { const value = JSON.parse(catalogBytes.toString()); if (!value || value.schemaVersion !== 1 || !Array.isArray(value.definitions) || Object.keys(value).some(key => !['schemaVersion', 'definitions'].includes(key))) throw new WorkbenchError('KICAD_UNRESOLVED_SYMBOL', 'Catalog must contain exact versioned component definitions.'); supplied = value.definitions; }
      const catalog = validateCatalog([...referenceCatalog, ...supplied]);
      const stamps = this.project.store.listRecords<{ kind: string; definitionId: string; definitionVersion: string; sha256: string }>('sessions', request.projectId).filter(item => item.kind === 'catalog-stamp');
      for (const definition of catalog) {
        const stamp = stamps.find(item => item.definitionId === definition.definitionId && item.definitionVersion === definition.definitionVersion), sha256 = digest(canonicalJson(definition));
        if (stamp && stamp.sha256 !== sha256) throw new WorkbenchError('REVISION_CONFLICT', 'Component definition changed without a new version. Review the exact pin mapping migration before generation.');
        if (!stamp) this.project.store.putRecord('sessions', randomUUID(), request.projectId, { kind: 'catalog-stamp', definitionId: definition.definitionId, definitionVersion: definition.definitionVersion, sha256 });
      }
      generated = generateSchematic(current.manifest, catalog, JSON.parse(mapping.toString())); source = Buffer.from(generated.text);
    } else { source = this.read(String(p.sourcePath)); nativeName = basename(String(p.sourcePath)); inspectNative(source.toString('utf8')); }
    const receipt: OperationReceipt = { schemaVersion: 1, operationId: randomUUID(), requestId: request.requestId, projectId: request.projectId, kind: 'kicad-export', status: 'queued', expectedProjectRevision: current.manifest.projectRevision, createdAt: new Date().toISOString(), tool: { name: 'kicad-cli', version: capability.version }, artifacts: [] };
    return this.project.jobs.submit({ receipt, payload: request, heavy: true, preflight: async () => { this.current(request); this.assertInputs(inputs); const now = await inspectKicad(this.project.runner, this.config, this.project.files.root); if (JSON.stringify(now) !== JSON.stringify(capability)) throw new WorkbenchError('REVISION_CONFLICT', 'KiCad installation/environment changed while queued.'); }, execute: async ({ signal }) => {
      const generationId = randomUUID(), stage = join(this.project.store.dataRoot, 'kicad', request.projectId, generationId); mkdirSync(stage, { recursive: true });
      const nativePath = join(stage, nativeName), artifacts: OperationReceipt['artifacts'] = [], files: KicadGeneration['files'] = [];
      const retain = (name: string, bytes: Buffer, mediaType: string) => { const artifact = this.project.store.storeArtifact(request.projectId, bytes, mediaType, receipt.operationId); artifacts.push(ref(artifact)); files.push({ name, artifactId: artifact.artifactId, sha256: artifact.sha256, mediaType }); return artifact; };
      const write = (name: string, bytes: Buffer, mediaType: string) => { writeFileSync(join(stage, name), bytes, { flag: 'wx' }); return retain(name, bytes, mediaType); };
      const native = write(nativeName, source, 'application/x-kicad-schematic');
      if (generated) { write('Workbench.kicad_sym', Buffer.from(generated.library), 'application/x-kicad-symbol'); write('sym-lib-table', Buffer.from(generated.symbolTable), 'text/plain'); write('design.kicad_pro', Buffer.from('{"meta":{"filename":"design.kicad_pro","version":3}}\n'), 'application/json'); }
      else for (const input of inputs.slice(1)) if (input.sha256 !== null) write(basename(input.path), this.read(input.path), extname(input.path) === '.kicad_pro' ? 'application/json' : 'text/plain');
      const processLogs: unknown[] = [];
      const run = async (args: string[], exits?: number[]) => {
        const result = await this.project.runner.run({ executable: capability.executable, args, cwd: stage, signal, timeoutMs: 60000, maxOutputBytes: 65536, logDirectory: join(stage, 'logs'), env: { LANG: 'C', LC_ALL: 'C' } });
        processLogs.push({ args: args.map(arg => arg.startsWith(stage) ? arg.slice(stage.length + 1) : arg), ...result });
        this.project.store.storeArtifact(request.projectId, Buffer.from(JSON.stringify(processLogs)), 'application/json', receipt.operationId);
        assertKicadProcess(result, exits); return result;
      };
      await run(['sch', 'export', 'netlist', '--format', 'kicadxml', '--output', join(stage, 'design.net'), nativePath]);
      const netBytes = this.readStage(join(stage, 'design.net')), endpoints = netlistEndpoints(netBytes.toString('utf8'));
      if (generated && JSON.stringify(endpoints) !== JSON.stringify(generated.expectedNets)) throw new WorkbenchError('KICAD_CONNECTIVITY_MISMATCH', 'Native KiCad connectivity differs from exact intended endpoint sets. Staged files and source were preserved.');
      retain('design.net', netBytes, 'application/xml');
      const erc = await run(['sch', 'erc', '--format', 'json', '--severity-all', '--exit-code-violations', '--output', join(stage, 'erc.json'), nativePath], [0, 5]);
      const ercBytes = this.readStage(join(stage, 'erc.json')), validation = parseErc(ercBytes.toString('utf8'), erc.exitCode!); retain('erc.json', ercBytes, 'application/json');
      const previewDirectory = join(stage, 'preview'); mkdirSync(previewDirectory);
      await run(['sch', 'export', 'svg', '--output', previewDirectory, nativePath]);
      const names = readdirSync(previewDirectory).filter(name => extname(name).toLowerCase() === '.svg'); if (names.length !== 1) throw new WorkbenchError('KICAD_INVALID_PREVIEW', 'Expected exactly one SVG for the supported single-sheet schematic.');
      const sheet = inspectNative(source.toString('utf8')), safe = Buffer.from(inertSvg(this.readStage(join(previewDirectory, names[0])).toString('utf8'))), preview = retain(`preview/${names[0]}`, safe, 'image/svg+xml');
      this.current(request); this.assertInputs(inputs);
      if (digest(readFileSync(capability.executable)) !== capability.executableSha256 || digest(readFileSync(nativePath)) !== native.sha256 || signal.aborted) throw new WorkbenchError('REVISION_CONFLICT', 'Generation inputs changed or were cancelled before publication. Staged output remains preserved.');
      const record: RetainedGeneration = { kind: 'kicad-generation', generationId, operationId: receipt.operationId, origin: generated ? 'generated' : 'native', projectRevision: current.manifest.projectRevision, manifestSha256: current.sha256, sourcePath: typeof p.sourcePath === 'string' ? p.sourcePath : null, sourceSha256: native.sha256, dependencySha256: digest(JSON.stringify({ inputs, capability, generator: 'pin-block-v1', mapping: generated?.mappings ?? null })), toolVersion: capability.version, nativeArtifactId: native.artifactId, nativePath, createdAt: new Date().toISOString(), verdict: validation.verdict, diagnostics: validation.diagnostics, netlistEquivalent: generated ? true : null, sheets: [{ sheetId: sheet.sheetId, name: names[0], artifactId: preview.artifactId, sha256: preview.sha256 }], files, stale: false, inputs, capability, endpointMappings: generated?.mappings ?? [] };
      writeFileSync(join(stage, 'provenance.json'), JSON.stringify(record, null, 2), { flag: 'wx' });
      this.project.store.putRecord('sessions', generationId, request.projectId, record);
      return { artifacts, result: { generationId, verdict: record.verdict, netlistEquivalent: record.netlistEquivalent } };
    } });
  }
  private readStage(path: string): Buffer { if (!statSync(path).isFile() || statSync(path).size > fileLimit) throw new WorkbenchError('KICAD_OUTPUT_LIMIT', 'Native output exceeds 4 MiB.'); const bytes = readFileSync(path); if (bytes.length > fileLimit) throw new WorkbenchError('KICAD_OUTPUT_LIMIT', 'Native output grew beyond 4 MiB.'); return bytes; }
  private export(request: ProjectRequest): KicadExport {
    const previous = this.project.store.listRecords<{ kind: string; requestId: string; result: KicadExport }>('sessions', request.projectId).find(item => item.kind === 'kicad-export-result' && item.requestId === request.requestId);
    if (previous) { this.project.store.admitRequest(request.projectId, request.requestId, request); return previous.result; }
    this.current(request); if (request.expectedProjectRevision === undefined) throw new WorkbenchError('INVALID_REQUEST', 'Export requires a reviewed project revision.');
    const item = this.generation(String(request.params.generationId)), guards = this.inputGuard(request); this.assertInputs(guards);
    if (this.stale(item)) throw new WorkbenchError('REVISION_CONFLICT', 'Schematic generation is stale. Review saved native changes and validate a fresh copy before export.');
    const destination = String(request.params.destinationPath), full = this.project.files.resolvePath(destination, true);
    if (!this.project.store.admitRequest(request.projectId, request.requestId, request)) throw new WorkbenchError('OUTCOME_UNKNOWN', 'This export was already admitted without a completion record. Inspect the destination; it will not be overwritten or replayed.');
    // Directory creation is exclusive: no existing native file or independently edited export is replaced.
    try { mkdirSync(full); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new WorkbenchError('REVISION_CONFLICT', 'Export destination already exists. Choose a new directory; existing native work was preserved.'); throw error; }
    const files: KicadExport['files'] = [];
    for (const file of item.files.filter(file => ['.kicad_sch', '.kicad_sym', '.kicad_pro'].includes(extname(file.name)) || file.name === 'sym-lib-table')) {
      this.assertInputs(guards); this.project.files.resolvePath(`${destination}/${file.name}`, true);
      const bytes = this.project.store.readArtifact(request.projectId, file.artifactId); writeFileSync(join(full, file.name), bytes, { flag: 'wx' }); files.push({ path: file.name, sha256: digest(bytes) });
    }
    const provenance = Buffer.from(JSON.stringify({ ...item, stale: false }, null, 2)); writeFileSync(join(full, 'provenance.json'), provenance, { flag: 'wx' }); files.push({ path: 'provenance.json', sha256: digest(provenance) });
    this.assertInputs(guards); const result = { generationId: item.generationId, path: full, files };
    this.project.store.putRecord('sessions', randomUUID(), request.projectId, { kind: 'kicad-export-result', requestId: request.requestId, result }); return result;
  }
  async handle(value: unknown): Promise<ProjectResponse> {
    if (!isProjectRequest(value) || value.projectId !== this.project.projectId || !this.supports(value.method)) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Invalid schematic request scope.');
    try {
      let result: unknown;
      switch (value.method) {
        case 'kicad.snapshot': result = await this.snapshot(value); break;
        case 'kicad.generate': case 'kicad.validate': result = await this.start(value); break;
        case 'kicad.preview': {
          const item = this.generation(String(value.params.generationId)), sheet = item.sheets.find(sheet => value.params.sheetId === undefined || value.params.sheetId === sheet.sheetId); if (!sheet) throw new WorkbenchError('NOT_FOUND', 'Selected schematic sheet is unavailable.');
          const bytes = this.project.store.readArtifact(value.projectId, sheet.artifactId), text = inertSvg(bytes.toString('utf8'));
          const preview: KicadPreview = { generationId: item.generationId, sheetId: sheet.sheetId, dataUrl: `data:image/svg+xml;base64,${Buffer.from(text).toString('base64')}`, sourceSha256: item.sourceSha256, projectRevision: item.projectRevision, stale: this.stale(item) }; result = preview; break;
        }
        case 'kicad.export': result = this.export(value); break;
      }
      const response: ProjectResponse = { schemaVersion: 1, requestId: value.requestId, result }; if (!isProjectResponse(response)) throw new WorkbenchError('INVALID_REQUEST', 'Schematic response exceeds the bounded control message. Use native handoff.'); return response;
    } catch (error) { const known = error instanceof WorkbenchError ? error : new WorkbenchError('KICAD_UNAVAILABLE', 'Schematic operation failed; original native files and retained artifacts were preserved.'); return { schemaVersion: 1, requestId: value.requestId, error: { code: known.code, message: known.message, retryable: false } }; }
  }
}
