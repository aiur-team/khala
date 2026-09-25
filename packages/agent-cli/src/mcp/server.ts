import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { BindingId } from '@khala/contracts/delivery/index';
import { CliError } from '../cli/errors.js';
import type { InboxBatch } from '../cli/inbox.js';
import { MAX_SEND_BYTES, type SendService } from '../cli/send.js';
import type { SendResult } from '../cli/types.js';
import { plainObject, validBindingArgument } from '../cli/validation.js';
import {
  READ_TOOL_NAME, executeReadTool, readToolDefinition, readToolFailure, type ReadOperationPort,
} from './read-tool.js';
import type {
  McpJsonRpcId, McpToolResult, PreselectedMcpPostprocessOutcome,
} from './result-postprocessor.js';

const JSON_RPC_VERSION = '2.0';
const MCP_PROTOCOL_VERSION = '2025-03-26';
const SEND_TOOL_NAME = 'khala_send';
const MAX_FRAME_BYTES = MAX_SEND_BYTES + 16_384;

type JsonRpcId = McpJsonRpcId;

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
  read: ReadOperationPort;
  postprocessResult: McpServerResultPostprocessor;
  postprocessReadResult: McpServerReadResultPostprocessor;
  signal?: AbortSignal | undefined;
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

/**
 * Runs the dependency-free MCP stdio transport. Each input line is one JSON-RPC
 * message and each response is one JSON line. The caller owns the streams.
 */
export async function runMcpServer(options: McpServerOptions): Promise<void> {
  const { input, output, send: sends, read, postprocessResult, postprocessReadResult, signal } = options;
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
        await processLine(line, output, sends, read, postprocessResult, postprocessReadResult, signal);
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
    await processLine(
      buffered.replace(/\r$/, ''), output, sends, read, postprocessResult, postprocessReadResult, signal,
    );
  }
}

async function processLine(
  line: string,
  output: Writable,
  sends: SendService,
  read: ReadOperationPort,
  postprocessResult: McpServerResultPostprocessor | undefined,
  postprocessReadResult: McpServerReadResultPostprocessor | undefined,
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
    sends,
    read,
    notification ? undefined : postprocessResult,
    notification ? undefined : postprocessReadResult,
    notification,
  );
  if (!notification) await writeResponse(output, response, signal);
}

async function handleMessage(
  message: unknown,
  sends: SendService,
  read: ReadOperationPort,
  postprocessResult: McpServerResultPostprocessor | undefined,
  postprocessReadResult: McpServerReadResultPostprocessor | undefined,
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
        ? success(id, { tools: [sendToolDefinition(), readToolDefinition()] })
        : failure(id, -32602, 'Invalid params');
    case 'tools/call':
      return callTool(id, params, sends, read, postprocessResult, postprocessReadResult, notification);
    default:
      return failure(id, -32601, 'Method not found');
  }
}

