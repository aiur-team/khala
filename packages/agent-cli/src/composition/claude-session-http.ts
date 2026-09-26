import { LISTENING_MODE_RESULT_OUTCOMES, LISTENING_MODES, type ListeningMode } from '@khala/contracts/delivery/index';
import { parseAccessTarget, validOperationArgument } from '../cli/channels/access.js';
import { validCursorArgument, validOriginArgument } from '../cli/channels/service.js';
import type { AccessRequestInput, AccessStatusInput, ChannelListInput } from '../cli/channels/types.js';
import { parseCreateTitle } from '../cli/channels/create/service.js';
import type { CreateRequestInput } from '../cli/channels/create/types.js';
import { MAX_SEND_BYTES } from '../cli/send.js';
import { plainObject, validIdentifier, validUtcTimestamp } from '../cli/validation.js';
import { readRuntimeDescriptor, type RuntimeDescriptorFailure } from './claude-descriptor.js';
import {
  CLAUDE_SESSION_REFUSALS, type ClaudeAccessOutcome, type ClaudeHookOutcome, type ClaudeModeOutcome, type ClaudeModeSetOutcome, type ClaudePendingOutcome,
  type ClaudeReadOutcome, type ClaudeSendOutcome, type ClaudeSessionAdapter, type ClaudeSessionRefusal,
  type ClaudeRosterOutcome, type ClaudeStatusOutcome, type ModeSetInput,
} from './claude-session.js';

/** The local server route that mounts `handleClaudeSessionRequest`. */
export const CLAUDE_SESSION_PATH = '/api/agent/claude/session';
// One batch of at most MAX_SEND_BYTES payload, JSON-escaped (up to 6x), plus framing.
const MAX_RESPONSE_BYTES = MAX_SEND_BYTES * 6 + 65_536;
const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/;

export type ClaudeSessionRequest =
  | Readonly<{ v: 1; op: 'pull' | 'read' | 'status' | 'roster'; sessionId: string }>
  | Readonly<{ v: 1; op: 'send'; sessionId: string; body: string }>
  | Readonly<{ v: 1; op: 'mode'; sessionId: string }>
  | Readonly<{
    v: 1; op: 'mode_set'; sessionId: string;
    commandId: string; expectedVersion: number; requested: ListeningMode; issuedAt: string;
  }>
  | Readonly<{ v: 1; op: 'pending' | 'hook'; sessionId: string }>
  | (Readonly<{ v: 1; op: 'channels'; sessionId: string }> & ChannelListInput)
  | (Readonly<{ v: 1; op: 'access_request'; sessionId: string }> & AccessRequestInput)
  | (Readonly<{ v: 1; op: 'access_status'; sessionId: string }> & AccessStatusInput)
  | (Readonly<{ v: 1; op: 'create_request'; sessionId: string }> & CreateRequestInput);

export type ClaudeSessionResponse = Readonly<{ status: 200 | 400 | 401; body: Readonly<Record<string, unknown>> }>;

/**
 * Server-side HTTP binding for the adapter. The local Khala server mounts it on an
 * authenticated loopback route; the bearer credential is handed to the adapter
 * and nothing about it (or any token) is echoed.
 */
