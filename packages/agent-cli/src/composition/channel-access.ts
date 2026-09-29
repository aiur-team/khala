// HTTP composition for `requestChannelAccess` and `channelAccessStatus`. Like
// channel listing, it uses the connector's channel-less discovery credential,
// only talks to an exact configured origin, and never follows redirects. The
// response body is returned raw so the access service can decode it strictly.

import { createHash } from 'node:crypto';
import type { ChannelDiscoveryCredentialClient, ProofSigner, SessionClaim } from '@khala/connector/bootstrap/index';
import { isAcceptableOrigin, readBounded } from '@khala/connector/bootstrap/discovery';
import { decodeAgentChannelLinkResult, type DiscoveryCredential } from '@khala/contracts/messaging/index';
import type {
  AccessRefusalCode, ChannelAccessPort, ChannelAccessResult,
} from '../cli/channels/types.js';
import type { ChannelCreatePort } from '../cli/channels/create/types.js';
import { discard, redirectsOffOrigin } from './channel-listing.js';
import type { CandidateOutcome } from './proof-key-candidate.js';

export const CHANNEL_ACCESS_REQUEST_PATH = '/api/agent/channel-access/request';
export const CHANNEL_LINK_REQUEST_PATH = '/api/agent/channel-link/request';
export const CHANNEL_ACCESS_CREATE_PATH = '/api/agent/channel-access/create';
export const CHANNEL_ACCESS_STATUS_PATH = '/api/agent/channel-access/status';
const MAX_RESPONSE_BYTES = 4_096;
const DEFAULT_TIMEOUT_MS = 10_000;

export type HttpChannelAccessOptions = Readonly<{
  credentials: ChannelDiscoveryCredentialClient;
  signer: ProofSigner;
  session: SessionClaim;
  /** Exact configured service origins; `--origin` and a channel URL must name one of them. */
  trustedOrigins: readonly string[];
  defaultOrigin: string;
  candidate?: (input: Readonly<{ target: string; operationId: string; session: SessionClaim }>, signal?: AbortSignal) => Promise<CandidateOutcome>;
  beforeChannelRequest?: (input: Readonly<{ operationId: string; origin: string }>, credential: DiscoveryCredential) => Promise<boolean>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}>;

