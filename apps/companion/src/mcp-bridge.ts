import { createServer, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { DomainTools } from '@robotics-workbench/application';

/** A task-scoped random bearer protects this loopback-only forwarding seam. */
export class ToolBridge {
  private readonly token = randomBytes(32).toString('hex');
  private server?: Server;
  async listen(tools: DomainTools): Promise<{ endpoint: string; token: string }> {
    const server = createServer(async (request, response) => {
      const supplied = Buffer.from(request.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${this.token}`);
      if (request.method !== 'POST' || request.url !== '/tools' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { response.writeHead(403).end(); return; }
      let size = 0; const chunks: Buffer[] = [];
      try {
        for await (const chunk of request) { size += chunk.length; if (size > 65536) { response.writeHead(413).end(); request.destroy(); return; } chunks.push(chunk); }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const result = await tools.call(body.name, body.arguments);
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
      } catch { response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ isError: true, content: [{ type: 'text', text: 'Tool request rejected; inspect project scope, action policy and parameters.' }] })); }
    });
    server.requestTimeout = 15000; server.headersTimeout = 10000; this.server = server;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); if (!address || typeof address === 'string') throw Error('Loopback tool bridge unavailable.');
    return { endpoint: `http://127.0.0.1:${address.port}/tools`, token: this.token };
  }
  close(): Promise<void> { this.server?.closeAllConnections(); return new Promise((resolve, reject) => this.server?.listening ? this.server.close(error => error ? reject(error) : resolve()) : resolve()); }
}
