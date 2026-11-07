import { isProjectRequest, methodPolicies, projectParamSchemas, WorkbenchError, type ProjectMethod, type ProjectRequest, type ProjectResponse } from '@robotics-workbench/contracts';
import { assertSafeAgentText } from '../context/index';

export const domainMethods = ['project.snapshot', 'component.inspect', 'connections.query', 'document.query', 'document.excerpt', 'document.expand', 'telemetry.query', 'telemetry.selection', 'build.compile', 'build.diagnostics', 'device.status', 'firmware.upload', 'serial.capture', 'recording.query', 'experiment.record', 'operation.get', 'operation.cancel'] as const;
export const domainToolNames = Object.fromEntries(domainMethods.map(method => [method.replaceAll('.', '_'), method])) as Record<string, ProjectMethod>;
export const domainToolDefinitions = domainMethods.map(method => ({
  name: method.replaceAll('.', '_'), description: `${method}: ${methodPolicies[method].classification}. Returns observations or an operation receipt; queued is not success.`,
  annotations: { readOnlyHint: methodPolicies[method].classification === 'read', destructiveHint: methodPolicies[method].classification !== 'read', idempotentHint: methodPolicies[method].classification === 'read', openWorldHint: false },
  inputSchema: { type: 'object' as const, additionalProperties: false, properties: {
    requestId: { type: 'string', format: 'uuid' }, expectedProjectRevision: { type: 'integer', minimum: 1 }, params: method === 'serial.capture' ? { ...projectParamSchemas[method], properties: { ...projectParamSchemas[method].properties, durationMs: { type: 'integer', minimum: 1000, maximum: 60000 } } } : projectParamSchemas[method]
  }, required: ['requestId', 'params'] }
}));

/** The authenticated bridge supplies project/task scope; tool arguments cannot retarget it. */
export class DomainTools {
  private readonly failures = new Map<string, number>();
  constructor(readonly projectId: string, private readonly dispatch: (request: ProjectRequest) => Promise<ProjectResponse>,
    private readonly authorize: (request: ProjectRequest) => Promise<void>,
    private readonly retain: (response: ProjectResponse) => { artifactId: string; sha256: string },
    private readonly pause: (request: ProjectRequest) => void = () => {}) {}

  async call(name: string, args: unknown): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
    if (!Object.hasOwn(domainToolNames, name) || !args || typeof args !== 'object' || Array.isArray(args)) throw new WorkbenchError('INVALID_REQUEST', 'Unknown tool or malformed arguments.');
    const input = args as Record<string, unknown>;
    if (Object.keys(input).some(key => !['requestId', 'expectedProjectRevision', 'params'].includes(key))) throw new WorkbenchError('INVALID_REQUEST', 'Tool scope is fixed by the host.');
    const request = { schemaVersion: 1, projectId: this.projectId, method: domainToolNames[name], ...input };
    if (!isProjectRequest(request)) throw new WorkbenchError('INVALID_REQUEST', 'Tool parameters do not match the domain contract.');
    if (request.method === 'serial.capture' && Number(request.params.durationMs) > 60000) throw new WorkbenchError('INVALID_REQUEST', 'Agent capture tools are limited to 60 seconds; longer recording is an explicit native host action.');
    const key = JSON.stringify([request.method, request.expectedProjectRevision, request.params]);
    let response: ProjectResponse;
    try {
      await this.authorize(request);
      response = await this.dispatch(request);
      if ('error' in response) this.failed(key, request); else this.failures.delete(key);
    } catch (error) { this.failed(key, request); throw error; }
    let text = JSON.stringify(response);
    assertSafeAgentText(text);
    if (Buffer.byteLength(text) > 16384) text = JSON.stringify({ schemaVersion: 1, requestId: request.requestId, truncated: true, evidenceRef: this.retain(response), nextAction: 'Query a smaller fixed range or inspect the retained artifact in the host.' });
    return { content: [{ type: 'text', text }], ...('error' in response ? { isError: true } : {}) };
  }
  private failed(key: string, request: ProjectRequest): void { const count = (this.failures.get(key) ?? 0) + 1; this.failures.set(key, count); if (count === 3) this.pause(request); }
}
