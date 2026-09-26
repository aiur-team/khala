import type { SendService } from '../cli/send.js';
import type { InboxBatch } from '../cli/inbox.js';
import type { ListeningModeOperationPort } from './listening-mode-tool.js';
import type { ChannelToolsPort } from './channels/tools.js';
import type { PairToolPort } from './pair.js';
import type { ReadOperationPort } from './read-tool.js';
import type { McpJsonRpcId, McpToolResult, PreselectedMcpPostprocessOutcome } from './result-postprocessor.js';

export const JSON_RPC_VERSION = '2.0';

export type JsonRpcId = McpJsonRpcId;

export type JsonRpcResponse = Readonly<{
  jsonrpc: typeof JSON_RPC_VERSION;
  id: JsonRpcId;
  result?: unknown;
  error?: Readonly<{ code: number; message: string }>;
}>;

export type McpServerResultPostprocessor = (
  input: Readonly<{
    responseId: McpJsonRpcId;
    primaryResult: McpToolResult;
    acknowledgeToken?: string;
  }>,
) => Promise<McpToolResult>;

export type McpServerReadResultPostprocessor = (
  input: Readonly<{
    responseId: McpJsonRpcId;
    primaryResult: McpToolResult;
    preselectedBatch: InboxBatch | null;
  }>,
) => Promise<PreselectedMcpPostprocessOutcome>;

export type McpToolDefinition = Readonly<{
  name: string;
  description: string;
  inputSchema: Readonly<{
    type: 'object';
    properties: Readonly<Record<string, unknown>>;
    required: readonly string[];
    additionalProperties: false;
  }>;
}>;

/** Per-call collaborators handed to a tool; postprocessors are absent for notifications. */
export type McpToolContext = Readonly<{
  id: JsonRpcId;
  notification: boolean;
  send: SendService;
  read: ReadOperationPort;
  listeningMode: ListeningModeOperationPort;
  channels: ChannelToolsPort;
  pair: PairToolPort;
  postprocessResult: McpServerResultPostprocessor | undefined;
  postprocessReadResult: McpServerReadResultPostprocessor | undefined;
}>;

/** One MCP tool. Adding a tool is one file exporting this plus one line in `registry.ts`. */
export type McpTool = Readonly<{
  name: string;
  definition(): McpToolDefinition;
  call(argumentsValue: Record<string, unknown>, context: McpToolContext): Promise<JsonRpcResponse>;
}>;

export function success(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: JSON_RPC_VERSION, id, result };
}

export function failure(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: JSON_RPC_VERSION, id, error: { code, message } };
}

export function hasOnly(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

export function extractSharedToolArguments(argumentsValue: Record<string, unknown>): Readonly<{
  arguments: Record<string, unknown>;
  acknowledgeToken?: string;
}> | null {
  const { ackBatchToken, ...toolArguments } = argumentsValue;
  if (ackBatchToken !== undefined && typeof ackBatchToken !== 'string') return null;
  return {
    arguments: toolArguments,
    ...(ackBatchToken === undefined ? {} : { acknowledgeToken: ackBatchToken }),
  };
}
