import type { Readable, Writable } from 'node:stream';
import type { BindingId, SessionBinding } from '@khala/contracts/delivery/index';
import { ReadOperation, sameHeldBinding } from '../composition/read.js';
import { CliError, cliErrorCode } from './errors.js';
import type { BatchInbox, InboxItem } from './inbox.js';
import { runInternal } from './internal.js';
import { parseReadArguments, renderReadOutput } from './read.js';
import { MAX_SEND_BYTES, SendService } from './send.js';
import {
  AGENT_ROUTES, CONNECT_REFUSAL_CODES, type AgentClientPort, type AgentStatus, type ConnectRefusalCode,
  type InternalRuntimeLoader,
} from './types.js';
import { plainObject, validBindingArgument, validIdentifier } from './validation.js';
import {
  postprocessMcpResult, postprocessPreselectedMcpResult, type McpPostprocessSuppression,
} from '../mcp/result-postprocessor.js';
import { runMcpServer } from '../mcp/server.js';

export type CliDependencies = Readonly<{
  client: AgentClientPort;
  inbox: (bindingId: string, generation: number) => Promise<BatchInbox>;
  stdin: Readable; stdout: Writable; stderr: Writable; signal?: AbortSignal;
  internal?: InternalRuntimeLoader; env?: Readonly<Record<string, string | undefined>>; cwd?: string;
}>;

export async function runCli(argv: readonly string[], deps: CliDependencies): Promise<number> {
  try {
    const [command, ...args] = argv;
    switch (command) {
      case 'connect': return await connect(args, deps);
      case 'listen': return await listen(args, deps);
      case 'read': return await read(args, deps);
      case 'send': return await send(args, deps);
      case 'status': return await status(args, deps);
      case 'mcp-serve': return await mcp(args, deps);
      case 'internal': return await runInternal(args, deps);
      default: throw new CliError('invalid_arguments');
    }
  } catch (error) {
    await write(deps.stderr, JSON.stringify({ ok: false, error: cliErrorCode(error) }) + '\n');
    return 2;
  }
}

async function connect(args: readonly string[], deps: CliDependencies): Promise<number> {
  if (args.length !== 1 || !validLink(args[0])) throw new CliError('invalid_link');
  const result = publicConnectResult(await deps.client.connect(args[0]!, deps.signal));
  if (result.kind === 'unavailable') throw new CliError('transport_unavailable');
  if (result.kind === 'refused') { await write(deps.stdout, JSON.stringify({ ok: false, error: result.code }) + '\n'); return 3; }
  await write(deps.stdout, JSON.stringify({ ok: true, binding: result.binding, reused: result.reused }) + '\n');
  return 0;
}

async function send(args: readonly string[], deps: CliDependencies): Promise<number> {
  const bindingId = optionalBinding(args);
  const body = await readStdin(deps.stdin, MAX_SEND_BYTES);
  const result = await new SendService(deps.client).send(body, bindingId, undefined, deps.signal);
  await write(deps.stdout, JSON.stringify(publicSendOutput(result)) + '\n');
  return result.kind === 'accepted' ? 0 : result.kind === 'refused' ? 3 : 4;
}

async function listen(args: readonly string[], deps: CliDependencies): Promise<number> {
  const requested = optionalBinding(args);
  const current = publicStatus(await deps.client.status(deps.signal));
  if (!current.binding || !current.connected) throw new CliError('not_connected');
  if (requested !== null && requested !== current.binding.bindingId) throw new CliError('binding_not_held');
  const inbox = await deps.inbox(current.binding.bindingId, current.binding.generation);
  const lock = await inbox.acquireListener();
  try {
    let idleDelay = 50;
    while (!deps.signal?.aborted) {
      const item = await inbox.readNext();
      if (item === null) {
        await waitForSignal(deps.signal, idleDelay);
        idleDelay = Math.min(idleDelay * 2, 1_000);
        continue;
      }
      idleDelay = 50;
      await write(deps.stdout, renderInboxItem(item) + '\n');
      await inbox.acknowledge(item);
    }
  } finally { await lock.release(); }
  return 0;
}

async function read(args: readonly string[], deps: CliDependencies): Promise<number> {
  const input = parseReadArguments(args);
  const current = publicStatus(await deps.client.status(deps.signal));
  if (!current.connected || current.binding === null) throw new CliError('not_connected');
  const heldBinding = current.binding;
  if (input.bindingId !== null && input.bindingId !== heldBinding.bindingId) {
    throw new CliError('binding_not_held');
  }

  const inbox = await deps.inbox(heldBinding.bindingId, heldBinding.generation);
  const consumer = await inbox.acquireListener();
  try {
    const operation = new ReadOperation({
      heldBinding,
      consumer,
      currentBinding: async () => {
        const latest = publicStatus(await deps.client.status(deps.signal));
        return latest.connected ? latest.binding : null;
      },
    });
    const result = await operation.read({ ...input, maxBytes: MAX_SEND_BYTES });
    await write(deps.stdout, renderReadOutput(result) + '\n');
  } finally {
    await consumer.release();
  }
  return 0;
}

async function status(args: readonly string[], deps: CliDependencies): Promise<number> {
  if (args.length !== 0) throw new CliError('invalid_arguments');
  const current = publicStatus(await deps.client.status(deps.signal));
  let inbox = null;
  if (current.binding) inbox = await (await deps.inbox(current.binding.bindingId, current.binding.generation)).status();
  await write(deps.stdout, JSON.stringify({ ...current, inbox }) + '\n');
  return 0;
}

