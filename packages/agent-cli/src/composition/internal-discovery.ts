// Internal-mode discovery client. It selects the unjoined agent's discovery
// descriptor (issued by `khala internal discovery`) and reads the live loopback
// origin from the owner-private `active.json` on every call. With those it
// lists channels, requests access and submits create intents on the running
// local service. The descriptor carries only discovery authority, and this
// client never reads the separate connector key. Requests never follow
// redirects. Response bodies are returned raw so callers decode them strictly.

import fs from 'node:fs';
import { parseInternalDescriptor } from '@khala/contracts/internal/descriptor';
import {
  type InternalDiscoveryDescriptor, MAX_INTERNAL_DISCOVERY_FILE_BYTES, parseInternalDiscoveryDescriptor,
} from '@khala/contracts/internal/discovery-descriptor';
import type { ChannelListResult, ChannelListingPort } from '../cli/channels/types.js';

const MAX_ACTIVE_BYTES = 4_096;
const MAX_RESPONSE_BYTES = 65_536;
const DEFAULT_TIMEOUT_MS = 10_000;

export const INTERNAL_CHANNEL_LIST_PATH = '/api/agent/channels';
export const INTERNAL_ACCESS_REQUEST_PATH = '/api/agent/channel-access-requests';
export const INTERNAL_CREATE_REQUEST_PATH = '/api/agent/channel-create-requests';

export type InternalDiscoverySelection = Readonly<{
  origin: string;
  descriptor: InternalDiscoveryDescriptor;
}>;

export type InternalDiscoverySelectResult =
  | Readonly<{ kind: 'selected'; selection: InternalDiscoverySelection }>
  /** No running local service, or no valid owner-private descriptor for this agent. */
  | Readonly<{ kind: 'discovery_required' }>;

/** Reads one small regular file that only its owner can read or write; symlinks are refused. */
function readPrivateFile(target: string, maxBytes: number): string | null {
  let descriptor: number;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stats = fs.fstatSync(descriptor);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!stats.isFile() || (stats.mode & 0o077) !== 0 || (uid !== null && stats.uid !== uid) || stats.size > maxBytes) return null;
    return fs.readFileSync(descriptor, 'utf8');
  } catch {
    return null;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function selectInternalDiscovery(input: Readonly<{ descriptorPath: string; activePath: string }>): InternalDiscoverySelectResult {
  const descriptorText = readPrivateFile(input.descriptorPath, MAX_INTERNAL_DISCOVERY_FILE_BYTES);
  const activeText = readPrivateFile(input.activePath, MAX_ACTIVE_BYTES);
  if (descriptorText === null || activeText === null) return { kind: 'discovery_required' };
  const descriptor = parseInternalDiscoveryDescriptor(descriptorText);
  const active = parseInternalDescriptor(activeText);
  if (!descriptor.ok || !active.ok) return { kind: 'discovery_required' };
  return { kind: 'selected', selection: { origin: active.value.origin, descriptor: descriptor.value } };
}

export type InternalDiscoveryCallResult =
  | Readonly<{ kind: 'ok'; body: unknown }>
  | Readonly<{ kind: 'refused'; status: number }>
  | Readonly<{ kind: 'discovery_required' }>
  | Readonly<{ kind: 'unavailable' }>;

export type InternalDiscoveryClient = Readonly<{
  listChannels: ChannelListingPort['listChannels'];
  /** Body is a `ChannelAccessRequest` without `credentialRef`; the principal fills it. */
  requestAccess(
    request: Readonly<{ v: 1; operationId: string } & ({ kind: 'listing_ref'; listingRef: string } | { kind: 'channel_url'; channelUrl: string })>,
    signal?: AbortSignal,
  ): Promise<InternalDiscoveryCallResult>;
  requestCreate(request: Readonly<{ operationId: string; proposedTitle: string }>, signal?: AbortSignal): Promise<InternalDiscoveryCallResult>;
  status(kind: 'access' | 'create', operationId: string, signal?: AbortSignal): Promise<InternalDiscoveryCallResult>;
}>;

export function createInternalDiscoveryClient(options: Readonly<{
  select: () => InternalDiscoverySelectResult;
  fetch?: typeof fetch;
  timeoutMs?: number;
}>): InternalDiscoveryClient {
  const transport = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function call(
    method: 'GET' | 'POST',
    path: (selection: InternalDiscoverySelection) => URL,
    body: ((selection: InternalDiscoverySelection) => unknown) | null,
    signal?: AbortSignal,
  ): Promise<InternalDiscoveryCallResult> {
    const selected = options.select();
    if (selected.kind !== 'selected') return { kind: 'discovery_required' };
    const { selection } = selected;
    const target = path(selection);
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await transport(target, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${selection.descriptor.discoveryCapability}`,
          ...(body === null ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === null ? {} : { body: JSON.stringify(body(selection)) }),
        redirect: 'manual',
        credentials: 'omit',
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      });
    } catch {
      return { kind: 'unavailable' };
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401) return { kind: 'discovery_required' };
      if (response.status >= 300 && response.status < 400) return { kind: 'unavailable' };
      return response.status >= 500 ? { kind: 'unavailable' } : { kind: 'refused', status: response.status };
    }
    if ((response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      await response.body?.cancel().catch(() => undefined);
      return { kind: 'unavailable' };
    }
    try {
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) return { kind: 'unavailable' };
      return { kind: 'ok', body: JSON.parse(text) as unknown };
    } catch {
      return { kind: 'unavailable' };
    }
  }

  return {
    async listChannels(input, signal): Promise<ChannelListResult> {
      // Internal discovery serves exactly the running local origin.
      if (input.origin !== null) return { kind: 'refused', code: 'untrusted_origin' };
      const result = await call('GET', selection => {
        const target = new URL(INTERNAL_CHANNEL_LIST_PATH, selection.origin);
        if (input.cursor !== null) target.searchParams.set('cursor', input.cursor);
        return target;
      }, null, signal);
      if (result.kind === 'ok') return { kind: 'listed', page: result.body };
      if (result.kind === 'discovery_required') return { kind: 'refused', code: 'discovery_required' };
      if (result.kind === 'refused') {
        if (result.status === 403) return { kind: 'refused', code: 'discovery_denied' };
        if (result.status === 400 || result.status === 410) return { kind: 'refused', code: 'cursor_unavailable' };
        if (result.status === 429) return { kind: 'refused', code: 'rate_limited' };
      }
      return { kind: 'unavailable' };
    },

    requestAccess(request, signal) {
      return call('POST', selection => new URL(INTERNAL_ACCESS_REQUEST_PATH, selection.origin),
        selection => ({ ...request, credentialRef: selection.descriptor.principal }), signal);
    },

    requestCreate(request, signal) {
      return call('POST', selection => new URL(INTERNAL_CREATE_REQUEST_PATH, selection.origin), selection => ({
        v: 1, operationId: request.operationId, credentialRef: selection.descriptor.principal,
        origin: selection.origin, proposedTitle: request.proposedTitle,
      }), signal);
    },

    status(kind, operationId, signal) {
      const base = kind === 'access' ? INTERNAL_ACCESS_REQUEST_PATH : INTERNAL_CREATE_REQUEST_PATH;
      return call('GET', selection => new URL(`${base}/${encodeURIComponent(operationId)}`, selection.origin), null, signal);
    },
  };
}
