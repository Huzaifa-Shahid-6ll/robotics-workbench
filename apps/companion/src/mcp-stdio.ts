import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { domainToolDefinitions } from '@robotics-workbench/application';

const endpoint = process.env.ROBOTICS_TOOL_ENDPOINT ?? '', token = process.env.ROBOTICS_TOOL_TOKEN ?? '';
if (!/^http:\/\/127\.0\.0\.1:\d+\/tools$/.test(endpoint) || !/^[a-f0-9]{64}$/.test(token)) throw Error('A host-issued local tool binding is required.');
const server = new Server({ name: 'robotics-workbench', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: domainToolDefinitions }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: request.params.name, arguments: request.params.arguments }), signal: AbortSignal.timeout(12000), redirect: 'error' });
    if (!response.ok) throw Error();
    const result = await response.json() as { content: { type: 'text'; text: string }[]; isError?: boolean };
    return { ...result };
  } catch { return { isError: true, content: [{ type: 'text', text: 'Coordinator unavailable or request rejected. Query the original request ID before repeating a mutation.' }] }; }
});
server.connect(new StdioServerTransport()).catch(() => { process.stderr.write('MCP transport failed.\n'); process.exitCode = 1; });
