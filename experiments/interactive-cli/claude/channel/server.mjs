import { createServer } from 'node:http';
import { appendFile } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const port = Number(process.env.KHALA_CHANNEL_PORT ?? 8789);
const logPath = process.env.KHALA_CHANNEL_LOG;

async function log(kind, fields = {}) {
  if (!logPath) return;
  await appendFile(logPath, `${JSON.stringify({ at: new Date().toISOString(), kind, ...fields })}\n`, {
    mode: 0o600,
  });
}

const mcp = new Server(
  { name: 'khala-proof', version: '0.0.1' },
  {
    capabilities: { experimental: { 'claude/channel': {} } },
    instructions: 'Channel events are one-way Khala proof messages. Read and report their marker.',
  },
);

await mcp.connect(new StdioServerTransport());

createServer(async (request, response) => {
  if (request.method !== 'POST') {
    response.writeHead(405).end('POST required');
    return;
  }
  let body = '';
  for await (const chunk of request) body += chunk;
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: { content: body, meta: { path: request.url ?? '/', method: request.method } },
  });
  await log('notification', { bytes: Buffer.byteLength(body), path: request.url ?? '/' });
  response.writeHead(200).end('ok');
}).listen(port, '127.0.0.1', () => void log('listening', { port }));
