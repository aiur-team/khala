// Per-account crawl detection. The listing limiter caps each verified session;
// one account can still spread a crawl across many sessions. This module sums
// every listing request an account makes in a fixed window, across all its
// sessions, and alerts the operator once per account and window when the total
// or the count of rate-limited requests crosses a threshold. It observes and
// alerts only: the hard ceilings stay in `listing.ts`.

import {
  type CallOptions,
  type ControlStore,
  type JsonValue,
  type OwnerId,
  type TrustedClock,
} from '@khala/contracts/messaging/index';
import { type Random, guardStore, randomToken, settleWrite } from '../auth/store';
import { LIST_REQUESTS_PER_WINDOW } from './listing';
import { type DiscoveryTelemetrySink, type ListOutcome, accountDigest, emit, telemetryDigest } from './telemetry';

export const CRAWL_WINDOW_MS = 10 * 60_000;
/** One session at the hard ceiling for the whole window: a second concurrent session crosses it. */
export const MAX_ACCOUNT_REQUESTS_PER_WINDOW = LIST_REQUESTS_PER_WINDOW * (CRAWL_WINDOW_MS / 60_000);
/** Repeatedly hitting the session limiter is itself a crawl signal. */
export const MAX_ACCOUNT_RATE_LIMITED_PER_WINDOW = 5;
const MAX_CAS_ATTEMPTS = 4;

export type OperatorAlert = Readonly<{
  v: 1;
  kind: 'channel_discovery.crawl_suspected';
  /** Stable per account and window, so a sink can deduplicate a retried delivery. */
  alertId: string;
  account: string;
  windowStart: string;
  requests: number;
  rateLimited: number;
  publicItems: number;
}>;

export type OperatorAlertSink = Readonly<{
  deliver(alert: OperatorAlert, options?: CallOptions): Promise<'delivered' | 'failed'>;
}>;

/** Operators may lower either threshold, never raise it. */
export type CrawlThresholds = Readonly<{ requests?: number; rateLimited?: number }>;

export type CrawlDeps = Readonly<{
  store: ControlStore;
  clock: TrustedClock;
  random: Random;
  alerts: OperatorAlertSink;
  telemetry?: DiscoveryTelemetrySink;
  thresholds?: CrawlThresholds;
}>;

export type CrawlObservation = Readonly<{ ownerId: OwnerId; result: ListOutcome; publicItems: number }>;

type Window = Readonly<{ requests: number; rateLimited: number; publicItems: number; alerted: boolean }>;

export function effectiveThresholds(thresholds: CrawlThresholds = {}): Readonly<{ requests: number; rateLimited: number }> {
  return {
    requests: lowerOnly(thresholds.requests, MAX_ACCOUNT_REQUESTS_PER_WINDOW),
    rateLimited: lowerOnly(thresholds.rateLimited, MAX_ACCOUNT_RATE_LIMITED_PER_WINDOW),
  };
}

function lowerOnly(value: number | undefined, ceiling: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 1 && value < ceiling ? value : ceiling;
}

export function createCrawlDetector(deps: CrawlDeps) {
  const limits = effectiveThresholds(deps.thresholds);
  const store = guardStore(deps.store);

  /** Counts one listing request. Never throws; a store failure skips detection for that request. */
  async function observe(observation: CrawlObservation, options?: CallOptions): Promise<void> {
    const now = deps.clock();
    const windowStart = now - (now % CRAWL_WINDOW_MS);
    const bucket = telemetryDigest('account', `${observation.ownerId}\u0000crawl\u0000${windowStart}`);
    const key = `channel-discovery:crawl:${bucket}`;
    const expiresAt = new Date(windowStart + 2 * CRAWL_WINDOW_MS).toISOString();
    const counted = await update(key, expiresAt, current => ({
      ...current,
      requests: current.requests + 1,
      rateLimited: current.rateLimited + (observation.result === 'rate_limited' ? 1 : 0),
      publicItems: current.publicItems + observation.publicItems,
    }), options);
    if (!counted || counted.alerted) return;
    if (counted.requests <= limits.requests && counted.rateLimited < limits.rateLimited) return;

    const alert: OperatorAlert = {
      v: 1, kind: 'channel_discovery.crawl_suspected', alertId: bucket, account: accountDigest(observation.ownerId),
      windowStart: new Date(windowStart).toISOString(), requests: counted.requests, rateLimited: counted.rateLimited,
      publicItems: counted.publicItems,
    };
    let delivery: 'delivered' | 'failed';
    try {
      delivery = await deps.alerts.deliver(alert, options);
    } catch {
      delivery = 'failed';
    }
    // Only a delivered alert is marked; a failed one retries on the next request.
    if (delivery === 'delivered') await update(key, expiresAt, current => ({ ...current, alerted: true }), options);
    await emit(deps.telemetry, {
      v: 1, event: 'channel_discovery.crawl_suspected', at: new Date(now).toISOString(), account: alert.account,
      windowStart: alert.windowStart, requests: alert.requests, rateLimited: alert.rateLimited, publicItems: alert.publicItems,
      alert: delivery,
    });
  }

  async function update(key: string, expiresAt: string, change: (current: Window) => Window, options?: CallOptions): Promise<Window | null> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const read = await store.read<JsonValue>(key, options);
      if (read.kind === 'unavailable') return null;
      const current = read.kind === 'record' ? decodeWindow(read.record.value) : { requests: 0, rateLimited: 0, publicItems: 0, alerted: false };
      if (!current) return null;
      const next = change(current);
      const written = await settleWrite<JsonValue>(store, {
        key, expectedRevision: read.kind === 'record' ? read.record.revision : null,
        operationId: `channel-discovery.crawl.${randomToken(deps.random, 16)}`,
        next: { value: next as unknown as JsonValue, expiresAt },
      });
      if (written.kind === 'applied') return next;
      if (written.kind === 'unavailable') return null;
    }
    return null;
  }

  return { observe };
}

export type CrawlDetector = ReturnType<typeof createCrawlDetector>;

function decodeWindow(value: JsonValue): Window | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { requests, rateLimited, publicItems, alerted } = value as Record<string, JsonValue>;
  if (!Number.isSafeInteger(requests) || !Number.isSafeInteger(rateLimited) || !Number.isSafeInteger(publicItems) || typeof alerted !== 'boolean') return null;
  return { requests: requests as number, rateLimited: rateLimited as number, publicItems: publicItems as number, alerted };
}

/**
 * Delivers operator alerts to one configured webhook. HTTPS only (plain HTTP
 * only on loopback), no embedded credentials, and redirects are refused rather
 * than followed. The body is the fixed alert shape above.
 */
export function createWebhookAlertSink(input: Readonly<{
  url: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}>): OperatorAlertSink {
  const url = new URL(input.url);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'localhost';
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password) {
    throw new Error('operator alert webhook must be an HTTPS URL without credentials');
  }
  const send = input.fetch ?? fetch;
  const timeoutMs = input.timeoutMs ?? 5_000;
  return {
    async deliver(alert, options) {
      const signal = options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      try {
        const response = await send(url, {
          method: 'POST', redirect: 'manual', signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(alert),
        });
        return response.status >= 200 && response.status < 300 ? 'delivered' : 'failed';
      } catch {
        return 'failed';
      }
    },
  };
}
