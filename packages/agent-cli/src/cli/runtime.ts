import type { Readable, Writable } from 'node:stream';
import type { BindingId, SessionBinding } from '@khala/contracts/delivery/index';
import { CliError } from './errors.js';
import type { InboxItem } from './inbox.js';
import type { SendService } from './send.js';
import {
  AGENT_ROUTES, CONNECT_REFUSAL_CODES, type AgentStatus, type ConnectRefusalCode,
} from './types.js';
import { plainObject, validBindingArgument, validIdentifier } from './validation.js';

export function optionalBinding(args: readonly string[]): BindingId | null {
  if (args.length === 0) return null;
  if (args.length !== 2 || args[0] !== '--binding' || !validBindingArgument(args[1])) throw new CliError('invalid_arguments');
  return args[1]!;
}
export function validLink(value: string | undefined): value is string {
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
export function renderInboxItem(item: InboxItem): string {
  return JSON.stringify({ v: 1, releaseId: item.record.releaseId, bindingId: item.record.bindingId,
    generation: item.record.generation, events: item.record.events, payloadBase64: Buffer.from(item.payload).toString('base64') });
}
export function write(stream: Writable, value: string): Promise<void> {
  return new Promise((resolve, reject) => stream.write(value, error => error ? reject(error) : resolve()));
}
export function waitForSignal(signal: AbortSignal | undefined, milliseconds: number): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => done();
    function done() { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(); }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export function publicConnectResult(value: unknown) {
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

export function publicStatus(value: unknown): AgentStatus {
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

export function publicBinding(value: unknown): SessionBinding {
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

export function publicSendOutput(result: Awaited<ReturnType<SendService['send']>>): Record<string, unknown> {
  if (result.kind === 'accepted') {
    return { ok: true, kind: result.kind, clientTxnId: result.clientTxnId, eventId: result.eventId };
  }
  if (result.kind === 'refused') {
    return { ok: false, kind: result.kind, code: result.code, clientTxnId: result.clientTxnId };
  }
  return { ok: false, kind: result.kind, clientTxnId: result.clientTxnId };
}
