import { describe, expect, it } from 'vitest';
import { ROSTER, agentOf, baseView, conversionView, signedIn } from './fixtures/views';
import { agentStatusLabel, grantableHandles, historyProgressText, stepOf } from './model';

describe('journey step', () => {
  it('follows sign-in before any conversion exists', () => {
    expect(stepOf(baseView)).toBe('entry');
    expect(stepOf({ ...baseView, signIn: { status: 'pending', verificationUrl: 'https://khala.test/s', failure: null } })).toBe('signing_in');
    expect(stepOf({ ...baseView, signIn: { status: 'failed', verificationUrl: null, failure: 'denied' } })).toBe('sign_in_failed');
    expect(stepOf(signedIn())).toBe('confirm');
  });

  it('follows the journaled conversion state', () => {
    expect(stepOf(conversionView({ state: 'history_catching_up' }))).toBe('preparing');
    expect(stepOf(conversionView({ state: 'drain_required' }))).toBe('drain');
    expect(stepOf(conversionView({ state: 'agents_pending' }))).toBe('agents');
    expect(stepOf(conversionView({ state: 'activating' }))).toBe('activating');
    expect(stepOf(conversionView({ state: 'externalized' }))).toBe('done');
    expect(stepOf(conversionView({ state: 'cancelled' }))).toBe('cancelled');
    expect(stepOf(conversionView({ state: 'failed' }))).toBe('failed');
  });

  it('asks for a new sign-in to continue any unfinished conversion, including after the link', () => {
    const signedOut = { signIn: { status: 'signed_out' as const, verificationUrl: null, failure: null } };
    for (const state of ['agents_pending', 'committing', 'activating'] as const) {
      expect(stepOf(conversionView({ state }, signedOut)), state).toBe('sign_in_again');
    }
    expect(stepOf(conversionView({ state: 'externalized' }, signedOut))).toBe('done');
  });
});

describe('agents', () => {
  it('grants exactly the displayed requests still waiting', () => {
    const view = conversionView({
      agents: [agentOf(ROSTER[0]!), agentOf(ROSTER[1]!, { status: 'ready' }), agentOf(ROSTER[2]!, { status: 'blocked', block: 'revoked' })],
    });
    expect(grantableHandles(view)).toEqual(['careq-agent-builder']);
  });

  it('says why a blocked agent is blocked, and that a ready agent stays paused', () => {
    expect(agentStatusLabel(agentOf(ROSTER[0]!, { status: 'blocked', block: 'stale_session' }), false)).toBe('Blocked: its session changed since you confirmed');
    expect(agentStatusLabel(agentOf(ROSTER[0]!, { status: 'ready' }), false)).toBe('Ready, paused until you switch');
  });

  it('reports history progress with counts only', () => {
    expect(historyProgressText(conversionView({ history: { ...conversionView().conversion!.history!, phase: 'catch_up', round: 2 } })))
      .toBe('Catch-up round 2 of 3 (3 of 3 parts copied).');
  });
});