export async function handleClaudeSessionRequest(
  adapter: ClaudeSessionAdapter,
  input: Readonly<{ authorization: string | undefined; body: unknown; readBudgetBytes: number }>,
): Promise<ClaudeSessionResponse> {
  const bearer = typeof input.authorization === 'string' ? BEARER.exec(input.authorization) : null;
  if (bearer === null) return { status: 401, body: { kind: 'refused', code: 'unauthorized' } };
  const request = decodeRequest(input.body);
  if (request === null) return { status: 400, body: { kind: 'refused', code: 'invalid_request' } };
  const call = { credential: bearer[1]!, sessionId: request.sessionId };
  let outcome: Readonly<Record<string, unknown>>;
  switch (request.op) {
    case 'pull': outcome = await adapter.pull(call, { maxBytes: Math.min(input.readBudgetBytes, MAX_SEND_BYTES) }); break;
    case 'read': outcome = await adapter.read(call, { maxBytes: Math.min(input.readBudgetBytes, MAX_SEND_BYTES) }); break;
    case 'status': outcome = await adapter.status(call); break;
    case 'send': outcome = await adapter.send(call, { body: request.body }); break;
    case 'mode': outcome = await adapter.mode(call); break;
    case 'mode_set': outcome = await adapter.setMode(call, {
      commandId: request.commandId, expectedVersion: request.expectedVersion, requested: request.requested, issuedAt: request.issuedAt,
    }); break;
    case 'pending': outcome = await adapter.pending(call); break;
    case 'hook': outcome = await adapter.hook(call); break;
    case 'roster': outcome = await adapter.roster(call); break;
    case 'channels': outcome = await adapter.listChannels(call, { origin: request.origin, cursor: request.cursor }); break;
    case 'access_request': outcome = await adapter.requestAccess(call, {
      target: request.target, operationId: request.operationId, origin: request.origin,
    }); break;
    case 'access_status': outcome = await adapter.accessStatus(call, { operationId: request.operationId, origin: request.origin }); break;
    case 'create_request': outcome = await adapter.requestCreate(call, {
      title: request.title, operationId: request.operationId, origin: request.origin,
    }); break;
  }
  return { status: outcome.kind === 'refused' && outcome.code === 'unauthorized' ? 401 : 200, body: outcome };
}

function decodeRequest(value: unknown): ClaudeSessionRequest | null {
  if (!plainObject(value) || value.v !== 1 || !validIdentifier(value.sessionId)) return null;
  const keys = Object.keys(value);
  const only = (...extra: string[]) => keys.every(key => ['v', 'op', 'sessionId', ...extra].includes(key));
  const sessionId = value.sessionId;
  switch (value.op) {
    case 'pull': case 'read': case 'status': case 'roster': case 'mode': case 'pending': case 'hook':
      return only() ? { v: 1, op: value.op, sessionId } : null;
    case 'send':
      return only('body') && typeof value.body === 'string' ? { v: 1, op: 'send', sessionId, body: value.body } : null;
    case 'mode_set':
      if (!only('commandId', 'expectedVersion', 'requested', 'issuedAt') || !validIdentifier(value.commandId)
        || !Number.isSafeInteger(value.expectedVersion) || (value.expectedVersion as number) < 0
        || !(LISTENING_MODES as readonly unknown[]).includes(value.requested) || !validUtcTimestamp(value.issuedAt)) return null;
      return {
        v: 1, op: 'mode_set', sessionId, commandId: value.commandId,
        expectedVersion: value.expectedVersion as number, requested: value.requested as ListeningMode, issuedAt: value.issuedAt,
      };
    case 'channels':
      if (!only('origin', 'cursor') || !optional(value.origin, validOriginArgument) || !optional(value.cursor, validCursorArgument)) return null;
      return { v: 1, op: 'channels', sessionId, origin: value.origin ?? null, cursor: value.cursor ?? null } as ClaudeSessionRequest;
    case 'access_request': {
      const target = plainObject(value.target) ? parseAccessTarget(value.target.kind === 'channel_url' ? value.target.channelUrl : value.target.listingRef) : null;
      if (!only('target', 'operationId', 'origin') || target === null || !plainObject(value.target)
        || target.kind !== value.target.kind || !validOperationArgument(value.operationId) || !optional(value.origin, validOriginArgument)) return null;
      return { v: 1, op: 'access_request', sessionId, target, operationId: value.operationId, origin: value.origin ?? null } as ClaudeSessionRequest;
    }
    case 'access_status':
      if (!only('operationId', 'origin') || !validOperationArgument(value.operationId) || !optional(value.origin, validOriginArgument)) return null;
      return { v: 1, op: 'access_status', sessionId, operationId: value.operationId, origin: value.origin ?? null } as ClaudeSessionRequest;
    case 'create_request': {
      const title = parseCreateTitle(value.title);
      // A title the create service would rewrite was not sent by the client: refuse it.
      if (!only('title', 'operationId', 'origin') || title === null || title !== value.title
        || !validOperationArgument(value.operationId) || !optional(value.origin, validOriginArgument)) return null;
      return { v: 1, op: 'create_request', sessionId, title, operationId: value.operationId, origin: value.origin ?? null } as ClaudeSessionRequest;
    }
    default:
      return null;
  }
}

