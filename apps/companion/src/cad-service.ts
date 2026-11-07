import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import Ajv from 'ajv/dist/2020';
import { isProjectRequest, isProjectResponse, WorkbenchError, type OperationReceipt, type ProjectRequest, type ProjectResponse } from '@robotics-workbench/contracts';
import type { CadAsset, CadAssetStatus, CadExport, CadGeometry, CadSnapshot, CadViewer } from '@robotics-workbench/contracts';
import { cadViewerInstructions, loadCadAssets, prepareCad, cadHash, type PreparedCad } from '@robotics-workbench/cad';
import type { ProjectService } from './project-service';
import { checkArtifactCredentials } from '@robotics-workbench/persistence';
import { ProjectFiles } from '@robotics-workbench/application';

export type CadServiceConfig = { pythonPath?: string; runnerPath?: string; timeoutMs?: number; trusted: boolean };
export type CadSourceSnapshot = {
  schemaVersion: 1; kind: 'cad-source'; sourceSnapshotId: string; projectRevision: number; sha256: string; fingerprint: string;
  asset: CadAsset; parameters: PreparedCad['parameters']; effectiveParameters: PreparedCad['parameters'];
  files: { path: string; sha256: string; sizeBytes: number; artifactId: string }[];
};
const reportValid = new Ajv({ strict: true }).compile<{ schemaVersion: 1; geometry: CadGeometry; environment: Record<string, unknown>; reproducible: boolean; issues: string[] }>({ type: 'object', required: ['schemaVersion', 'geometry', 'environment', 'reproducible', 'issues'], additionalProperties: false, properties: { schemaVersion: { const: 1 }, geometry: { type: 'object', required: ['valid', 'boundsMm', 'volumeMm3', 'stepReopened', 'stlReopened', 'stlUnit'], additionalProperties: false, properties: { valid: { const: true }, boundsMm: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number', exclusiveMinimum: 0 } }, volumeMm3: { type: 'number', exclusiveMinimum: 0 }, stepReopened: { const: true }, stlReopened: { const: true }, stlUnit: { const: 'mm' } } }, environment: { type: 'object', maxProperties: 2 }, reproducible: { type: 'boolean' }, issues: { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 2048 } } } });
const reference = ({ artifactId, sha256, mediaType, relativePath }: OperationReceipt['artifacts'][number]) => ({ artifactId, sha256, mediaType, relativePath });

export class CadService {
  private readonly dataFiles: ProjectFiles;
  constructor(private readonly project: ProjectService, private readonly config: CadServiceConfig) { this.dataFiles = new ProjectFiles(project.store.dataRoot); }
  supports(method: string): boolean { return method.startsWith('cad.'); }
  private current(request?: ProjectRequest) {
    const response = this.project.handle({ schemaVersion: 1, requestId: randomUUID(), projectId: this.project.projectId, method: 'project.snapshot', params: {} }, { includeBuilds: false });
    if (response.error) throw new WorkbenchError(response.error.code, response.error.message);
    const manifest = this.project.files.inspectManifest().manifest;
    if (request?.expectedProjectRevision !== undefined && request.expectedProjectRevision !== manifest.projectRevision) throw new WorkbenchError('REVISION_CONFLICT', 'Refresh the CAD view before acting on a different design revision.');
    return manifest;
  }
  private prepared(asset: CadAsset): PreparedCad { return prepareCad(this.project.files, asset, this.config.pythonPath ?? 'unconfigured'); }
  private operations(assetId: string) { return this.project.store.listOperations(this.project.projectId).filter(op => op.kind === 'cad-generate' && op.result?.assetId === assetId); }
  private snapshot(revision: number): CadSnapshot {
    const assets = loadCadAssets(this.project.files).map(asset => {
      let prepared: PreparedCad | null = null, issues: string[] = [];
      try { prepared = this.prepared(asset); issues = prepared.issues; } catch (error) { issues = [error instanceof Error ? error.message : 'CAD inputs unavailable.']; }
      const operations = this.operations(asset.assetId), latestOperation = operations.at(-1) ?? null, lastGood = operations.filter(op => op.status === 'succeeded').at(-1) ?? null;
      const status: CadAssetStatus = { ...asset, parameters: prepared?.parameters ?? {}, currentFingerprint: prepared?.fingerprint ?? null, issues,
        latestOperation, lastGood, stale: !!lastGood && (lastGood.expectedProjectRevision !== revision || lastGood.result?.fingerprint !== prepared?.fingerprint || latestOperation?.operationId !== lastGood.operationId || !lastGood.result?.reproducible), viewer: { status: 'handoff-required', instructions: cadViewerInstructions } };
      return status;
    });
    return { schemaVersion: 1, projectRevision: revision, capabilities: { configured: !!this.config.pythonPath && existsSync(this.config.pythonPath), pythonPath: this.config.pythonPath ?? null, viewer: 'explicit-handoff' }, assets };
  }
  private good(assetId: string, operationId: string) {
    const operation = this.project.store.getOperation(this.project.projectId, operationId);
    if (operation.kind !== 'cad-generate' || operation.status !== 'succeeded' || operation.result?.assetId !== assetId) throw new WorkbenchError('CAD_ARTIFACT_UNAVAILABLE', 'Choose a successfully validated generation for this CAD asset.');
    return operation;
  }
  private retained(operation: OperationReceipt, format: 'step' | 'stl'): CadExport {
    const outputs = operation.result!.outputs as Record<string, string>, artifactId = outputs[format];
    if (typeof artifactId !== 'string') throw new WorkbenchError('CAD_ARTIFACT_UNAVAILABLE', 'Generation did not retain this output format.');
    const artifact = this.project.store.getArtifact(this.project.projectId, artifactId);
    this.project.store.readArtifact(this.project.projectId, artifact.artifactId);
    return { path: join(this.project.store.dataRoot, 'artifacts', artifact.sha256), sha256: artifact.sha256, mediaType: artifact.mediaType, unit: 'mm', productionAllowed: operation.result!.mode === 'production' };
  }
  async handle(value: unknown): Promise<ProjectResponse> {
    if (!isProjectRequest(value) || value.projectId !== this.project.projectId || !this.supports(value.method)) throw new WorkbenchError('UNAUTHORIZED_SCOPE', 'Invalid CAD request scope.');
    try {
      if (value.method === 'cad.generate') {
        let previous: OperationReceipt | undefined;
        try { previous = this.project.store.getOperationByRequest(value.projectId, value.requestId); } catch (error) { if (!(error instanceof WorkbenchError) || error.code !== 'NOT_FOUND') throw error; }
        if (previous) {
          const { startedAt, finishedAt, error, result, ...queued } = previous;
          return { schemaVersion: 1, requestId: value.requestId, result: this.project.store.createOperation({ ...queued, status: 'queued', artifacts: [] }, value) };
        }
      }
      const manifest = this.current(value), p = value.params;
      let result: unknown;
      if (value.method === 'cad.snapshot') result = this.snapshot(manifest.projectRevision);
      else if (value.method === 'cad.generate') {
        if (!this.config.trusted) throw new WorkbenchError('WORKSPACE_UNTRUSTED', 'Trust this workspace before running its Python code.');
        if (!this.config.pythonPath || !isAbsolute(this.config.pythonPath) || !existsSync(this.config.pythonPath)) throw new WorkbenchError('CAD_ENVIRONMENT_MISSING', 'Select an existing isolated CAD Python interpreter. Installation is explicit.');
        const asset = loadCadAssets(this.project.files).find(asset => asset.assetId === p.assetId);
        if (!asset) throw new WorkbenchError('NOT_FOUND', 'Declare this CAD asset in mechanical/assets.json.');
        const prepared = this.prepared(asset);
        for (const file of prepared.files) checkArtifactCredentials(file.bytes);
        if (prepared.fingerprint !== p.expectedFingerprint) throw new WorkbenchError('REVISION_CONFLICT', 'CAD source, parameters, modules, evidence or environment lock changed. Refresh and review.');
        const parameters = structuredClone(prepared.parameters), assumptions = (p.assumptions ?? {}) as Record<string, number>;
        if (Object.keys(assumptions).some(name => !Object.hasOwn(parameters, name) || parameters[name].value !== null)) throw new WorkbenchError('CAD_ASSUMPTION_INVALID', 'Assumptions may supply only explicitly unknown parameters.');
        const unknown = Object.entries(parameters).filter(([, p]) => p.value === null);
        if (p.mode === 'production' && (Object.keys(assumptions).length || unknown.some(([, p]) => p.fitCritical))) throw new WorkbenchError('CAD_DIMENSION_UNKNOWN', 'Unknown fit-critical dimensions block production export; retain their unknown basis.');
        for (const [name, parameter] of unknown) {
          if (p.mode !== 'exploratory' || !Object.hasOwn(assumptions, name)) throw new WorkbenchError('CAD_DIMENSION_UNKNOWN', 'Supply explicit exploratory assumptions for every unknown parameter.');
          parameter.value = assumptions[name]; parameter.basis = 'proposed';
        }
        const operation: OperationReceipt = { schemaVersion: 1, operationId: randomUUID(), sourceSnapshotId: randomUUID(), requestId: value.requestId, projectId: value.projectId, kind: 'cad-generate', status: 'queued', expectedProjectRevision: manifest.projectRevision, createdAt: new Date().toISOString(), tool: { name: 'cadquery', version: prepared.environment.packages.cadquery }, artifacts: [], result: { assetId: asset.assetId, fingerprint: prepared.fingerprint, generationFingerprint: cadHash(JSON.stringify({ inputFingerprint: prepared.fingerprint, mode: p.mode, assumptions })), mode: p.mode, assumptions, originalParameters: prepared.parameters } };
        const source: CadSourceSnapshot = { schemaVersion: 1, kind: 'cad-source', sourceSnapshotId: operation.sourceSnapshotId!, projectRevision: manifest.projectRevision, sha256: prepared.sourceSha256, fingerprint: prepared.fingerprint, asset, parameters: prepared.parameters, effectiveParameters: parameters,
          files: prepared.files.map(file => {
            const artifact = this.project.store.storeArtifact(value.projectId, file.bytes, 'application/octet-stream');
            if (artifact.sha256 !== file.sha256) throw new WorkbenchError('ARTIFACT_MISMATCH', 'The retained CAD source no longer matches its frozen input hash.');
            return { path: file.path, sha256: file.sha256, sizeBytes: file.bytes.length, artifactId: artifact.artifactId };
          }) };
        this.project.store.putRecord('source_snapshots', source.sourceSnapshotId, value.projectId, source);
        result = this.project.jobs.submit({ receipt: operation, payload: value, heavy: true, cancellable: true,
          preflight: () => { this.current(value); const currentAsset = loadCadAssets(this.project.files).find(item => item.assetId === asset.assetId); if (!currentAsset || this.prepared(currentAsset).fingerprint !== prepared.fingerprint) throw new WorkbenchError('REVISION_CONFLICT', 'CAD inputs changed while generation was queued.'); },
          execute: async ({ signal }) => this.generate(prepared, parameters, operation, signal) });
      } else if (value.method === 'cad.export') {
        const operation = this.good(String(p.assetId), String(p.operationId));
        const asset = loadCadAssets(this.project.files).find(asset => asset.assetId === p.assetId);
        if (!asset || operation.expectedProjectRevision !== manifest.projectRevision || this.prepared(asset).fingerprint !== operation.result!.fingerprint || this.operations(asset.assetId).at(-1)?.operationId !== operation.operationId || operation.result!.mode !== 'production' || operation.result!.reproducible !== true) throw new WorkbenchError('CAD_EXPORT_BLOCKED', 'Production export requires the latest current reproducible validated geometry with known fit-critical dimensions. Exploratory and historical artifacts remain available through viewer handoff.');
        result = this.retained(operation, p.format as 'step' | 'stl');
      } else if (value.method === 'cad.viewer') {
        const operation = this.good(String(p.assetId), String(p.operationId)), retained = this.retained(operation, 'step');
        const script = `# Retained validated CAD artifact; viewer display does not certify physical fit.\nimport cadquery as cq\nfrom ocp_vscode import show\nshow(cq.importers.importStep(${JSON.stringify(retained.path)}))\n`;
        const directory = this.dataFiles.resolvePath('cad-handoffs', true); mkdirSync(directory, { recursive: true });
        const path = this.dataFiles.resolvePath(`cad-handoffs/${operation.operationId}.py`, true);
        if (!existsSync(path)) writeFileSync(path, script, { flag: 'wx', mode: 0o600 });
        else if (readFileSync(path, 'utf8') !== script) throw new WorkbenchError('REVISION_CONFLICT', 'The handoff script was edited externally; preserve it and create a new generation.');
        result = { path, script, workflow: 'explicit-handoff', instructions: cadViewerInstructions, status: 'handoff-required' } satisfies CadViewer;
      } else throw new WorkbenchError('UNKNOWN_METHOD', 'Unsupported CAD request.');
      const response: ProjectResponse = { schemaVersion: 1, requestId: value.requestId, result };
      if (!isProjectResponse(response)) throw new WorkbenchError('CAD_RESULT_LIMIT', 'CAD response exceeded the bounded control-message limit.');
      return response;
    } catch (error) {
      const known = error instanceof WorkbenchError ? error : new WorkbenchError('CAD_UNAVAILABLE', 'CAD operation failed. Source and previous successful artifacts remain preserved.');
      return { schemaVersion: 1, requestId: value.requestId, error: { code: known.code, message: known.message, retryable: false } };
    }
  }
  private async generate(prepared: PreparedCad, parameters: PreparedCad['parameters'], operation: OperationReceipt, signal: AbortSignal) {
    const stage = this.dataFiles.resolvePath(`cad-staging/${operation.operationId}`, true), snapshot = join(stage, 'source'), output = join(stage, 'output');
    mkdirSync(snapshot, { recursive: true }); mkdirSync(output, { recursive: true });
    for (const file of prepared.files) { const path = join(snapshot, ...file.path.split('/')); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, file.bytes, { flag: 'wx' }); }
    const parameterPath = join(stage, 'parameters.json'), reportPath = join(stage, 'report.json'), requestPath = join(stage, 'request.json');
    writeFileSync(parameterPath, JSON.stringify(parameters), { flag: 'wx' });
    writeFileSync(requestPath, JSON.stringify({ asset: prepared.asset, environment: prepared.environment, snapshotRoot: snapshot, parameterPath, outputDirectory: output, reportPath }), { flag: 'wx' });
    const runnerPath = this.config.runnerPath ?? join(__dirname, 'cad-runner.py');
    const process = await this.project.runner.run({ executable: this.config.pythonPath!, args: ['-I', runnerPath, requestPath], cwd: snapshot, signal, timeoutMs: this.config.timeoutMs ?? 300000, logDirectory: join(stage, 'logs'), maxOutputBytes: 8192, maxLogBytes: 1024 * 1024, env: { TEMP: stage, TMP: stage } });
    if (process.cancelled || signal.aborted) throw new WorkbenchError('CAD_CANCELLED', 'CAD process stopped; previous geometry remains retained.');
    if (process.timedOut) throw new WorkbenchError('CAD_TIMEOUT', 'CAD generation timed out; previous geometry remains retained.');
    if (!existsSync(reportPath) || statSync(this.dataFiles.resolvePath(`cad-staging/${operation.operationId}/report.json`)).size > 65536) throw new WorkbenchError('CAD_PROCESS_FAILED', 'CAD process did not produce a bounded validation report. Inspect retained staging logs.');
    const report: unknown = JSON.parse(readFileSync(reportPath, 'utf8'));
    if (report && typeof report === 'object' && 'error' in report) { const error = report.error as { code?: unknown }; const code = typeof error.code === 'string' && /^CAD_[A-Z_]{1,80}$/.test(error.code) ? error.code : 'CAD_GENERATION_FAILED'; throw new WorkbenchError(code, 'CAD generation failed. Inspect the retained staging report and logs; previous good geometry remains preserved.'); }
    if (process.exitCode !== 0 || !reportValid(report)) throw new WorkbenchError('CAD_OUTPUT_INVALID', 'CAD validation report was invalid; no output was promoted.');
    const bytes = ['step', 'stl'].map(format => {
      const path = this.dataFiles.resolvePath(`cad-staging/${operation.operationId}/output/model.${format}`), info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || realpathSync(path) !== path || info.size === 0 || info.size > 64 * 1024 * 1024) throw new WorkbenchError('CAD_OUTPUT_INVALID', 'CAD outputs must be nonempty staged ordinary files.');
      const data = readFileSync(path); if (!data.length || data.length > 64 * 1024 * 1024) throw new WorkbenchError('CAD_OUTPUT_INVALID', 'CAD output size changed before promotion.'); return data;
    });
    if (signal.aborted) throw new WorkbenchError('CAD_CANCELLED', 'Cancelled CAD output was not promoted.');
    const outputs: Record<string, string> = {}, artifacts: OperationReceipt['artifacts'] = [];
    for (const [i, format] of ['step', 'stl'].entries()) { const artifact = this.project.store.storeArtifact(this.project.projectId, bytes[i], format === 'step' ? 'model/step' : 'model/stl', operation.operationId); outputs[format] = artifact.artifactId; artifacts.push(reference(artifact)); }
    const provenance = this.project.store.storeArtifact(this.project.projectId, Buffer.from(JSON.stringify({ schemaVersion: 1, sourceSnapshotId: operation.sourceSnapshotId, fingerprint: prepared.fingerprint, asset: prepared.asset, parameters: prepared.parameters, effectiveParameters: parameters, files: prepared.files.map(file => ({ path: file.path, sha256: file.sha256, bytesBase64: file.bytes.toString('base64') })), validation: report })), 'application/json', operation.operationId);
    artifacts.push(reference(provenance));
    return { artifacts, result: { ...operation.result, outputs, geometry: report.geometry, reproducible: report.reproducible, issues: [...prepared.issues, ...report.issues], environment: report.environment, provenanceArtifactId: provenance.artifactId, unit: 'mm' } };
  }
}
