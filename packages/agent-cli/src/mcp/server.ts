import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { MAX_SEND_BYTES, type SendService } from '../cli/send.js';
import { ListeningModeOperation } from '../composition/listening-mode.js';
import { plainObject } from '../cli/validation.js';
import type { ListeningModeOperationPort } from './listening-mode-tool.js';
import type { ChannelToolsPort } from './channels/tools.js';
import type { ReadOperationPort } from './read-tool.js';
import { toolRegistry, type ToolRegistry } from './registry.js';
import {
  JSON_RPC_VERSION, failure, hasOnly, success,
  type JsonRpcId, type JsonRpcResponse, type McpServerReadResultPostprocessor,
  type McpServerResultPostprocessor, type McpToolContext,
} from './tool.js';

export type { McpServerReadResultPostprocessor, McpServerResultPostprocessor } from './tool.js';

const MCP_PROTOCOL_VERSION = '2025-03-26';
const MAX_FRAME_BYTES = MAX_SEND_BYTES + 16_384;

export type McpServerOptions = Readonly<{
  input: Readable;
  output: Writable;
  send: SendService;
  read: ReadOperationPort;
  /** Absent means no mode control is composed; the tool then refuses with `unavailable`. */
  listeningMode?: ListeningModeOperationPort | undefined;
  channels: ChannelToolsPort;
  postprocessResult: McpServerResultPostprocessor;
  postprocessReadResult: McpServerReadResultPostprocessor;
  signal?: AbortSignal | undefined;
  tools?: ToolRegistry | undefined;
}>;

type ServerContext = Readonly<{
  send: SendService;
  read: ReadOperationPort;
  listeningMode: ListeningModeOperationPort;
  channels: ChannelToolsPort;
  postprocessResult: McpServerResultPostprocessor | undefined;
  postprocessReadResult: McpServerReadResultPostprocessor | undefined;
  tools: ToolRegistry;
}>;

/**
 * Runs the dependency-free MCP stdio transport. Each input line is one JSON-RPC
 * message and each response is one JSON line. The caller owns the streams.
 */
export async function runMcpServer(options: McpServerOptions): Promise<void> {
  const { input, output, send, read, channels, postprocessResult, postprocessReadResult, signal } = options;
  const context: ServerContext = {
    send,
    read,
    channels,
    listeningMode: options.listeningMode ?? new ListeningModeOperation({ application: null }),
    postprocessResult,
    postprocessReadResult,
    tools: options.tools ?? toolRegistry,
  };
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
    while (newline !== -1 && !signal?.aborted) {
      const line = buffered.slice(0, newline).replace(/\r$/, '');
      buffered = buffered.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
        await writeResponse(output, failure(null, -32600, 'Invalid Request'), signal);
      } else if (line.trim().length > 0) {
        await processLine(line, output, context, signal);
      }
      newline = buffered.indexOf('\n');
    }
    if (signal?.aborted) break;
    if (Buffer.byteLength(buffered) > MAX_FRAME_BYTES) {
      buffered = '';
      discarding = true;
      await writeResponse(output, failure(null, -32600, 'Invalid Request'), signal);
    }
  }
  if (signal?.aborted) return;
  buffered += decoder.end();
  if (!discarding && buffered.trim().length > 0) {
    await processLine(buffered.replace(/\r$/, ''), output, context, signal);
  }
}

async function processLine(
  line: string,
  output: Writable,
  context: ServerContext,
  signal: AbortSignal | undefined,
): Promise<void> {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    await writeResponse(output, failure(null, -32700, 'Parse error'), signal);
    return;
  }

  const notification = plainObject(message) && !Object.hasOwn(message, 'id');
  const response = await handleMessage(
    message,
    notification
      ? { ...context, postprocessResult: undefined, postprocessReadResult: undefined }
      : context,
    notification,
  );
  if (!notification) await writeResponse(output, response, signal);
}

async function handleMessage(
  message: unknown,
  context: ServerContext,
  notification: boolean,
): Promise<JsonRpcResponse> {
  if (!plainObject(message) || !hasOnly(message, ['jsonrpc', 'id', 'method', 'params'])
    || message.jsonrpc !== JSON_RPC_VERSION || typeof message.method !== 'string') {
    return failure(requestId(message), -32600, 'Invalid Request');
  }

  const id = requestId(message);
  if (Object.hasOwn(message, 'id') && !validId(message.id)) return failure(null, -32600, 'Invalid Request');
  const params = withoutMeta(message.params);
  if (params === INVALID_META) return failure(id, -32602, 'Invalid params');

  switch (message.method) {
    case 'initialize':
      if (!validInitializeParams(params)) return failure(id, -32602, 'Invalid params');
      return success(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'khala-agent-cli', version: '0.0.0' },
      });
    case 'ping':
      return emptyParams(params) ? success(id, {}) : failure(id, -32602, 'Invalid params');
    case 'tools/list':
      return emptyParams(params)
        ? success(id, { tools: context.tools.definitions() })
        : failure(id, -32602, 'Invalid params');
    case 'tools/call':
      return callTool(id, params, context, notification);
    default:
      return failure(id, -32601, 'Method not found');
  }
}

async function callTool(
  id: JsonRpcId,
  params: unknown,
  context: ServerContext,
  notification: boolean,
): Promise<JsonRpcResponse> {
  if (!plainObject(params) || !hasOnly(params, ['name', 'arguments'])
    || typeof params.name !== 'string' || !plainObject(params.arguments)) {
    return failure(id, -32602, 'Invalid params');
  }
  const tool = context.tools.resolve(params.name);
  if (tool === undefined) return failure(id, -32602, 'Invalid params');
  const toolContext: McpToolContext = {
    id,
    notification,
    send: context.send,
    read: context.read,
    listeningMode: context.listeningMode,
    channels: context.channels,
    postprocessResult: context.postprocessResult,
    postprocessReadResult: context.postprocessReadResult,
  };
  return tool.call(params.arguments, toolContext);
}

function validInitializeParams(value: unknown): value is { protocolVersion?: string } {
  if (value === undefined) return true;
  if (!plainObject(value) || !hasOnly(value, ['protocolVersion', 'capabilities', 'clientInfo'])) return false;
  if (Object.hasOwn(value, 'protocolVersion') && typeof value.protocolVersion !== 'string') return false;
  if (Object.hasOwn(value, 'capabilities') && !plainObject(value.capabilities)) return false;
  return !Object.hasOwn(value, 'clientInfo') || plainObject(value.clientInfo);
}

const INVALID_META = Symbol('invalid _meta');

// MCP reserves `_meta` on every request's params; Codex 0.154.0 sends
// `{ _meta: { progressToken } }` on `tools/list`. Accept and ignore an object
// `_meta` so the strict per-method checks below see only method parameters.
function withoutMeta(value: unknown): unknown {
  if (!plainObject(value) || !Object.hasOwn(value, '_meta')) return value;
  const { _meta: meta, ...rest } = value;
  return plainObject(meta) ? rest : INVALID_META;
}

function emptyParams(value: unknown): boolean {
  return value === undefined || (plainObject(value) && Object.keys(value).length === 0);
}

function requestId(message: unknown): JsonRpcId {
  if (!plainObject(message) || !Object.hasOwn(message, 'id') || !validId(message.id)) return null;
  return message.id;
}

function validId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value));
}

function writeResponse(
  output: Writable,
  response: JsonRpcResponse,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    output.write(`${JSON.stringify(response)}\n`, finish);
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