/** An absent or null field, or a value the validator accepts. */
function optional(value: unknown, valid: (candidate: unknown) => boolean): boolean {
  return value === undefined || value === null || valid(value);
}

export type ClaudeClientRefusal =
  | ClaudeSessionRefusal
  | Readonly<{ kind: 'refused'; code: RuntimeDescriptorFailure }>;

type Result<T> = Exclude<T, ClaudeSessionRefusal> | ClaudeClientRefusal;

export type ClaudeModeSetRequest = Omit<ModeSetInput, 'acknowledgeToken'>;

export interface ClaudeSessionClient {
  /** Hook pull: delivers a batch and never acknowledges. */
  pull(sessionId: string, signal?: AbortSignal): Promise<Result<ClaudeReadOutcome>>;
  /** Agent-initiated: each of these acknowledges every retained token server-side. */
  read(sessionId: string, signal?: AbortSignal): Promise<Result<ClaudeReadOutcome>>;
  send(sessionId: string, body: string, signal?: AbortSignal): Promise<Result<ClaudeSendOutcome>>;
  status(sessionId: string, signal?: AbortSignal): Promise<Result<ClaudeStatusOutcome>>;
  mode(sessionId: string, signal?: AbortSignal): Promise<Result<ClaudeModeOutcome>>;
  setMode(sessionId: string, input: ClaudeModeSetRequest, signal?: AbortSignal): Promise<Result<ClaudeModeSetOutcome>>;
  pending(sessionId: string, signal?: AbortSignal): Promise<Result<ClaudePendingOutcome>>;
  /** Hook boundary state: effective mode and watcher window. Never acknowledges. */
  hook(sessionId: string, signal?: AbortSignal): Promise<Result<ClaudeHookOutcome>>;
  /** The session's own channel roster, undecoded. The session selects the binding; no argument names one. */
  roster(sessionId: string, signal?: AbortSignal): Promise<Result<ClaudeRosterOutcome>>;
  /**
   * Discovery and access for this session. The server files a request for exactly this
   * session, so a grant can bind no other; results are raw port results, decoded by the caller.
   */
  listChannels(sessionId: string, input: ChannelListInput, signal?: AbortSignal): Promise<Result<ClaudeAccessOutcome>>;
  requestAccess(sessionId: string, input: AccessRequestInput, signal?: AbortSignal): Promise<Result<ClaudeAccessOutcome>>;
  accessStatus(sessionId: string, input: AccessStatusInput, signal?: AbortSignal): Promise<Result<ClaudeAccessOutcome>>;
  /**
   * A create intent filed for this session; a retry under the same operation ID reads its
   * current state. The result is the raw port result, decoded by the caller.
   */
  requestCreate(sessionId: string, input: CreateRequestInput, signal?: AbortSignal): Promise<Result<ClaudeAccessOutcome>>;
}

export const DEFAULT_CLIENT_TIMEOUT_MS = 10_000;

export type ClaudeSessionClientOptions = Readonly<{ descriptorPath: string; fetch?: typeof fetch; timeoutMs?: number }>;

/**
 * The hook- and command-process side. Each call re-reads the owner-only runtime
 * descriptor, so the loopback port and credential are resolved at runtime and are
 * never taken from configuration, argv, or the environment. It holds no token,
 * cursor, or acknowledgement state of its own.
 */
