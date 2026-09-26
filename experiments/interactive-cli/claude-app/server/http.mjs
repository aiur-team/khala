// Remote-connector entry point: a minimal Streamable HTTP MCP endpoint (JSON
// responses, no SSE stream). It listens on loopback only; the operator decides
// whether and how to expose it for a claude.ai or Claude Desktop connector.
// Proof-only: synthetic markers and no auth. An adapter must add OAuth.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createConnection } from '../lib/protocol.mjs';
import { openStore } from '../lib/store.mjs';

export async function startHttp({ stateDir, port = 0, host = '127.0.0.1' }) {
  const store = await openStore(stateDir);
  const connections = new Map();
  const server = createServer(async (req, res) => {
    if (new URL(req.url, 'http://x').pathname !== '/mcp') return res.writeHead(404).end();
    if (req.method !== 'POST') return res.writeHead(405, { allow: 'POST' }).end();
    let body = '';
    for await (const chunk of req) body += chunk;
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      return res.writeHead(400).end();
    }
    let sessionId = req.headers['mcp-session-id'];
    if (message.method === 'initialize') {
      sessionId = `c_${randomBytes(6).toString('hex')}`;
      connections.set(sessionId, createConnection({ store, transport: 'http', connectionId: sessionId }));
    }
    const connection = connections.get(sessionId);
    if (!connection) return res.writeHead(404).end(); // Unknown session: the client re-initializes.
    const reply = await connection.handle(message);
    if (!reply) return res.writeHead(202, { 'mcp-session-id': sessionId }).end();
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': sessionId }).end(JSON.stringify(reply));
  });
  await new Promise(resolve => server.listen(port, host, resolve));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await startHttp({ stateDir: process.env.KHALA_PROOF_STATE, port: Number(process.env.PORT ?? 8787) });
  process.stdout.write(`listening on http://127.0.0.1:${server.address().port}/mcp\n`);
}
