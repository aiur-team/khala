import { listAgentsTool, listChannelsTool } from './channels/tools.js';
import { readTool } from './tools/read.js';
import { sendTool } from './tools/send.js';
import type { McpTool, McpToolDefinition } from './tool.js';

const TOOL_NAME = /^[a-z][a-z0-9_]*$/;

export class ToolRegistryError extends Error {
  constructor(readonly reason: 'invalid_name' | 'duplicate_tool', readonly toolName: string) {
    super(`${reason}: ${toolName}`);
    this.name = 'ToolRegistryError';
  }
}

export type ToolRegistry = Readonly<{
  /** Returns the registered tool, or `undefined` for any name that is not registered. */
  resolve(name: string): McpTool | undefined;
  /** Definitions in registration order, as advertised by `tools/list`. */
  definitions(): readonly McpToolDefinition[];
}>;

/** Fails loudly on a malformed or duplicate name; a registry never drops or overrides an entry. */
export function createToolRegistry(tools: readonly McpTool[]): ToolRegistry {
  const byName = new Map<string, McpTool>();
  for (const tool of tools) {
    if (!TOOL_NAME.test(tool.name)) throw new ToolRegistryError('invalid_name', tool.name);
    if (byName.has(tool.name)) throw new ToolRegistryError('duplicate_tool', tool.name);
    byName.set(tool.name, tool);
  }
  const ordered = [...byName.values()];
  return Object.freeze({
    resolve: (name: string) => byName.get(name),
    definitions: () => ordered.map(tool => tool.definition()),
  });
}

/** Built-in tools. A new tool is one file under `tools/` plus one line here. */
export const MCP_TOOLS: readonly McpTool[] = Object.freeze([sendTool, readTool, listChannelsTool, listAgentsTool]);

export const toolRegistry: ToolRegistry = createToolRegistry(MCP_TOOLS);
