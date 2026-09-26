import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MCP_TOOLS, ToolRegistryError, createToolRegistry, toolRegistry } from './registry.js';
import { runMcpServer } from './server.js';
import { failure, success, type McpTool } from './tool.js';

const tool = (name: string, text = name): McpTool => ({
  name,
  definition: () => ({
    name, description: text, inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  }),
  call: async (_arguments, { id }) => success(id, { content: [{ type: 'text', text }] }),
});

async function exchange(tools: ReturnType<typeof createToolRegistry> | undefined, messages: unknown[]) {
  const lines: string[] = [];
  const output = new Writable({ write(chunk, _e, done) { lines.push(String(chunk)); done(); } });
  await runMcpServer({
    input: Readable.from([messages.map(message => JSON.stringify(message) + '\n').join('')]),
    output,
    send: {} as never,
    read: {} as never,
    postprocessResult: async ({ primaryResult }) => primaryResult,
    postprocessReadResult: async () => { throw new Error('unexpected'); },
    ...(tools === undefined ? {} : { tools }),
  });
  return lines.flatMap(chunk => chunk.split('\n').filter(Boolean)).map(line => JSON.parse(line));
}

describe('MCP tool registry', () => {
  it('registers exactly the existing tools in list order', () => {
    expect(MCP_TOOLS.map(entry => entry.name)).toEqual(['khala_send', 'khala_read']);
    expect(toolRegistry.definitions().map(entry => entry.name)).toEqual(['khala_send', 'khala_read']);
  });

  it('rejects a duplicate tool name instead of dropping or overriding it', () => {
    expect(() => createToolRegistry([tool('khala_x'), tool('khala_x', 'other')])).toThrowError(ToolRegistryError);
    expect(() => createToolRegistry([...MCP_TOOLS, tool('khala_send')])).toThrow(/duplicate_tool: khala_send/);
  });

  it('rejects malformed names and resolves nothing unknown', () => {
    for (const name of ['', 'Khala', 'a-b', '__proto__']) {
      expect(() => createToolRegistry([tool(name)])).toThrow(/invalid_name/);
    }
    for (const name of ['nope', 'constructor', '__proto__']) expect(toolRegistry.resolve(name)).toBeUndefined();
  });

  it('answers an unknown tool call with Invalid params', async () => {
    const [response] = await exchange(undefined, [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'khala_nope', arguments: {} } },
    ]);
    expect(response).toEqual({ jsonrpc: '2.0', id: 1, error: failure(1, -32602, 'Invalid params').error });
  });

  it('adds a tool with one new definition and one registry entry', async () => {
    const registry = createToolRegistry([...MCP_TOOLS, tool('khala_probe', 'hello')]);
    const [list, call] = await exchange(registry, [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'khala_probe', arguments: {} } },
    ]);
    expect(list.result.tools.map((entry: { name: string }) => entry.name)).toEqual(['khala_send', 'khala_read', 'khala_probe']);
    expect(call.result).toEqual({ content: [{ type: 'text', text: 'hello' }] });

    const [refused] = await exchange(undefined, [
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'khala_probe', arguments: {} } },
    ]);
    expect(refused.error.code).toBe(-32602);
  });
});
