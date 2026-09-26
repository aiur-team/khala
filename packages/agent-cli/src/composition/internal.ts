import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  type GrantedDescriptor, INTERNAL_ACTIVE_DESCRIPTOR_FILE, type InternalDescriptor, MAX_INTERNAL_DESCRIPTOR_BYTES,
  isGrantedDescriptor, parseInternalDescriptor,
} from '@khala/contracts/internal/descriptor';
import { ACCESS_REQUEST_OUTCOMES } from '@khala/contracts/messaging/discovery';
import { publicBinding } from '../cli/runtime.js';
import type {
  AccessRequestResult, AgentClientPort, AgentStatus, SendRefusalCode, SendResult,
} from '../cli/types.js';
import { plainObject, validIdentifier } from '../cli/validation.js';
import { type InternalDiscoverySelection, selectInternalDiscovery } from './internal-discovery.js';

// The descriptor-backed local client for `--internal-descriptor <path>`. The
// only stable input is the path: every operation reopens that exact file, so a
// rotated or revoked grant takes effect on the next call even in a long-lived
// `mcp-serve`. Capabilities live only in memory for one request and never reach
// output, errors, argv, or the environment. The server still rechecks the grant
// for every effect and derives attribution from the capability, never a body.

export type DescriptorReadFailure = 'unavailable' | 'unsafe' | 'invalid';
export type DescriptorRead =
  | Readonly<{ ok: true; value: InternalDescriptor }>
  | Readonly<{ ok: false; reason: DescriptorReadFailure }>;

/** Mirrors the channel-access journal's agent route without importing the control app. */
export const AGENT_CHANNEL_ACCESS_REQUEST_PATH = '/api/agent/channel-access/request';
export const AGENT_CHANNEL_ACCESS_STATUS_PATH = '/api/agent/channel-access-requests';
/** Terminal answers a later `join` of the same channel moves past with the next operation. */
const CLOSED_OUTCOMES: ReadonlySet<string> = new Set(['denied', 'expired', 'revoked']);
export const MAX_JOIN_ATTEMPTS = 16;
export const AGENT_BINDING_PATH = '/api/v1/agent/binding';

const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const CHANNEL_PATH = /^\/channels\/([^/]+)$/;

function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

/**
 * Opens exactly `file` without following a final symlink, then checks the open
 * inode: a regular file owned by this user with mode 0600. The checks run on
 * the descriptor, so a swap between check and read cannot substitute a file.
 */
export function readInternalDescriptor(file: string): DescriptorRead {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (!path.isAbsolute(file) || noFollow === undefined) return { ok: false, reason: 'unsafe' };
  let handle: number;
  try {
    handle = fs.openSync(file, fs.constants.O_RDONLY | noFollow | (fs.constants.O_NONBLOCK ?? 0));
  } catch (error) {
    // ELOOP is the kernel refusing a final-component symlink under O_NOFOLLOW.
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'ELOOP' ? 'unsafe' : 'unavailable' };
  }
  try {
    const stats = fs.fstatSync(handle);
    const uid = currentUid();
    if (!stats.isFile() || (uid !== null && stats.uid !== uid) || (stats.mode & 0o777) !== 0o600) {
      return { ok: false, reason: 'unsafe' };
    }
    if (stats.size > MAX_INTERNAL_DESCRIPTOR_BYTES) return { ok: false, reason: 'invalid' };
    const buffer = Buffer.alloc(MAX_INTERNAL_DESCRIPTOR_BYTES + 1);
    let length = 0;
    for (;;) {
      const read = fs.readSync(handle, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > MAX_INTERNAL_DESCRIPTOR_BYTES) return { ok: false, reason: 'invalid' };
    }
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)); }
    catch { return { ok: false, reason: 'invalid' }; }
    const decoded = parseInternalDescriptor(text);
    return decoded.ok ? { ok: true, value: decoded.value } : { ok: false, reason: 'invalid' };
  } catch {
    return { ok: false, reason: 'unavailable' };
  } finally {
    fs.closeSync(handle);
  }
}

export type InternalClientOptions = Readonly<{
  descriptorPath: string;
  fetch?: typeof globalThis.fetch;
  readDescriptor?: (file: string) => DescriptorRead;
  timeoutMs?: number;
}>;

type Reply = Readonly<{ status: number; body: unknown }>;

const DISCONNECTED = (route: AgentStatus['route']): AgentStatus => ({
  v: 1, connected: false, binding: null, route, sourceCursor: null,
});

