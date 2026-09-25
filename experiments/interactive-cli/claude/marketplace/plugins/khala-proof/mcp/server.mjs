// Minimal stdio MCP server exposing the agent-facing Khala calls. The session
// selector is Claude's CLAUDE_CODE_SESSION_ID; message bodies travel only as
// structured tool input/output, never argv.
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { frame, openStore, stateDirFrom } from '../lib/store.mjs';

const dir = stateDirFrom(process.env);
const store = dir ? await openStore(dir) : null;
const sessionId = process.env.CLAUDE_CODE_SESSION_ID ?? null;

const tools = [
  {
    name: 'khala_read',
    description: 'Read pending Khala channel messages for this Claude session. In async listening mode this is the only way messages are delivered.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'khala_send',
    description: 'Send one message to the bound Khala channel.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Message body.' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'khala_status',
    description: 'Show this session\'s Khala binding and listening mode.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

async function call(name, args) {
  if (!store) return 'Khala proof state is not configured for this project.';
  if (name === 'khala_read') {
    const { denied, releases } = await store.pull(sessionId, 'khala_read', { agentCall: true });
    if (denied) return 'This Claude session is not bound to a Khala channel.';
    return releases.length === 0 ? 'No pending channel messages.' : frame(releases);
  }
  if (name === 'khala_send') {
    const text = String(args?.text ?? '');
    const result = await store.call(sessionId, 'khala_send', {
      bytes: Buffer.byteLength(text),
      sha256: createHash('sha256').update(text).digest('hex'),
    });
    return result ? 'Sent to the Khala channel.' : 'This Claude session is not bound to a Khala channel.';
  }
  if (name === 'khala_status') {
    const result = await store.call(sessionId, 'khala_status');
    if (!result) return 'This Claude session is not bound to a Khala channel.';
    return `Bound to the proof channel; listening mode ${await store.mode()}.`;
  }
  throw new Error(`unknown tool ${name}`);
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

if (store) await store.log('mcp-start', { sessionId, serverPid: process.pid });

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  if (message.method === 'initialize') {
    reply(message.id, {
      protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'khala', version: '0.2.0' },
    });
  } else if (message.method === 'tools/list') {
    reply(message.id, { tools });
  } else if (message.method === 'tools/call') {
    try {
      const text = await call(message.params.name, message.params.arguments);
      reply(message.id, { content: [{ type: 'text', text }] });
    } catch (error) {
      reply(message.id, { content: [{ type: 'text', text: String(error.message) }], isError: true });
    }
  } else if (message.method === 'ping') {
    reply(message.id, {});
  } else {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } })}\n`);
  }
}