export function createHttpChannelAccess(options: HttpChannelAccessOptions): ChannelAccessPort & ChannelCreatePort {
  for (const origin of options.trustedOrigins) {
    if (!isAcceptableOrigin(origin)) throw new Error('trusted origins must be exact https (or loopback http) origins');
  }
  const trusted = new Set(options.trustedOrigins);
  if (!trusted.has(options.defaultOrigin)) throw new Error('the default origin must be a trusted origin');
  const transport = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function credentialFor(origin: string, signal: AbortSignal | undefined): Promise<DiscoveryCredential | ChannelAccessResult> {
    const held = options.credentials.current();
    if (held !== null && held.requester.origin === origin) return held;
    const authorized = await options.credentials.authorize(
      { origin, session: options.session }, signal === undefined ? undefined : { signal },
    );
    if (authorized.kind === 'denied') return refused('discovery_denied');
    if (authorized.kind === 'rejected') {
      return refused(authorized.code === 'untrusted_origin' ? 'untrusted_origin' : 'discovery_required');
    }
    if (authorized.kind === 'cancelled' || authorized.kind === 'timed_out') return refused('discovery_required');
    return authorized.kind === 'authorized' ? authorized.credential : { kind: 'unavailable' };
  }

  async function call(
    origin: string,
    signal: AbortSignal | undefined,
    build: (credential: DiscoveryCredential) => Readonly<{ target: URL; method: 'GET' | 'POST'; body?: unknown }>,
    beforeSend?: (credential: DiscoveryCredential) => Promise<boolean>,
  ): Promise<ChannelAccessResult> {
    if (!trusted.has(origin)) return refused('untrusted_origin');
    const credential = await credentialFor(origin, signal);
    if ('kind' in credential) return credential;
    if (beforeSend && !await beforeSend(credential)) return { kind: 'unavailable' };
    const { target, method, body } = build(credential);
    const rawBody = body === undefined ? undefined : JSON.stringify(body);
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await transport(target, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `DPoP ${credential.credentialRef}`,
          dpop: options.signer.proof(method, target.href, credential.credentialRef,
            rawBody === undefined ? undefined : { bodyHash: createHash('sha256').update(rawBody).digest('base64url') }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(rawBody === undefined ? {} : { body: rawBody }),
        redirect: 'manual',
        credentials: 'omit',
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      });
    } catch {
      return { kind: 'unavailable' };
    }
    if (response.status >= 300 && response.status < 400) {
      await discard(response);
      return redirectsOffOrigin(response, target) ? refused('untrusted_origin') : { kind: 'unavailable' };
    }
    if (response.status !== 200) {
      if (response.status === 409 && target.pathname === CHANNEL_LINK_REQUEST_PATH) {
        try {
          const bytes = await readBounded(response, MAX_RESPONSE_BYTES);
          if (bytes !== null) {
            const decoded = decodeAgentChannelLinkResult(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown);
            if (decoded.ok && decoded.value.kind === 'use_your_link') return refused('sponsor_link_required');
          }
        } catch { /* A malformed refusal remains unavailable. */ }
        return { kind: 'unavailable' };
      }
      await discard(response);
      if (response.status === 401) {
        options.credentials.invalidate();
        return refused('discovery_required');
      }
      const code = STATUS_REFUSALS.get(response.status);
      return code === undefined ? { kind: 'unavailable' } : refused(code);
    }
    const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    if (mediaType !== 'application/json') {
      await discard(response);
      return { kind: 'unavailable' };
    }
    try {
      const bytes = await readBounded(response, MAX_RESPONSE_BYTES);
      if (bytes === null) return { kind: 'unavailable' };
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (target.pathname === CHANNEL_LINK_REQUEST_PATH) {
        const decoded = decodeAgentChannelLinkResult(value);
        return decoded.ok && decoded.value.kind === 'request'
          ? { kind: 'status', status: { v: 1, operationId: decoded.value.operationId, outcome: decoded.value.outcome } }
          : { kind: 'unavailable' };
      }
      return { kind: 'status', status: value };
    } catch {
      return { kind: 'unavailable' };
    }
  }

  return {
    async requestChannelAccess(input, signal) {
      const named = input.target.kind === 'channel_url' ? originOf(input.target.channelUrl) : null;
      if (input.target.kind === 'channel_url' && !isAgentChannelUrl(input.target.channelUrl)) return refused('invalid_request');
      // A channel URL names its own service; a conflicting `--origin` is refused, not followed.
      if (input.target.kind === 'channel_url' && (named === null || (input.origin !== null && input.origin !== named))) {
        return refused('untrusted_origin');
      }
      const origin = input.origin ?? named ?? options.defaultOrigin;
      if (!trusted.has(origin)) return refused('untrusted_origin');
      if (options.credentials.current() === null && input.target.kind === 'channel_url' && options.candidate) {
        const candidate = await options.candidate({ target: input.target.channelUrl,
          operationId: input.operationId, session: options.session }, signal);
        if (candidate.kind === 'pending_owner') return { kind: 'status', status: { v: 1,
          operationId: input.operationId, outcome: 'pending_owner' } };
        if (candidate.kind === 'rejected') return refused('discovery_denied');
        if (candidate.kind !== 'approved') return { kind: 'unavailable' };
      }
      return call(origin, signal, credential => ({
        target: new URL(input.target.kind === 'channel_url' ? CHANNEL_LINK_REQUEST_PATH : CHANNEL_ACCESS_REQUEST_PATH, origin),
        method: 'POST',
        body: input.target.kind === 'listing_ref'
          ? { v: 1, kind: 'listing_ref', operationId: input.operationId, credentialRef: credential.credentialRef, listingRef: input.target.listingRef }
          : { v: 1, kind: 'channel_url', operationId: input.operationId, credentialRef: credential.credentialRef, channelUrl: input.target.channelUrl },
      }), credential => options.beforeChannelRequest?.({ operationId: input.operationId, origin }, credential) ?? Promise.resolve(true));
    },
    channelAccessStatus(input, signal) {
      return status(input, 'access', signal);
    },
    // Create intents ride the same discovery credential and never follow redirects;
    // the owner's approval, not this call, is what creates a channel.
    requestChannelCreate(input, signal) {
      const origin = input.origin ?? options.defaultOrigin;
      if (input.target !== undefined && input.target !== null) {
        let target: URL;
        try { target = new URL(input.target); } catch { return Promise.resolve(refused('untrusted_origin')); }
        if (target.origin !== origin || target.pathname !== '/new' || target.hash
          || [...target.searchParams.keys()].join(',') !== 'agent_create') {
          return Promise.resolve(refused('untrusted_origin'));
        }
        if (!options.candidate) return Promise.resolve({ kind: 'unavailable' as const });
        return options.candidate({ target: input.target, operationId: input.operationId,
          session: options.session }, signal).then(candidate => {
          if (candidate.kind === 'pending_owner') return { kind: 'handoff' as const,
            approvalUrl: candidate.approveUrl };
          if (candidate.kind === 'rejected') return refused('discovery_denied');
          if (candidate.kind !== 'approved') return { kind: 'unavailable' as const };
          return call(origin, signal, credential => ({
            target: createTargetPath(origin, target), method: 'POST',
            body: { v: 1, operationId: input.operationId, credentialRef: credential.credentialRef,
              origin, proposedTitle: input.title },
          }));
        });
      }
      return call(origin, signal, credential => ({
        target: new URL(CHANNEL_ACCESS_CREATE_PATH, origin),
        method: 'POST',
        body: {
          v: 1, operationId: input.operationId, credentialRef: credential.credentialRef, origin, proposedTitle: input.title,
        },
      }));
    },
    channelCreateStatus(input, signal) {
      return status(input, 'create', signal);
    },
  };

  function status(input: Readonly<{ operationId: string; origin: string | null }>, kind: 'access' | 'create', signal: AbortSignal | undefined) {
    const origin = input.origin ?? options.defaultOrigin;
    return call(origin, signal, () => {
      const target = new URL(CHANNEL_ACCESS_STATUS_PATH, origin);
      target.searchParams.set('v', '1');
      target.searchParams.set('operationId', input.operationId);
      target.searchParams.set('operationKind', kind);
      return { target, method: 'GET' };
    });
  }
}

const STATUS_REFUSALS: ReadonlyMap<number, AccessRefusalCode> = new Map([
  [400, 'invalid_request'], [403, 'discovery_denied'], [404, 'not_found'], [409, 'operation_conflict'], [429, 'rate_limited'],
]);

function originOf(url: string): string | null {
  try { return new URL(url).origin; } catch { return null; }
}

function createTargetPath(origin: string, source: URL): URL {
  const endpoint = new URL(CHANNEL_ACCESS_CREATE_PATH, origin);
  endpoint.searchParams.set('agent_create', source.searchParams.get('agent_create')!);
  return endpoint;
}

function isAgentChannelUrl(value: string): boolean {
  try { return /^\/join\/[A-Za-z0-9_-]{8,256}$/.test(new URL(value).pathname); } catch { return false; }
}

function refused(code: AccessRefusalCode): ChannelAccessResult {
  return { kind: 'refused', code };
}