export function createInternalClient(options: InternalClientOptions): AgentClientPort {
  const fetcher = options.fetch ?? globalThis.fetch;
  const readDescriptor = options.readDescriptor ?? readInternalDescriptor;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  // Reopened for every operation: nothing derived from the file is cached.
  const current = (): InternalDescriptor | null => {
    const read = readDescriptor(options.descriptorPath);
    return read.ok ? read.value : null;
  };
  const discoverySelection = () => selectInternalDiscovery({
    descriptorPath: options.descriptorPath,
    activePath: path.resolve(path.dirname(options.descriptorPath), '..', '..', INTERNAL_ACTIVE_DESCRIPTOR_FILE),
  });

  async function request(
    descriptor: Readonly<{ origin: string }>, capability: string, target: string,
    init: Readonly<{ method: 'GET' | 'POST'; body?: unknown }>, signal: AbortSignal | undefined,
  ): Promise<Reply> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetcher(new URL(target, descriptor.origin), {
      method: init.method,
      // A redirect would carry the capability off the exact loopback origin.
      redirect: 'error',
      headers: {
        authorization: `Bearer ${capability}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) return { status: response.status, body: null };
    let body: unknown = null;
    try { body = text.length === 0 ? null : JSON.parse(text); } catch { body = null; }
    return { status: response.status, body };
  }

  async function heldBinding(descriptor: GrantedDescriptor, signal: AbortSignal | undefined) {
    const reply = await request(descriptor, descriptor.bindingCapability, AGENT_BINDING_PATH, { method: 'GET' }, signal);
    if (reply.status === 401 || reply.status === 403) return 'revoked' as const;
    if (reply.status !== 200 || !plainObject(reply.body)) return 'unavailable' as const;
    const binding = publicBinding(reply.body.binding);
    // The server must answer for the binding this file names, never another one.
    return binding.bindingId === descriptor.bindingId ? binding : 'revoked' as const;
  }

  return {
    async connect() { return { kind: 'unavailable' }; },

    async status(signal) {
      const descriptor = current();
      // A discovery descriptor is an unjoined agent: it holds no binding by construction.
      if (descriptor === null) return DISCONNECTED(discoverySelection().kind === 'selected' ? 'unknown' : 'unavailable');
      // Transport discovery alone never admits: report the pending, unjoined state.
      if (!isGrantedDescriptor(descriptor)) return DISCONNECTED('unknown');
      let held;
      try { held = await heldBinding(descriptor, signal); } catch { return DISCONNECTED('unavailable'); }
      if (held === 'revoked') return DISCONNECTED('unknown');
      if (held === 'unavailable') return DISCONNECTED('unavailable');
      return { v: 1, connected: true, binding: held, route: 'unknown', sourceCursor: null };
    },

    async send(input, signal): Promise<SendResult> {
      const refused = (code: SendRefusalCode): SendResult => ({ kind: 'refused', code, clientTxnId: input.clientTxnId });
      const descriptor = current();
      if (descriptor === null) return refused(discoverySelection().kind === 'selected' ? 'not_connected' : 'transport_unavailable');
      if (!isGrantedDescriptor(descriptor)) return refused('not_connected');
      if (input.bindingId !== null && input.bindingId !== descriptor.bindingId) return refused('binding_not_held');
      let reply: Reply;
      try {
        reply = await request(descriptor, descriptor.bindingCapability,
          `/api/v1/channels/${encodeURIComponent(descriptor.channelId)}/messages`,
          { method: 'POST', body: { clientTxnId: input.clientTxnId, content: { v: 1, kind: 'text', body: input.body } } },
          signal);
      } catch {
        // The request may have reached the server before the failure.
        return { kind: 'outcome_unknown', clientTxnId: input.clientTxnId };
      }
      if ((reply.status === 200 || reply.status === 201) && plainObject(reply.body) && plainObject(reply.body.event)
        && reply.body.event.clientTxnId === input.clientTxnId && validIdentifier(reply.body.event.eventId)) {
        return { kind: 'accepted', clientTxnId: input.clientTxnId, eventId: reply.body.event.eventId };
      }
      if (reply.status === 401 || reply.status === 403) return refused('binding_not_held');
      if (reply.status === 400) return refused('invalid_input');
      if (reply.status === 503 && errorCode(reply.body) === 'unavailable') return refused('transport_unavailable');
      return { kind: 'outcome_unknown', clientTxnId: input.clientTxnId };
    },

    async requestAccess(channelUrl, signal): Promise<AccessRequestResult> {
      // A discovery descriptor from `khala internal discovery` names the requesting agent session.
      const discovery = discoverySelection();
      if (discovery.kind === 'selected') {
        const { selection } = discovery;
        return joinWithDiscovery(selection, channelUrl, signal,
          (capability, target, init) => request(selection, capability, target, init, signal));
      }
      const descriptor = current();
      if (descriptor === null) return { kind: 'unavailable' };
      if (localChannelId(channelUrl, descriptor.origin) !== descriptor.channelId) return { kind: 'refused', code: 'invalid_link' };
      // A live grant already names this channel: there is nothing to request.
      if (isGrantedDescriptor(descriptor)) {
        let held;
        try { held = await heldBinding(descriptor, signal); } catch { return { kind: 'unavailable' }; }
        if (held === 'unavailable') return { kind: 'unavailable' };
        if (held !== 'revoked') return { kind: 'status', outcome: 'connected' };
      }
      // The launch's transport capability carries no agent identity, so it cannot file a request.
      return { kind: 'refused', code: 'discovery_required' };
    },

    async listChannels() { return { kind: 'unavailable' }; },
    async listAgents() { return { kind: 'unavailable' }; },
  };
}

type AccessOutcome = (typeof ACCESS_REQUEST_OUTCOMES)[number];

function accessOutcome(reply: Reply, operationId: string): AccessOutcome | null {
  const body = reply.body;
  return reply.status === 200 && plainObject(body) && body.v === 1 && body.operationId === operationId
    && typeof body.outcome === 'string' && (ACCESS_REQUEST_OUTCOMES as readonly string[]).includes(body.outcome)
    ? body.outcome as AccessOutcome
    : null;
}

/**
 * Operations are derived from the channel URL, the discovery principal, its
 * generation and an attempt counter. A retry of the same attempt is idempotent,
 * and `unavailable` never advances it. A denied, expired or revoked answer (Stop
 * revokes) moves the next `join` to the following attempt, so a fresh request is
 * never collapsed into the old answer.
 */
async function joinWithDiscovery(
  selection: InternalDiscoverySelection,
  channelUrl: string,
  signal: AbortSignal | undefined,
  call: (capability: string, target: string, init: Readonly<{ method: 'GET' | 'POST'; body?: unknown }>) => Promise<Reply>,
): Promise<AccessRequestResult> {
  if (localChannelId(channelUrl, selection.origin) === null) return { kind: 'refused', code: 'invalid_link' };
  const { principal, generation, discoveryCapability } = selection.descriptor;
  let closed: AccessOutcome | null = null;
  for (let attempt = 0; attempt < MAX_JOIN_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted();
    const operationId = createHash('sha256')
      .update(JSON.stringify(['khala.agent-cli.internal-join.v2', channelUrl, principal, generation, attempt]))
      .digest('base64url').slice(0, 32);
    let outcome: AccessOutcome | null;
    try {
      outcome = accessOutcome(await call(discoveryCapability, `${AGENT_CHANNEL_ACCESS_STATUS_PATH}/${operationId}`, { method: 'GET' }), operationId);
    } catch {
      return { kind: 'unavailable' };
    }
    if (outcome === null) return { kind: 'unavailable' };
    if (CLOSED_OUTCOMES.has(outcome)) {
      closed = outcome;
      continue;
    }
    if (outcome !== 'unavailable') return { kind: 'status', outcome };
    // Nothing is journaled under this operation yet: submit exactly this operation.
    try {
      outcome = accessOutcome(await call(discoveryCapability, AGENT_CHANNEL_ACCESS_REQUEST_PATH, {
        method: 'POST', body: { v: 1, kind: 'channel_url', operationId, credentialRef: principal, channelUrl },
      }), operationId);
    } catch {
      return { kind: 'unavailable' };
    }
    return outcome === null ? { kind: 'unavailable' } : { kind: 'status', outcome };
  }
  return closed === null ? { kind: 'unavailable' } : { kind: 'status', outcome: closed };
}

function errorCode(body: unknown): unknown {
  return plainObject(body) && plainObject(body.error) ? body.error.code : undefined;
}

/** The channel ID of an exact `<origin>/channels/<id>` URL on the descriptor's origin, else null. */
export function localChannelId(value: string, origin: string): string | null {
  let parsed: URL;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.origin !== origin || parsed.username || parsed.password || parsed.search || parsed.hash
    || parsed.href !== value) return null;
  const match = CHANNEL_PATH.exec(parsed.pathname);
  if (!match) return null;
  try { return decodeURIComponent(match[1]!); } catch { return null; }
}
