import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ToolRegistryError, createToolRegistry } from './registry';
import { runMcpServer } from './server';
import { failure, success, type McpTool } from './tool';

const tool = (name: string, text = name): McpTool => ({
  name,
  definition: () => ({
    name, description: text, inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  }),
  call: async (_arguments, { id }) => success(id, { content: [{ type: 'text', text }] }),
});

async function exchange(tools: ReturnType<typeof createToolRegistry>, messages: unknown[]) {
  const lines: string[] = [];
  const output = new Writable({ write(chunk, _e, done) { lines.push(String(chunk)); done(); } });
  await runMcpServer({
    input: Readable.from([messages.map(message => JSON.stringify(message) + '\n').join('')]), output, tools,
  });
  return lines.flatMap(chunk => chunk.split('\n').filter(Boolean)).map(line => JSON.parse(line));
}

describe('MCP tool registry', () => {
  it('rejects duplicate tool names', () => {
    expect(() => createToolRegistry([tool('khala_x'), tool('khala_x')])).toThrowError(ToolRegistryError);
    expect(() => createToolRegistry([tool('khala_x'), tool('khala_x')])).toThrow(/duplicate_tool: khala_x/);
    try { createToolRegistry([tool('khala_x'), tool('khala_x')]); }
    catch (error) { expect(error).toMatchObject({ reason: 'duplicate_tool' }); }
  });
  it('rejects malformed names and resolves nothing unknown', () => {
    for (const name of ['', 'Khala', 'a-b', '__proto__']) {
      expect(() => createToolRegistry([tool(name)])).toThrow(/invalid_name/);
    }
    const registry = createToolRegistry([]);
    for (const name of ['nope', 'constructor', '__proto__']) expect(registry.resolve(name)).toBeUndefined();
  });
  it('answers an unknown tool call with Invalid params', async () => {
    const [response] = await exchange(createToolRegistry([]), [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'khala_nope', arguments: {} } },
    ]);
    expect(response).toEqual(failure(1, -32602, 'Invalid params'));
  });
  it('advertises and calls only the supplied tools in registration order', async () => {
    const registry = createToolRegistry([tool('khala_probe', 'hello')]);
    const [list, call] = await exchange(registry, [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'khala_probe', arguments: {} } },
    ]);
    expect(list.result.tools.map((entry: { name: string }) => entry.name)).toEqual(['khala_probe']);
    expect(call.result).toEqual({ content: [{ type: 'text', text: 'hello' }] });
    expect(createToolRegistry([tool('first'), tool('second')]).definitions().map(entry => entry.name)).toEqual(['first', 'second']);
  });
});
