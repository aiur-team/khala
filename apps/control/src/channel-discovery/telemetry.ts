// Privacy-safe discovery telemetry. Events are built only from the fixed
// fields below: purpose-tagged digests of the account and session, result
// codes, and counts. Titles, listing references, cursors, canonical channel
// URLs and anything derived from them, room IDs, and raw session or owner IDs
// never reach a sink, because no constructor here accepts them.

import { createHash } from 'node:crypto';
import type { OwnerId, StableAgentPrincipal } from '@khala/contracts/messaging/index';

export type ListOutcome = 'ok' | 'rate_limited' | 'cursor_unavailable' | 'unavailable';

export type DiscoveryTelemetryEvent =
  | Readonly<{
    v: 1;
    event: 'channel_discovery.list';
    at: string;
    account: string;
    session: string;
    page: 'first' | 'next';
    result: ListOutcome;
    items: number;
    publicItems: number;
    publicDiscovery: 'enabled' | 'disabled' | 'killed';
  }>
  | Readonly<{
    v: 1;
    event: 'channel_discovery.crawl_suspected';
    at: string;
    account: string;
    windowStart: string;
    requests: number;
    rateLimited: number;
    publicItems: number;
    alert: 'delivered' | 'failed';
  }>
  | Readonly<{
    v: 1;
    event: 'channel_discovery.rollout';
    at: string;
    operator: string;
    action: string;
    result: string;
  }>;

export type DiscoveryTelemetrySink = Readonly<{
  record(event: DiscoveryTelemetryEvent): void | Promise<void>;
}>;

/** Purpose-separated digest: the same owner never yields the same value across purposes. */
export function telemetryDigest(purpose: 'account' | 'session' | 'operator', value: string): string {
  return createHash('sha256').update(`khala.channel-discovery.telemetry.${purpose}.v1\u0000${value}`).digest('base64url').slice(0, 22);
}

export function accountDigest(ownerId: OwnerId | string): string {
  return telemetryDigest('account', ownerId);
}

export function sessionDigest(ownerId: OwnerId, principal: StableAgentPrincipal, generation: number): string {
  return telemetryDigest('session', `${ownerId}\u0000${principal}\u0000${generation}`);
}

/** Telemetry must never fail or slow the request it describes beyond one await. */
export async function emit(sink: DiscoveryTelemetrySink | undefined, event: DiscoveryTelemetryEvent): Promise<void> {
  if (!sink) return;
  try {
    await sink.record(event);
  } catch {
    // Dropped telemetry is preferable to a failed listing.
  }
}
