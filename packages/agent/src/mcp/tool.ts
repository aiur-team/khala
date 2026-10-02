export const JSON_RPC_VERSION = '2.0';

export type JsonRpcId = string | number | null;

export type JsonRpcResponse = Readonly<{
  jsonrpc: typeof JSON_RPC_VERSION;
  id: JsonRpcId;
  result?: unknown;
  error?: Readonly<{ code: number; message: string }>;
}>;

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

export type McpToolContext = Readonly<{ id: JsonRpcId; notification: boolean; meta: Readonly<Record<string, unknown>> | undefined }>;

/** One tool supplied to the registry by the caller. */
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

export function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}


export function toolError(code: string) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: code }) }], structuredContent: { error: code }, isError: true };
}
