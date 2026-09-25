// Origin-bound discovery. A channel link is a locator on a configured trusted
// origin. The descriptor is always requested from that origin's fixed path, and
// every redirect is revalidated against the same allowlist. Nothing the link or
// response says can move the connector to an origin it was not configured with.

import { type BootstrapDescriptor, DESCRIPTOR_MEDIA_TYPE, DESCRIPTOR_PATH, MAX_DESCRIPTOR_BYTES, decodeDescriptor } from './descriptor';

export const MAX_LINK_BYTES = 2048;
export const MAX_REDIRECTS = 3;
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;

export type DiscoveryRejection = 'untrusted_origin' | 'invalid_link' | 'link_unavailable' | 'unsupported_descriptor';

export type DiscoveryResult =
  | Readonly<{ kind: 'resolved'; origin: string; descriptor: BootstrapDescriptor }>
  | Readonly<{ kind: 'rejected'; code: DiscoveryRejection }>
  /** Nothing conclusive happened (network, timeout, 5xx, 429); retry later. */
  | Readonly<{ kind: 'unavailable' }>;

export interface DiscoveryPort {
  resolve(channelUrl: string, options?: Readonly<{ signal?: AbortSignal }>): Promise<DiscoveryResult>;
}

export type DiscoveryOptions = Readonly<{
  /** Exact origins, e.g. `https://khala.aiur.team`. `http:` only for loopback development hosts. */
  trustedOrigins: readonly string[];
  fetch?: typeof fetch;
  timeoutMs?: number;
}>;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True for an exact `https:` origin, or `http:` on a loopback development host. */
export function isAcceptableOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.origin !== value) return false;
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
}

export type LinkCheck =
  | Readonly<{ kind: 'ok'; origin: string; link: string }>
  | Readonly<{ kind: 'rejected'; code: 'untrusted_origin' | 'invalid_link' }>;

/**
 * Validates a pasted channel link. Embedded credentials are refused rather than
 * stripped, so a link carrying them is never silently "fixed" and forwarded.
 * The fragment is dropped; it never reaches the service.
 */
export function checkChannelLink(channelUrl: string, trusted: ReadonlySet<string>): LinkCheck {
  if (typeof channelUrl !== 'string' || channelUrl.length === 0 || Buffer.byteLength(channelUrl) > MAX_LINK_BYTES) {
    return { kind: 'rejected', code: 'invalid_link' };
  }
  let url: URL;
  try {
    url = new URL(channelUrl);
  } catch {
    return { kind: 'rejected', code: 'invalid_link' };
  }
  if (url.username !== '' || url.password !== '') return { kind: 'rejected', code: 'invalid_link' };
  if (!trusted.has(url.origin)) return { kind: 'rejected', code: 'untrusted_origin' };
  url.hash = '';
  return { kind: 'ok', origin: url.origin, link: url.href };
}

/** @deprecated Use `checkChannelLink`; remove after the first tagged release containing #163. */
export const checkChatLink = checkChannelLink;

export function createDiscovery(options: DiscoveryOptions): DiscoveryPort {
  for (const origin of options.trustedOrigins) {
    if (!isAcceptableOrigin(origin)) throw new Error('trusted origins must be exact https (or loopback http) origins');
  }
  const trusted = new Set(options.trustedOrigins);
  const transport = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;

  return {
    async resolve(channelUrl, callOptions) {
      const checked = checkChannelLink(channelUrl, trusted);
      if (checked.kind === 'rejected') return checked;
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = callOptions?.signal ? AbortSignal.any([callOptions.signal, timeout]) : timeout;
      let target = new URL(`${checked.origin}${DESCRIPTOR_PATH}`);
      target.searchParams.set('link', checked.link);
      try {
        for (let hop = 0; ; hop++) {
          const response = await transport(target, {
            method: 'GET',
            headers: { accept: DESCRIPTOR_MEDIA_TYPE },
            redirect: 'manual',
            credentials: 'omit',
            signal,
          });
          if (response.status >= 300 && response.status < 400) {
            await discard(response);
            const location = response.headers.get('location');
            if (location === null || hop >= MAX_REDIRECTS) return { kind: 'rejected', code: 'link_unavailable' };
            let next: URL;
            try {
              next = new URL(location, target);
            } catch {
              return { kind: 'rejected', code: 'untrusted_origin' };
            }
            // Same origin only: a redirect cannot move a production link's flow to a preview origin.
            if (next.username !== '' || next.password !== '' || next.origin !== checked.origin) {
              return { kind: 'rejected', code: 'untrusted_origin' };
            }
            target = next;
            continue;
          }
          if (response.status === 429 || response.status >= 500) {
            await discard(response);
            return { kind: 'unavailable' };
          }
          if (response.status !== 200) {
            await discard(response);
            return { kind: 'rejected', code: 'link_unavailable' };
          }
          const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
          if (mediaType !== DESCRIPTOR_MEDIA_TYPE) {
            await discard(response);
            return { kind: 'rejected', code: 'unsupported_descriptor' };
          }
          const body = await readBounded(response, MAX_DESCRIPTOR_BYTES);
          if (body === null) return { kind: 'rejected', code: 'unsupported_descriptor' };
          let parsed: unknown;
          try {
            parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
          } catch {
            return { kind: 'rejected', code: 'unsupported_descriptor' };
          }
          const decoded = decodeDescriptor(parsed, target.origin);
          if (decoded.kind === 'invalid') {
            return { kind: 'rejected', code: decoded.code === 'foreign_endpoint' ? 'untrusted_origin' : 'unsupported_descriptor' };
          }
          return { kind: 'resolved', origin: target.origin, descriptor: decoded.descriptor };
        }
      } catch {
        // Network failure, timeout or abort: never echo the error, it may carry the URL.
        return { kind: 'unavailable' };
      }
    },
  };
}

/** Reads at most `limit` bytes; `null` when the body is larger. Never trusts `content-length`. */
export async function readBounded(response: Response, limit: number): Promise<Uint8Array | null> {
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}
