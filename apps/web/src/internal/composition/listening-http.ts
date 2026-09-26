// The live listening-mode and pause port over the local server's owner-only binding routes.

import { REQUEST_SECRET_HEADER } from '@khala/messaging/local/http/index';
import { type ChangeOutcome, type ListeningFailure, type ListeningPort, decodeBindingList } from '../controls/listening-port';

function failure(status: number): ListeningFailure {
  if (status === 401) return 'session_ended';
  if (status === 403 || status === 404) return 'forbidden';
  if (status === 409) return 'conflict';
  return 'unavailable';
}

export function createHttpListeningPort(options: Readonly<{
  origin: string;
  requestSecret: string;
  fetch?: typeof globalThis.fetch;
  newCommandId?: () => string;
  now?: () => Date;
}>): ListeningPort {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const newCommandId = options.newCommandId ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date());
  const bindingPath = (channelId: string, bindingId: string, suffix: string) =>
    `${options.origin}/api/v1/channels/${encodeURIComponent(channelId)}/bindings/${encodeURIComponent(bindingId)}/${suffix}`;

  async function call(url: string, body?: unknown): Promise<Response | null> {
    try {
      return await fetcher(url, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        headers: {
          accept: 'application/json', [REQUEST_SECRET_HEADER]: options.requestSecret,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      return null;
    }
  }

  async function change(url: string, body: unknown, accept: (reply: unknown) => ChangeOutcome): Promise<ChangeOutcome> {
    const response = await call(url, body);
    // A write whose reply never arrived may still have committed.
    if (response === null) return { kind: 'failed', reason: 'outcome_unknown' };
    if (response.status !== 200) return { kind: 'failed', reason: failure(response.status) };
    try {
      return accept(await response.json());
    } catch {
      return { kind: 'failed', reason: 'outcome_unknown' };
    }
  }

  return {
    async list(channelId) {
      const response = await call(`${options.origin}/api/v1/channels/${encodeURIComponent(channelId)}/bindings`);
      if (response === null) return { kind: 'failed', reason: 'unavailable' };
      if (response.status !== 200) return { kind: 'failed', reason: failure(response.status) };
      try {
        const bindings = decodeBindingList(await response.json());
        return bindings === null ? { kind: 'failed', reason: 'unavailable' } : { kind: 'listed', bindings };
      } catch {
        return { kind: 'failed', reason: 'unavailable' };
      }
    },

    setMode(channelId, binding, requested) {
      return change(bindingPath(channelId, binding.bindingId, 'listening-mode'), {
        v: 1, commandId: newCommandId(), generation: binding.generation, expectedVersion: binding.version, requested,
        issuedAt: now().toISOString(),
      }, reply => {
        const outcome = typeof reply === 'object' && reply !== null ? (reply as { outcome?: unknown }).outcome : undefined;
        if (outcome === 'applied') return { kind: 'done' };
        if (outcome === 'conflict') return { kind: 'failed', reason: 'conflict' };
        return { kind: 'failed', reason: outcome === 'refused' ? 'forbidden' : 'outcome_unknown' };
      });
    },

    setPaused(channelId, binding, paused) {
      return change(bindingPath(channelId, binding.bindingId, 'pause'), { v: 1, generation: binding.generation, paused }, reply =>
        typeof reply === 'object' && reply !== null && (reply as { paused?: unknown }).paused === paused
          ? { kind: 'done' }
          : { kind: 'failed', reason: 'outcome_unknown' });
    },

    changeExperimentalRoute(channelId, binding, action, route) {
      return change(bindingPath(channelId, binding.bindingId, `experimental-route/${action}`), {
        v: 1, commandId: newCommandId(), generation: binding.generation, expectedVersion: binding.version, ...route,
        issuedAt: now().toISOString(),
      }, reply => {
        const outcome = typeof reply === 'object' && reply !== null ? (reply as { outcome?: unknown }).outcome : undefined;
        if (outcome === 'applied') return { kind: 'done' };
        if (outcome === 'conflict') return { kind: 'failed', reason: 'conflict' };
        // A refused grant names evidence that no longer matches: the reread shows the current claim.
        return { kind: 'failed', reason: outcome === 'refused' ? 'forbidden' : 'outcome_unknown' };
      });
    },
  };
}
