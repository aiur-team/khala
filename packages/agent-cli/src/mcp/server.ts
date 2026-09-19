import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { BindingId } from '@khala/contracts/delivery/index';
import { CliError } from '../cli/errors.js';
import { MAX_SEND_BYTES, type SendService } from '../cli/send.js';
import type { SendResult } from '../cli/types.js';
import { plainObject, validBindingArgument } from '../cli/validation.js';

const JSON_RPC_VERSION = '2.0';
const MCP_PROTOCOL_VERSION = '2025-03-26';
const TOOL_NAME = 'khala_send';
const MAX_FRAME_BYTES = MAX_SEND_BYTES + 16_384;

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
  const decoder = new StringDecoder('utf8');
  let buffered = '';
  let discarding = false;
  const iterator = input[Symbol.asyncIterator]();
  while (!signal?.aborted) {
    const next = await nextChunk(iterator, signal);
    if (next.done) break;
    const chunk = next.value;
    let text = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    if (discarding) {
      const boundary = text.indexOf('\n');
      if (boundary === -1) continue;
      text = text.slice(boundary + 1);
      discarding = false;
    }
    buffered += text;
    let newline = buffered.indexOf('\n');
    while (newline !== -1) {
      const line = buffered.slice(0, newline).replace(/\r$/, '');
      buffered = buffered.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) await writeResponse(output, failure(null, -32600, 'Invalid Request'));
      else if (line.trim().length > 0) await processLine(line, output, sends);
      newline = buffered.indexOf('\n');
    }
    if (Buffer.byteLength(buffered) > MAX_FRAME_BYTES) {
      buffered = '';
      discarding = true;
      await writeResponse(output, failure(null, -32600, 'Invalid Request'));
    }
  }
  if (signal?.aborted) return;
  buffered += decoder.end();
  if (!discarding && buffered.trim().length > 0) await processLine(buffered.replace(/\r$/, ''), output, sends);
}

async function processLine(line: string, output: Writable, sends: SendService): Promise<void> {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    await writeResponse(output, failure(null, -32700, 'Parse error'));
    return;
  }

  const notification = plainObject(message) && !Object.hasOwn(message, 'id');
  const response = await handleMessage(message, sends);
  if (!notification) await writeResponse(output, response);
}

async function handleMessage(message: unknown, sends: SendService): Promise<JsonRpcResponse> {
  if (!plainObject(message) || !hasOnly(message, ['jsonrpc', 'id', 'method', 'params'])
    || message.jsonrpc !== JSON_RPC_VERSION || typeof message.method !== 'string') {
    return failure(requestId(message), -32600, 'Invalid Request');
  }

  const id = requestId(message);
  if (Object.hasOwn(message, 'id') && !validId(message.id)) return failure(null, -32600, 'Invalid Request');

  switch (message.method) {
    case 'initialize':
      if (!validInitializeParams(message.params)) return failure(id, -32602, 'Invalid params');
      return success(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
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
  if (!plainObject(params) || !hasOnly(params, ['name', 'arguments']) || params.name !== TOOL_NAME
    || !plainObject(params.arguments) || !hasOnly(params.arguments, ['message', 'bindingId'])
    || typeof params.arguments.message !== 'string') {
    return failure(id, -32602, 'Invalid params');
  }

  let bindingId: BindingId | null = null;
  if (Object.hasOwn(params.arguments, 'bindingId')) {
    if (!validBindingArgument(params.arguments.bindingId)) return failure(id, -32602, 'Invalid params');
    bindingId = params.arguments.bindingId;
  }

  let result: SendResult;
  try {
    result = await sends.send(params.arguments.message, bindingId);
  } catch (error) {
    if (error instanceof CliError && error.code === 'invalid_input') return failure(id, -32602, 'Invalid params');
    throw error;
  }
  const safe = publicResult(result);
  return success(id, {
    content: [{ type: 'text', text: JSON.stringify(safe) }],
    structuredContent: safe,
    ...(result.kind === 'accepted' ? {} : { isError: true }),
  });
}

type McpToolDefinition = Readonly<{
  name: typeof TOOL_NAME;
  description: string;
  inputSchema: Readonly<{ type: 'object'; properties: Readonly<Record<string, unknown>>; required: readonly string[]; additionalProperties: false }>;
}>;

function toolDefinition(): McpToolDefinition {
  return {
    name: TOOL_NAME,
    description: 'Send a message through a binding held by this agent. An omitted bindingId uses the current binding. Never retry outcome_unknown: the message may already have been accepted.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', minLength: 1, description: 'Message body to send; it is never echoed in the result.' },
        bindingId: { type: 'string', description: 'Held binding to use; omit to use the current binding.' },
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
  if (!plainObject(value) || !hasOnly(value, ['protocolVersion', 'capabilities', 'clientInfo'])) return false;
  if (Object.hasOwn(value, 'protocolVersion') && typeof value.protocolVersion !== 'string') return false;
  if (Object.hasOwn(value, 'capabilities') && !plainObject(value.capabilities)) return false;
  return !Object.hasOwn(value, 'clientInfo') || plainObject(value.clientInfo);
}

function emptyParams(value: unknown): boolean {
  return value === undefined || (plainObject(value) && Object.keys(value).length === 0);
}

function success(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: JSON_RPC_VERSION, id, result };
}

function failure(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: JSON_RPC_VERSION, id, error: { code, message } };
}

function requestId(message: unknown): JsonRpcId {
  if (!plainObject(message) || !Object.hasOwn(message, 'id') || !validId(message.id)) return null;
  return message.id;
}

function validId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value));
}

function hasOnly(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function writeResponse(output: Writable, response: JsonRpcResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    output.write(`${JSON.stringify(response)}\n`, error => error ? reject(error) : resolve());
  });
}

function nextChunk(
  iterator: AsyncIterator<unknown>,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<unknown>> {
  if (signal?.aborted) return Promise.resolve({ done: true, value: undefined });
  const pending = iterator.next();
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const abort = () => resolve({ done: true, value: undefined });
    signal.addEventListener('abort', abort, { once: true });
    pending.then(
      value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}
