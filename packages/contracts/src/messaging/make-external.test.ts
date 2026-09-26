import { describe, expect, it } from 'vitest';
import { EMPTY_HISTORY_PROGRESS, decodeMakeExternalAction, decodeMakeExternalJourneyView } from './make-external';

const agent = { participantId: 'agent-1', displayName: 'Builder', harness: 'codex', sessionId: 'session-1', generation: 1 };

const view = (over: Record<string, unknown> = {}) => ({
  v: 1,
  channelId: 'internal-1',
  title: 'Planning',
  sourceWrite: 'open',
  signIn: { status: 'signed_in', verificationUrl: null, failure: null },
  roster: [agent],
  conversion: null,
  ...over,
});

const conversion = (over: Record<string, unknown> = {}) => ({
  conversionId: 'conv-1',
  state: 'agents_pending',
  historyMode: 'carry_history',
  visibility: 'secret',
  destinationChannelId: 'external-1',
  destinationUrl: 'https://khala.example/channels/external-1',
  agents: [{ ...agent, status: 'requested', block: null, requestHandle: 'careq-1', released: false }],
  history: EMPTY_HISTORY_PROGRESS,
  canCommit: false,
  orphanDestinationChannelId: null,
  failure: null,
  ...over,
});

describe('make-external journey view', () => {
  it('decodes a view with a conversion', () => {
    const decoded = decodeMakeExternalJourneyView(view({ conversion: conversion() }));
    expect(decoded.ok).toBe(true);
  });

  it('rejects unknown fields, states and versions', () => {
    expect(decodeMakeExternalJourneyView(view({ extra: 1 })).ok).toBe(false);
    expect(decodeMakeExternalJourneyView(view({ v: 2 })).ok).toBe(false);
    expect(decodeMakeExternalJourneyView(view({ conversion: conversion({ state: 'done' }) })).ok).toBe(false);
  });

  it('refuses history progress on a start-fresh conversion', () => {
    const decoded = decodeMakeExternalJourneyView(view({ conversion: conversion({ historyMode: 'start_fresh' }) }));
    expect(decoded).toEqual({ ok: false, error: { path: 'conversion.history', code: 'invalid_value' } });
  });

  it('accepts only https or loopback http links, without credentials', () => {
    const at = (destinationUrl: string) => decodeMakeExternalJourneyView(view({ conversion: conversion({ destinationUrl }) })).ok;
    expect(at('https://khala.example/channels/x')).toBe(true);
    expect(at('http://127.0.0.1:4870/channels/x')).toBe(true);
    expect(at('javascript:alert(1)')).toBe(false);
    expect(at('http://khala.example/channels/x')).toBe(false);
    expect(at('https://user:pass@khala.example/')).toBe(false);
  });

  it('rejects duplicate agents', () => {
    expect(decodeMakeExternalJourneyView(view({ roster: [agent, agent] })).ok).toBe(false);
  });
});

describe('make-external actions', () => {
  it('defaults an omitted visibility to secret', () => {
    const decoded = decodeMakeExternalAction({ kind: 'start', operationId: 'op-1', historyMode: 'start_fresh', agents: ['agent-1'] });
    expect(decoded).toEqual({
      ok: true,
      value: { kind: 'start', operationId: 'op-1', historyMode: 'start_fresh', visibility: 'secret', agents: ['agent-1'] },
    });
  });

  it('keeps an explicit visibility and refuses an unknown one', () => {
    const start = { kind: 'start', operationId: 'op-1', historyMode: 'carry_history', agents: [] };
    for (const visibility of ['public', 'private', 'secret']) {
      const decoded = decodeMakeExternalAction({ ...start, visibility });
      expect(decoded.ok && decoded.value.kind === 'start' && decoded.value.visibility).toBe(visibility);
    }
    expect(decodeMakeExternalAction({ ...start, visibility: 'open' }).ok).toBe(false);
  });

  it('requires a history choice', () => {
    expect(decodeMakeExternalAction({ kind: 'start', operationId: 'op-1', agents: [] }).ok).toBe(false);
  });

  it('refuses an empty or duplicated grant', () => {
    expect(decodeMakeExternalAction({ kind: 'grant', operationId: 'op-1', requestHandles: [] }).ok).toBe(false);
    expect(decodeMakeExternalAction({ kind: 'grant', operationId: 'op-1', requestHandles: ['a', 'a'] }).ok).toBe(false);
  });

  it('rejects unknown kinds and extra fields', () => {
    expect(decodeMakeExternalAction({ kind: 'bind', operationId: 'op-1' }).ok).toBe(false);
    expect(decodeMakeExternalAction({ kind: 'commit', operationId: 'op-1', force: true }).ok).toBe(false);
  });
});