async function mcp(args: readonly string[], deps: CliDependencies): Promise<number> {
  if (args.length !== 0) throw new CliError('invalid_arguments');
  const current = publicStatus(await deps.client.status(deps.signal));
  if (!current.connected || current.binding === null) throw new CliError('not_connected');
  const heldBinding = current.binding;
  const inbox = await deps.inbox(heldBinding.bindingId, heldBinding.generation);
  const consumer = await inbox.acquireListener();
  try {
    const currentBinding = async () => {
      const latest = publicStatus(await deps.client.status(deps.signal));
      return latest.connected ? latest.binding : null;
    };
    // Suppressed batches fail open to the plain tool result; report the
    // content-free stage and code so the operator can see why nothing arrived.
    const onSuppressed = (suppression: McpPostprocessSuppression) => {
      deps.stderr.write(JSON.stringify({ ok: false, warning: 'batch_suppressed', ...suppression }) + '\n');
    };
    await runMcpServer({
      input: deps.stdin,
      output: deps.stdout,
      send: new SendService(deps.client),
      read: new ReadOperation({ heldBinding, consumer, currentBinding }),
      postprocessResult: input => postprocessMcpResult({
        ...input,
        consumer,
        isCurrentBinding: async () => sameHeldBinding(heldBinding, await currentBinding()),
        onSuppressed,
      }),
      postprocessReadResult: input => postprocessPreselectedMcpResult({
        ...input,
        isCurrentBinding: async () => sameHeldBinding(heldBinding, await currentBinding()),
        onSuppressed,
      }),
      signal: deps.signal,
    });
  } finally {
    await consumer.release();
  }
  return 0;
}

function optionalBinding(args: readonly string[]): BindingId | null {
  if (args.length === 0) return null;
  if (args.length !== 2 || args[0] !== '--binding' || !validBindingArgument(args[1])) throw new CliError('invalid_arguments');
  return args[1]!;
}
function validLink(value: string | undefined): value is string {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && parsed.hash === '';
  } catch { return false; }
}
export async function readStdin(input: Readable, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += bytes.byteLength;
    if (size > limit) throw new CliError('invalid_input');
    chunks.push(bytes);
  }
  let body: string;
  try { body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new CliError('invalid_input'); }
  if (body.length === 0 || body.includes('\u0000')) throw new CliError('invalid_input');
  return body;
}
function renderInboxItem(item: InboxItem): string {
  return JSON.stringify({ v: 1, releaseId: item.record.releaseId, bindingId: item.record.bindingId,
    generation: item.record.generation, events: item.record.events, payloadBase64: Buffer.from(item.payload).toString('base64') });
}
function write(stream: Writable, value: string): Promise<void> {
  return new Promise((resolve, reject) => stream.write(value, error => error ? reject(error) : resolve()));
}
function waitForSignal(signal: AbortSignal | undefined, milliseconds: number): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => done();
    function done() { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(); }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function publicConnectResult(value: unknown) {
  if (!plainObject(value)) throw new CliError('transport_unavailable');
  if (value.kind === 'unavailable') return { kind: 'unavailable' } as const;
  if (value.kind === 'refused' && typeof value.code === 'string'
    && (CONNECT_REFUSAL_CODES as readonly string[]).includes(value.code)) {
    return { kind: 'refused', code: value.code as ConnectRefusalCode } as const;
  }
  if (value.kind === 'connected' && typeof value.reused === 'boolean') {
    return { kind: 'connected', binding: publicBinding(value.binding), reused: value.reused } as const;
  }
  throw new CliError('transport_unavailable');
}

function publicStatus(value: unknown): AgentStatus {
  if (!plainObject(value) || value.v !== 1 || typeof value.connected !== 'boolean'
    || typeof value.route !== 'string' || !(AGENT_ROUTES as readonly string[]).includes(value.route)
    || !(value.sourceCursor === null || validIdentifier(value.sourceCursor))) {
    throw new CliError('transport_unavailable');
  }
  const binding = value.binding === null ? null : publicBinding(value.binding);
  return {
    v: 1,
    connected: value.connected,
    binding,
    route: value.route as AgentStatus['route'],
    sourceCursor: value.sourceCursor,
  };
}

function publicBinding(value: unknown): SessionBinding {
  if (!plainObject(value) || value.v !== 1 || !validIdentifier(value.bindingId) || !validIdentifier(value.ownerId)
    || !validIdentifier(value.agentParticipantId) || !validIdentifier(value.deviceId) || !validIdentifier(value.harness)
    || !validIdentifier(value.sessionId) || !Number.isSafeInteger(value.generation) || (value.generation as number) < 0) {
    throw new CliError('transport_unavailable');
  }
  return {
    v: 1,
    bindingId: value.bindingId,
    ownerId: value.ownerId,
    agentParticipantId: value.agentParticipantId,
    deviceId: value.deviceId,
    harness: value.harness,
    sessionId: value.sessionId,
    generation: value.generation,
  } as SessionBinding;
}

function publicSendOutput(result: Awaited<ReturnType<SendService['send']>>): Record<string, unknown> {
  if (result.kind === 'accepted') {
    return { ok: true, kind: result.kind, clientTxnId: result.clientTxnId, eventId: result.eventId };
  }
  if (result.kind === 'refused') {
    return { ok: false, kind: result.kind, code: result.code, clientTxnId: result.clientTxnId };
  }
  return { ok: false, kind: result.kind, clientTxnId: result.clientTxnId };
}
