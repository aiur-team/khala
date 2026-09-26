// HTTP composition for `listChannels`. The discovery credential comes from the
// connector's channel-less bootstrap: when no live credential is held for the
// requested origin, the owner is asked to authorize discovery for this session.
// The origin must be one of the exact configured origins, requests never follow
// redirects, and the response body is returned raw so the listing service can
// decode it strictly.

import type { ChannelDiscoveryCredentialClient, ProofSigner, SessionClaim } from '@khala/connector/bootstrap/index';
import { isAcceptableOrigin, readBounded } from '@khala/connector/bootstrap/discovery';
import type { ChannelListRefusalCode, ChannelListResult, ChannelListingPort } from '../cli/channels/types.js';

export const CHANNEL_LIST_PATH = '/api/agent/channels';
const MAX_LIST_RESPONSE_BYTES = 65_536;
const DEFAULT_TIMEOUT_MS = 10_000;

export type HttpChannelListingOptions = Readonly<{
  credentials: ChannelDiscoveryCredentialClient;
  signer: ProofSigner;
  session: SessionClaim;
  /** Exact configured service origins; `--origin` must name one of them. */
  trustedOrigins: readonly string[];
  defaultOrigin: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}>;

export function createHttpChannelListing(options: HttpChannelListingOptions): ChannelListingPort['listChannels'] {
  for (const origin of options.trustedOrigins) {
    if (!isAcceptableOrigin(origin)) throw new Error('trusted origins must be exact https (or loopback http) origins');
  }
  const trusted = new Set(options.trustedOrigins);
  if (!trusted.has(options.defaultOrigin)) throw new Error('the default origin must be a trusted origin');
  const transport = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async function listChannels(input, signal): Promise<ChannelListResult> {
    const origin = input.origin ?? options.defaultOrigin;
    if (!trusted.has(origin)) return refused('untrusted_origin');

    let credential = options.credentials.current();
    if (credential === null || credential.requester.origin !== origin) {
      const authorized = await options.credentials.authorize(
        { origin, session: options.session }, signal === undefined ? undefined : { signal },
      );
      if (authorized.kind === 'denied') return refused('discovery_denied');
      if (authorized.kind === 'rejected') {
        return refused(authorized.code === 'untrusted_origin' ? 'untrusted_origin' : 'discovery_required');
      }
      if (authorized.kind === 'cancelled' || authorized.kind === 'timed_out') return refused('discovery_required');
      if (authorized.kind !== 'authorized') return { kind: 'unavailable' };
      credential = authorized.credential;
    }

    const target = new URL(CHANNEL_LIST_PATH, origin);
    if (input.cursor !== null) target.searchParams.set('cursor', input.cursor);
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await transport(target, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `DPoP ${credential.credentialRef}`,
          dpop: options.signer.proof('GET', target.href, credential.credentialRef),
        },
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
      await discard(response);
      if (response.status === 401) {
        options.credentials.invalidate();
        return refused('discovery_required');
      }
      if (response.status === 403) return refused('discovery_denied');
      if (response.status === 400 || response.status === 410) return refused('cursor_unavailable');
      if (response.status === 429) return refused('rate_limited');
      return { kind: 'unavailable' };
    }
    const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    if (mediaType !== 'application/json') {
      await discard(response);
      return { kind: 'unavailable' };
    }
    try {
      const bytes = await readBounded(response, MAX_LIST_RESPONSE_BYTES);
      if (bytes === null) return { kind: 'unavailable' };
      return { kind: 'listed', page: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown };
    } catch {
      return { kind: 'unavailable' };
    }
  };
}

export function redirectsOffOrigin(response: Response, target: URL): boolean {
  const location = response.headers.get('location');
  if (location === null) return false;
  try {
    const next = new URL(location, target);
    return next.origin !== target.origin || next.username !== '' || next.password !== '';
  } catch {
    return true;
  }
}

function refused(code: ChannelListRefusalCode): ChannelListResult {
  return { kind: 'refused', code };
}

export async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}