export function createClaudeSessionClient(options: ClaudeSessionClientOptions): ClaudeSessionClient {
  const transport = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;

  async function call(request: ClaudeSessionRequest, signal: AbortSignal | undefined): Promise<unknown> {
    const descriptor = await readRuntimeDescriptor(options.descriptorPath);
    if (!descriptor.ok) return { kind: 'refused', code: descriptor.code };
    // A hook must never hang on a server that accepts the connection and goes quiet.
    const deadline = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await transport(`${descriptor.target.origin}${CLAUDE_SESSION_PATH}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${descriptor.target.credential}`, 'content-type': 'application/json' },
        body: JSON.stringify(request),
        redirect: 'error',
        signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
      });
    } catch {
      return { kind: 'refused', code: 'unavailable' };
    }
    // A rotated or stale descriptor fails closed here, without a retry.
    if (response.status === 401) return { kind: 'refused', code: 'unauthorized' };
    if (response.status === 400) return { kind: 'refused', code: 'invalid_request' };
    if (response.status !== 200) return { kind: 'refused', code: 'unavailable' };
    try {
      const text = await response.text();
      return Buffer.byteLength(text) > MAX_RESPONSE_BYTES ? { kind: 'refused', code: 'unavailable' } : JSON.parse(text);
    } catch {
      return { kind: 'refused', code: 'unavailable' };
    }
  }

  async function batchCall(op: 'pull' | 'read', sessionId: string, signal: AbortSignal | undefined) {
    const value = await call({ v: 1, op, sessionId }, signal);
    if (plainObject(value) && value.kind === 'empty' && Object.keys(value).length === 1) return { kind: 'empty' } as const;
    if (plainObject(value) && value.kind === 'batch' && typeof value.text === 'string' && Object.keys(value).length === 2) {
      return { kind: 'batch', text: value.text } as const;
    }
    return refusal(value);
  }

  return {
    pull: (sessionId, signal) => batchCall('pull', sessionId, signal),
    read: (sessionId, signal) => batchCall('read', sessionId, signal),
    async status(sessionId, signal) {
      const value = await call({ v: 1, op: 'status', sessionId }, signal);
      if (plainObject(value) && value.kind === 'status' && Number.isSafeInteger(value.acknowledged)
        && (value.acknowledged as number) >= 0 && Object.keys(value).length === 2) {
        return { kind: 'status', acknowledged: value.acknowledged as number };
      }
      return refusal(value);
    },
    async setMode(sessionId, input, signal) {
      const value = await call({
        v: 1, op: 'mode_set', sessionId,
        commandId: input.commandId, expectedVersion: input.expectedVersion, requested: input.requested, issuedAt: input.issuedAt,
      }, signal);
      return publicModeSet(value) ?? refusal(value);
    },
    async send(sessionId, body, signal) {
      const value = await call({ v: 1, op: 'send', sessionId, body }, signal);
      if (!plainObject(value)) return refusal(value);
      const piggyback = typeof value.batch === 'string' ? { batch: value.batch } : {};
      if ((value.kind === 'accepted' || value.kind === 'outcome_unknown') && validIdentifier(value.clientTxnId)) {
        return value.kind === 'accepted'
          ? { kind: 'accepted', clientTxnId: value.clientTxnId, eventId: validIdentifier(value.eventId) ? value.eventId : null, ...piggyback }
          : { kind: 'outcome_unknown', clientTxnId: value.clientTxnId, ...piggyback };
      }
      if (value.kind === 'refused' && validIdentifier(value.clientTxnId) && validIdentifier(value.code)) {
        return { kind: 'refused', code: value.code, clientTxnId: value.clientTxnId, ...piggyback };
      }
      return refusal(value);
    },
    async mode(sessionId, signal) {
      const value = await call({ v: 1, op: 'mode', sessionId }, signal);
      return publicMode(value) ?? refusal(value);
    },
    async pending(sessionId, signal) {
      const value = await call({ v: 1, op: 'pending', sessionId }, signal);
      if (plainObject(value) && (value.kind === 'pending' || value.kind === 'idle') && Object.keys(value).length === 1) {
        return { kind: value.kind };
      }
      return refusal(value);
    },
    async roster(sessionId, signal) {
      const value = await call({ v: 1, op: 'roster', sessionId }, signal);
      if (plainObject(value) && value.kind === 'roster' && Object.keys(value).length === 2) return { kind: 'roster', roster: value.roster };
      return refusal(value);
    },
    async listChannels(sessionId, input, signal) {
      return accessResult(await call({ v: 1, op: 'channels', sessionId, origin: input.origin, cursor: input.cursor }, signal));
    },
    async requestAccess(sessionId, input, signal) {
      return accessResult(await call({
        v: 1, op: 'access_request', sessionId, target: input.target, operationId: input.operationId, origin: input.origin,
      }, signal));
    },
    async accessStatus(sessionId, input, signal) {
      return accessResult(await call({ v: 1, op: 'access_status', sessionId, operationId: input.operationId, origin: input.origin }, signal));
    },
    async requestCreate(sessionId, input, signal) {
      return accessResult(await call({
        v: 1, op: 'create_request', sessionId, title: input.title, operationId: input.operationId, origin: input.origin,
      }, signal));
    },
    async hook(sessionId, signal) {
      const value = await call({ v: 1, op: 'hook', sessionId }, signal);
      const mode = (candidate: unknown) => (LISTENING_MODES as readonly unknown[]).includes(candidate);
      if (plainObject(value) && value.kind === 'hook' && Object.keys(value).length === 3
        && (value.effective === null || mode(value.effective))
        && (value.watchSeconds === null || (Number.isSafeInteger(value.watchSeconds) && (value.watchSeconds as number) > 0))) {
        return { kind: 'hook', effective: value.effective as ListeningMode | null, watchSeconds: value.watchSeconds as number | null };
      }
      return refusal(value);
    },
  };
}

