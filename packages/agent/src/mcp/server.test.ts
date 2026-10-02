import { Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createToolRegistry } from './registry';
import { runMcpServer } from './server';
import { success, type McpTool, type McpToolContext } from './tool';

const request = (id: number, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const probe = (call: McpTool['call'] = async (_args, { id }) => success(id, { content: [{ type: 'text', text: 'hello' }] })): McpTool => ({
  name: 'khala_probe',
  definition: () => ({ name: 'khala_probe', description: 'probe', inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }),
  call,
});
const call = (id: number, args = {}, meta?: unknown) => request(id, 'tools/call', { name: 'khala_probe', arguments: args, ...(meta === undefined ? {} : { _meta: meta }) });
async function exchange(chunks: readonly (string | Buffer)[], tool = probe()) {
  let outputText = '';
  const output = new Writable({ write(chunk, _encoding, done) { outputText += chunk.toString(); done(); } });
  await runMcpServer({ input: Readable.from(chunks), output, tools: createToolRegistry([tool]) });
  return outputText.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
const lines = (...messages: unknown[]) => [messages.map(message => JSON.stringify(message) + '\n').join('')];

class BlockingWritable extends Writable {
  readonly callbacks: Array<() => void> = [];
  readonly waiters: Array<() => void> = [];
  writes = 0;
  override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    this.writes++;
    this.callbacks.push(callback);
    this.waiters.splice(0).forEach(resolve => resolve());
  }
  async waitForWrite(count = 1) {
    while (this.writes < count) await new Promise<void>(resolve => this.waiters.push(resolve));
  }
  completeWrite() { this.callbacks.shift()?.(); }
}

describe('harvested MCP transport', () => {
  it('uses the supported protocol and default server identity', async () => {
    const [response] = await exchange(lines(request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} })));
    expect(response).toEqual(success(1, { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'khala', version: '0.0.0' } }));
  });
  it('accepts reserved object metadata and rejects bad metadata or extra method parameters', async () => {
    const meta = { _meta: { progressToken: 0 } };
    const responses = await exchange(lines(
      request(1, 'initialize', { ...meta, protocolVersion: '2099-01-01', capabilities: {} }),
      request(2, 'tools/list', meta), request(3, 'ping', meta),
      request(4, 'tools/list', { _meta: 'x' }), request(5, 'tools/list', { ...meta, cursor: 'next' }),
    ));
    expect(responses.map(response => response.error?.code ?? 'ok')).toEqual(['ok', 'ok', 'ok', -32602, -32602]);
  });
  it('passes request metadata to the tool and suppresses notification responses', async () => {
    const contexts: McpToolContext[] = [];
    const tool = probe(async (_args, context) => { contexts.push(context); return success(context.id, {}); });
    const notification = { jsonrpc: '2.0', method: 'tools/call', params: { name: 'khala_probe', arguments: {} } };
    expect(await exchange(lines(call(2, {}, { threadId: 't-1' }), notification), tool)).toEqual([success(2, {})]);
    expect(contexts).toEqual([{ id: 2, notification: false, meta: { threadId: 't-1' } }, { id: null, notification: true, meta: undefined }]);
  });
  it('suppresses tool exception details and keeps serving requests', async () => {
    const responses = await exchange(lines(call(1), request(2, 'ping')), probe(async () => { throw new Error('secret-x'); }));
    expect(responses).toMatchObject([{ result: { isError: true, structuredContent: { error: 'internal_error' }, content: [{ type: 'text', text: '{"error":"internal_error"}' }] } }, { id: 2, result: {} }]);
    expect(JSON.stringify(responses)).not.toContain('secret-x');
  });
  it('decodes multibyte arguments split across chunks', async () => {
    const seen = vi.fn(async (args, context) => success(context.id, args));
    const encoded = Buffer.from(lines(call(1, { text: 'hello 🌍' }))[0]!);
    const split = encoded.indexOf(Buffer.from('🌍')) + 1;
    const responses = await exchange([encoded.subarray(0, split), encoded.subarray(split)], probe(seen));
    expect(responses[0].result).toEqual({ text: 'hello 🌍' });
  });
  it('resolves when an idle input is aborted without destroying the streams', async () => {
    const input = new Readable({ read() {} });
    const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const abort = new AbortController();
    const running = runMcpServer({ input, output, tools: createToolRegistry([]), signal: abort.signal });
    abort.abort();
    await expect(running).resolves.toBeUndefined();
    expect(input.destroyed).toBe(false);
    expect(output.destroyed).toBe(false);
    input.destroy(); output.destroy();
  });
  it('bounds oversized frames and resumes at the next newline', async () => {
    expect(await exchange(['x'.repeat(90_000), '\n' + lines(request(2, 'ping'))[0]])).toMatchObject([{ error: { code: -32600 } }, { id: 2, result: {} }]);
  });
  it('handles malformed JSON, invalid ids and unknown methods', async () => {
    expect(await exchange(['bad\n', ...lines({ jsonrpc: '2.0', id: {}, method: 'ping' }, request(3, 'unknown'))])).toMatchObject([{ error: { code: -32700 } }, { error: { code: -32600 } }, { id: 3, error: { code: -32601 } }]);
  });
  it('waits for each response write before processing pipelined calls', async () => {
    const seen = vi.fn(async (_args, context) => success(context.id, {}));
    const output = new BlockingWritable();
    const running = runMcpServer({ input: Readable.from(lines(call(40), call(41))), output, tools: createToolRegistry([probe(seen)]) });
    await output.waitForWrite();
    expect(seen).toHaveBeenCalledTimes(1);
    output.completeWrite();
    await output.waitForWrite(2);
    output.completeWrite();
    await running;
    expect(seen).toHaveBeenCalledTimes(2);
  });
  it('aborts blocked writes without processing queued work or destroying caller streams', async () => {
    const seen = vi.fn(async (_args, context) => success(context.id, {}));
    let supplied = false;
    const input = new Readable({ read() { if (!supplied) { supplied = true; this.push(lines(call(50), call(51))[0]); } } });
    const output = new BlockingWritable();
    const abort = new AbortController();
    const running = runMcpServer({ input, output, tools: createToolRegistry([probe(seen)]), signal: abort.signal });
    await output.waitForWrite();
    abort.abort();
    await expect(running).resolves.toBeUndefined();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(input.destroyed).toBe(false);
    expect(output.destroyed).toBe(false);
    output.completeWrite(); input.destroy(); output.destroy();
  });
});
