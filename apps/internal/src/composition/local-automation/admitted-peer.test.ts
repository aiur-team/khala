import { describe, expect, it } from 'vitest';
import type { ListeningModeView, SessionBinding } from '@khala/contracts/delivery/index';
import { LOCAL_AUTOMATION_LIMITS } from '@khala/policy/listening-mode/limits';
import { createLocalAutomationProvider } from './provider';
import { evaluateAdmittedPeer, type AdmittedPeerFacts } from './admitted-peer';

const provider = createLocalAutomationProvider(LOCAL_AUTOMATION_LIMITS);
const recipient = { v: 1, bindingId: 'binding-recipient', generation: 1, ownerId: 'owner-one',
  agentParticipantId: 'agent-one', deviceId: 'device-one', harness: 'codex', sessionId: 'session-one' } as SessionBinding;
const sender = { ...recipient, bindingId: 'binding-sender', agentParticipantId: 'agent-two',
  deviceId: 'device-two', sessionId: 'session-two' } as SessionBinding;
const facts = (): AdmittedPeerFacts => ({
  recipient, sender, recipientChannelId: 'channel-one', senderChannelId: 'channel-one',
  recipientActive: true, senderActive: true, paused: false,
  mode: { bindingId: recipient.bindingId, generation: recipient.generation, version: 2,
    requested: 'sync', effective: 'sync' } as ListeningModeView,
  arrivedModeVersion: 2, causal: { rootId: 'human-root', depth: 1 },
  releasedInCausalRoot: 1, activeJobs: 0,
});

describe('local admitted-peer authority', () => {
  it('reserves one same-channel admitted peer release under its arrived mode revision', () => {
    expect(evaluateAdmittedPeer(provider, facts())).toEqual({
      kind: 'reserve', rootId: 'human-root', depth: 1, modeVersion: 2,
    });
  });

  it('cannot turn caller claims into a grant or a supported mode', () => {
    const base = facts();
    expect(evaluateAdmittedPeer(provider, { ...base, senderChannelId: 'other-channel' })).toEqual({ kind: 'held', reason: 'grant' });
    expect(evaluateAdmittedPeer(provider, { ...base, senderActive: false })).toEqual({ kind: 'held', reason: 'grant' });
    expect(evaluateAdmittedPeer(provider, { ...base, mode: { ...base.mode!, effective: null } })).toEqual({ kind: 'held', reason: 'mode' });
    expect(evaluateAdmittedPeer(provider, { ...base, mode: { ...base.mode!, effective: 'async' } })).toEqual({ kind: 'held', reason: 'mode' });
    expect(evaluateAdmittedPeer(provider, { ...base, arrivedModeVersion: 1 })).toEqual({ kind: 'held', reason: 'stale' });
    expect(evaluateAdmittedPeer(provider, { ...base, paused: true })).toEqual({ kind: 'held', reason: 'paused' });
  });

  it('holds unproven ancestry, full causal depth, spent roots and busy slots without resetting on mode changes', () => {
    const base = facts();
    expect(evaluateAdmittedPeer(provider, { ...base, causal: null })).toEqual({ kind: 'held', reason: 'causal_unknown' });
    expect(evaluateAdmittedPeer(provider, { ...base, causal: { rootId: 'human-root', depth: 3 } })).toEqual({ kind: 'held', reason: 'loop_limit' });
    expect(evaluateAdmittedPeer(provider, { ...base, releasedInCausalRoot: 3 })).toEqual({ kind: 'held', reason: 'budget_exhausted' });
    expect(evaluateAdmittedPeer(provider, { ...base, activeJobs: 1 })).toEqual({ kind: 'held', reason: 'busy' });
    expect(evaluateAdmittedPeer(provider, { ...base, mode: { ...base.mode!, version: 3 }, arrivedModeVersion: 3,
      releasedInCausalRoot: 3 })).toEqual({ kind: 'held', reason: 'budget_exhausted' });
  });
});
