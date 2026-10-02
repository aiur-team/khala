import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { append, stateRoot, validId } from './hooks/state.mjs';

const root = path.join(stateRoot(), 'claude');
for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  if (request.id === undefined) continue;
  let result;
  let error;
  if (request.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'khala-spike-probe', version: '0.0.1' } };
  else if (request.method === 'tools/list') result = { tools: [{ name: 'khala_spike_probe', description: 'Record session environment for the isolated wake spike', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] };
  else if (request.method === 'tools/call' && request.params?.name === 'khala_spike_probe') {
    for (const session of await readdir(root).catch(e => { if (e.code === 'ENOENT') return []; throw e; })) {
      if (!validId(session)) continue;
      const file = path.join(root, session, 'spike-log.jsonl');
      if (await access(file).then(() => true, () => false)) await append(file, { at: new Date().toISOString(), role: 'mcp-probe', envSessionId: process.env.CLAUDE_CODE_SESSION_ID ?? null, metaThreadId: request.params._meta?.threadId ?? null, xdgStateHome: process.env.XDG_STATE_HOME ?? null });
    }
    result = { content: [{ type: 'text', text: 'probe recorded' }] };
  } else error = { code: -32601, message: 'Method or tool not found' };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(error ? { error } : { result }) }) + '\n');
}