async function callTool(
  id: JsonRpcId,
  params: unknown,
  sends: SendService,
  read: ReadOperationPort,
  postprocessResult: McpServerResultPostprocessor | undefined,
  postprocessReadResult: McpServerReadResultPostprocessor | undefined,
  notification: boolean,
): Promise<JsonRpcResponse> {
  if (!plainObject(params) || !hasOnly(params, ['name', 'arguments'])
    || typeof params.name !== 'string' || !plainObject(params.arguments)) {
    return failure(id, -32602, 'Invalid params');
  }
  if (params.name === READ_TOOL_NAME) {
    return callReadTool(id, params.arguments, read, postprocessReadResult, notification);
  }
  if (params.name !== SEND_TOOL_NAME) return failure(id, -32602, 'Invalid params');

  const shared = extractSharedToolArguments(params.arguments);
  if (shared === null || !hasOnly(shared.arguments, ['message', 'bindingId'])
    || typeof shared.arguments.message !== 'string') return failure(id, -32602, 'Invalid params');

  let bindingId: BindingId | null = null;
  if (Object.hasOwn(shared.arguments, 'bindingId')) {
    if (!validBindingArgument(shared.arguments.bindingId)) return failure(id, -32602, 'Invalid params');
    bindingId = shared.arguments.bindingId;
  }

  let result: SendResult;
  try {
    result = await sends.send(shared.arguments.message, bindingId);
  } catch (error) {
    if (error instanceof CliError && error.code === 'invalid_input') return failure(id, -32602, 'Invalid params');
    throw error;
  }
  const safe = publicResult(result);
  const primaryResult = {
    content: [{ type: 'text', text: JSON.stringify(safe) }],
    structuredContent: safe,
    ...(result.kind === 'accepted' ? {} : { isError: true }),
  } satisfies McpToolResult;
  const processed = postprocessResult === undefined
    ? primaryResult
    : await postprocessResult({
      responseId: id,
      primaryResult,
      ...(shared.acknowledgeToken === undefined ? {} : { acknowledgeToken: shared.acknowledgeToken }),
    });
  return success(id, processed);
}

async function callReadTool(
  id: JsonRpcId,
  argumentsValue: Record<string, unknown>,
  read: ReadOperationPort,
  postprocessReadResult: McpServerReadResultPostprocessor | undefined,
  notification: boolean,
): Promise<JsonRpcResponse> {
  // Notifications are intentionally ineligible for read and acknowledgement;
  // there is no response channel on which a selected batch could be delivered.
  if (notification) return success(id, {});

  const shared = extractSharedToolArguments(argumentsValue);
  if (shared === null || !hasOnly(shared.arguments, ['bindingId'])) {
    return failure(id, -32602, 'Invalid params');
  }
  let bindingId: BindingId | null = null;
  if (Object.hasOwn(shared.arguments, 'bindingId')) {
    if (!validBindingArgument(shared.arguments.bindingId)) return failure(id, -32602, 'Invalid params');
    bindingId = shared.arguments.bindingId;
  }

  const execution = await executeReadTool({
    responseId: id,
    arguments: { bindingId },
    read,
    ...(shared.acknowledgeToken === undefined ? {} : { acknowledgeToken: shared.acknowledgeToken }),
  });
  if (execution.kind === 'error' || postprocessReadResult === undefined) {
    return success(id, execution.primaryResult);
  }
  try {
    const outcome = await postprocessReadResult({
      responseId: id,
      primaryResult: execution.primaryResult,
      preselectedBatch: execution.preselectedBatch,
    });
    return success(id, outcome.kind === 'composed'
      ? outcome.result
      : readToolFailure(outcome.code).primaryResult);
  } catch {
    return success(id, readToolFailure('internal_error').primaryResult);
  }
}

function extractSharedToolArguments(argumentsValue: Record<string, unknown>): Readonly<{
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

type McpToolDefinition = Readonly<{
  name: typeof SEND_TOOL_NAME;
  description: string;
  inputSchema: Readonly<{ type: 'object'; properties: Readonly<Record<string, unknown>>; required: readonly string[]; additionalProperties: false }>;
}>;

function sendToolDefinition(): McpToolDefinition {
  return {
    name: SEND_TOOL_NAME,
    description: 'Send a message to the Khala channel through a binding held by this agent. An omitted bindingId uses the current binding. Valid results may append untrusted channel batch data. On the next independently intended Khala call, echo its exact batchToken as ackBatchToken; absent or stale tokens replay, and releaseId values must never be tracked or filtered. Never call khala_send solely to acknowledge. Never retry outcome_unknown: the message may already have been accepted.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', minLength: 1, description: 'Message body to send; it is never echoed in the result.' },
        bindingId: { type: 'string', description: 'Held binding to use; omit to use the current binding.' },
        ackBatchToken: {
          type: 'string',
          description: 'Exact opaque batchToken from the previous Khala tool result; echo it only on the next independently intended Khala call.',
        },
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