function accessResult(value: unknown): Result<ClaudeAccessOutcome> {
  return plainObject(value) && value.kind === 'access' && Object.keys(value).length === 2
    ? { kind: 'access', result: value.result } : refusal(value);
}

const CLIENT_REFUSALS: readonly string[] = [
  ...CLAUDE_SESSION_REFUSALS, 'descriptor_missing', 'descriptor_insecure', 'descriptor_malformed',
];

const ACKNOWLEDGEMENT = ['unknown', 'unsupported', 'batch_token_next_call'] as const;

/** Rebuilds a mode outcome from exactly its closed fields; anything else is refused. */
function publicMode(value: unknown): Exclude<ClaudeModeOutcome, ClaudeSessionRefusal> | null {
  if (!plainObject(value) || value.kind !== 'mode' || !plainObject(value.support)) return null;
  const mode = (candidate: unknown): candidate is ListeningMode => (LISTENING_MODES as readonly unknown[]).includes(candidate);
  const support = value.support;
  if (!mode(value.requested) || !(value.effective === null || mode(value.effective))
    || !Number.isSafeInteger(value.version) || (value.version as number) < 0
    || !(ACKNOWLEDGEMENT as readonly unknown[]).includes(value.acknowledgement)
    || !LISTENING_MODES.every(name => validIdentifier(support[name]))) return null;
  return {
    kind: 'mode',
    requested: value.requested,
    effective: value.effective,
    version: value.version as number,
    support: { steer: support.steer as string, sync: support.sync as string, async: support.async as string },
    acknowledgement: value.acknowledgement as (typeof ACKNOWLEDGEMENT)[number],
  };
}

/** Rebuilds a mode-set outcome, and any token-free piggyback batch, from exactly its closed fields. */
function publicModeSet(value: unknown): Exclude<ClaudeModeSetOutcome, ClaudeSessionRefusal> | null {
  if (!plainObject(value) || value.kind !== 'mode_set') return null;
  const mode = (candidate: unknown): candidate is ListeningMode => (LISTENING_MODES as readonly unknown[]).includes(candidate);
  if (!(LISTENING_MODE_RESULT_OUTCOMES as readonly unknown[]).includes(value.outcome) || !mode(value.requested)
    || !(value.effective === null || mode(value.effective))
    || !Number.isSafeInteger(value.version) || (value.version as number) < 0
    || !(value.batch === undefined || typeof value.batch === 'string')) return null;
  return {
    kind: 'mode_set',
    outcome: value.outcome as (typeof LISTENING_MODE_RESULT_OUTCOMES)[number],
    requested: value.requested,
    effective: value.effective,
    version: value.version as number,
    ...(typeof value.batch === 'string' ? { batch: value.batch } : {}),
  };
}

function refusal(value: unknown): ClaudeClientRefusal {
  return plainObject(value) && value.kind === 'refused' && CLIENT_REFUSALS.includes(value.code as string)
    ? { kind: 'refused', code: value.code as ClaudeClientRefusal['code'] }
    : { kind: 'refused', code: 'unavailable' };
}

