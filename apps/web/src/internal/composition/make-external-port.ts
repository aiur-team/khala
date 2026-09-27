// HTTP implementation of the Make-external port over the loopback server. Every
// response is decoded strictly before anything renders it.

import { decodeMakeExternalJourneyView, decodeMakeExternalRejection } from '@khala/contracts/messaging/make-external';
import { REQUEST_SECRET_HEADER } from '@khala/messaging/local/http/index';
import type { MakeExternalPort } from '../make-external/port';

export type HttpMakeExternalPortOptions = Readonly<{
  origin: string;
  requestSecret: string;
  fetch?: typeof globalThis.fetch;
  /** Bound on a view read; the page offers a retry after it. */
  viewTimeoutMs?: number;
  /**
   * Bound on one action. An action can copy a whole history chunk before it answers,
   * so it waits longer; a timed-out action is an unknown outcome resent as the same operation.
   */
  actTimeoutMs?: number;
}>;

export function createHttpMakeExternalPort(options: HttpMakeExternalPortOptions): MakeExternalPort {
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  const url = (channelId: string) => `${options.origin}/api/v1/channels/${encodeURIComponent(channelId)}/make-external`;
  const headers = { [REQUEST_SECRET_HEADER]: options.requestSecret };

  const viewTimeoutMs = options.viewTimeoutMs ?? 10_000;
  const actTimeoutMs = options.actTimeoutMs ?? 60_000;

  async function request(channelId: string, init: RequestInit, timeoutMs: number): Promise<Response | null> {
    try {
      return await send(url(channelId), {
        ...init, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return null;
    }
  }

  async function body(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }

  return {
    async view(channelId) {
      const response = await request(channelId, { method: 'GET', headers }, viewTimeoutMs);
      if (response === null) return { kind: 'unavailable' };
      if (response.status === 401) return { kind: 'session_ended' };
      if (response.status === 403 || response.status === 404) return { kind: 'absent' };
      if (!response.ok) return { kind: 'unavailable' };
      const decoded = decodeMakeExternalJourneyView(await body(response));
      return decoded.ok ? { kind: 'ok', view: decoded.value } : { kind: 'unavailable' };
    },

    async act(channelId, action) {
      const response = await request(channelId, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(action),
      }, actTimeoutMs);
      if (response === null) return { kind: 'outcome_unknown' };
      if (response.status === 401) return { kind: 'session_ended' };
      if (response.status === 403 || response.status === 404) return { kind: 'absent' };
      if (!response.ok) return { kind: 'outcome_unknown' };
      const value = await body(response);
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return { kind: 'outcome_unknown' };
      const record = value as Record<string, unknown>;
      const decoded = decodeMakeExternalJourneyView(record.view);
      const rejection = record.rejection === null ? null : decodeMakeExternalRejection(record.rejection);
      if (record.v !== 1 || !decoded.ok || (record.rejection !== null && rejection === null) || Object.keys(record).length !== 3) {
        return { kind: 'outcome_unknown' };
      }
      return { kind: 'ok', view: decoded.value, rejection };
    },
  };
}
