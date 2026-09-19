import type { Readable, Writable } from 'node:stream';
import { cliErrorCode } from '../cli/errors.js';
import type { SendService } from '../cli/send.js';
import type { SendResult } from '../cli/types.js';
import { validIdentifier } from '../cli/validation.js';

const JSON_RPC_VERSION = '2.0';
const MCP_PROTOCOL_VERSION = '2025-03-26';
const TOOL_NAME = 'khala_send';

type JsonRpcId = string | number | null;

type JsonRpcResponse = Readonly<{
  jsonrpc: typeof JSON_RPC_VERSION;
  id: JsonRpcId;
  result?: unknown;
  error?: Readonly<{ code: number; message: string }>;
}>;

export type McpServerOptions = Readonly<{
  input: Readable;
  output: Writable;
  send: SendService;
  signal?: AbortSignal | undefined;
}>;

/**
 * Runs the dependency-free MCP stdio transport. Each input line is one JSON-RPC
 * message and each response is one JSON line. The caller owns the streams.
 */
export async function runMcpServer(options: McpServerOptions): Promise<void> {
  const { input, output, send: sends, signal } = options;
  let buffered = '';
  for await (const chunk of input) {
    if (signal?.aborted) break;
    buffered += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    let newline = buffered.indexOf('\n');
    while (newline !== -1) {
      const line = buffered.slice(0, newline).replace(/\r$/, '');
      buffered = buffered.slice(newline + 1);
      if (line.trim().length > 0) await processLine(line, output, sends);
      newline = buffered.indexOf('\n');
    }
  }
  if (buffered.trim().length > 0) await processLine(buffered.replace(/\r$/, ''), output, sends);
}

async function processLine(line: string, output: Writable, sends: SendService): Promise<void> {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    await writeResponse(output, failure(null, -32700, 'Parse error'));
    return;
  }

  const notification = isRecord(message) && !Object.hasOwn(message, 'id');
  const response = await handleMessage(message, sends);
  if (!notification) await writeResponse(output, response);
}

async function handleMessage(message: unknown, sends: SendService): Promise<JsonRpcResponse> {
  if (!isRecord(message) || !hasOnly(message, ['jsonrpc', 'id', 'method', 'params'])
    || message.jsonrpc !== JSON_RPC_VERSION || typeof message.method !== 'string') {
    return failure(requestId(message), -32600, 'Invalid Request');
  }

  const id = requestId(message);
  if (Object.hasOwn(message, 'id') && !validId(message.id)) return failure(null, -32600, 'Invalid Request');

  switch (message.method) {
    case 'initialize':
      if (!validInitializeParams(message.params)) return failure(id, -32602, 'Invalid params');
      return success(id, {
        protocolVersion: typeof message.params?.protocolVersion === 'string'
          ? message.params.protocolVersion
          : MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'khala-agent-cli', version: '0.0.0' },
      });
    case 'ping':
      return emptyParams(message.params) ? success(id, {}) : failure(id, -32602, 'Invalid params');
    case 'tools/list':
      return emptyParams(message.params) ? success(id, { tools: [toolDefinition()] }) : failure(id, -32602, 'Invalid params');
    case 'tools/call':
      return callTool(id, message.params, sends);
    default:
      return failure(id, -32601, 'Method not found');
  }
}

async function callTool(id: JsonRpcId, params: unknown, sends: SendService): Promise<JsonRpcResponse> {
  if (!isRecord(params) || !hasOnly(params, ['name', 'arguments']) || params.name !== TOOL_NAME
    || !isRecord(params.arguments) || !hasOnly(params.arguments, ['message', 'bindingId'])
    || typeof params.arguments.message !== 'string') {
    return failure(id, -32602, 'Invalid params');
  }

  let bindingId: string | null = null;
  if (Object.hasOwn(params.arguments, 'bindingId')) {
    if (!validIdentifier(params.arguments.bindingId)) return failure(id, -32602, 'Invalid params');
    bindingId = params.arguments.bindingId;
  }

  let result: SendResult;
  try {
    result = await sends.send(params.arguments.message, bindingId);
  } catch (error) {
    result = { kind: 'refused', code: cliErrorCode(error), clientTxnId: 'unavailable' };
  }
  const safe = publicResult(result);
  return success(id, {
    content: [{ type: 'text', text: JSON.stringify(safe) }],
    structuredContent: safe,
    ...(result.kind === 'accepted' ? {} : { isError: true }),
  });
}

function toolDefinition(): unknown {
  return {
    name: TOOL_NAME,
    description: 'Send a message to a Khala room through a binding held by this agent.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', minLength: 1 },
        bindingId: { type: 'string' },
      },
      required: ['message'],
      additionalProperties: false,
    },
  };
}

function publicResult(result: SendResult): Record<string, string | null> {
  if (result.kind === 'accepted') {
    return { kind: result.kind, clientTxnId: result.clientTxnId, eventId: result.eventId };
  }
  if (result.kind === 'refused') {
    return { kind: result.kind, code: result.code, clientTxnId: result.clientTxnId };
  }
  return { kind: result.kind, clientTxnId: result.clientTxnId };
}

function validInitializeParams(value: unknown): value is { protocolVersion?: string } {
  if (value === undefined) return true;
  if (!isRecord(value) || !hasOnly(value, ['protocolVersion', 'capabilities', 'clientInfo'])) return false;
  if (Object.hasOwn(value, 'protocolVersion') && typeof value.protocolVersion !== 'string') return false;
  if (Object.hasOwn(value, 'capabilities') && !isRecord(value.capabilities)) return false;
  return !Object.hasOwn(value, 'clientInfo') || isRecord(value.clientInfo);
}

function emptyParams(value: unknown): boolean {
  return value === undefined || (isRecord(value) && Object.keys(value).length === 0);
}

function success(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: JSON_RPC_VERSION, id, result };
}

function failure(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: JSON_RPC_VERSION, id, error: { code, message } };
}

function requestId(message: unknown): JsonRpcId {
  if (!isRecord(message) || !Object.hasOwn(message, 'id') || !validId(message.id)) return null;
  return message.id;
}

function validId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnly(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function writeResponse(output: Writable, response: JsonRpcResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    output.write(`${JSON.stringify(response)}\n`, error => error ? reject(error) : resolve());
  });
}
