import { describe, expect, it } from 'vitest';
import { decodeDeliveryLimits } from '@khala/contracts/delivery/index';
import { fallbackSkillCapabilities } from './capabilities.js';

describe('fallback skill capabilities', () => {
  it('reports the agent-installed route as experimental without invented evidence', () => {
    const limits = decodeDeliveryLimits({ maxPayloadBytes: 65_536, maxSelectionEvents: 32 });
    if (!limits.ok) throw new Error('invalid limits fixture');
    expect(fallbackSkillCapabilities('other-agent', limits.value)).toEqual({
      v: 3,
      harness: 'other-agent',
      version: 'skill-1',
      adapterVersion: 'agent-listener-1',
      support: 'experimental',
      existingSession: 'agent_installed_listener',
      immediateNotification: 'agent_installed_listener',
      busy: 'unknown',
      receiptEvidence: [],
      reconcileByReleaseId: 'unsupported',
      limits: { maxPayloadBytes: 65_536, maxSelectionEvents: 32 },
      evidenceRef: null,
      modes: {
        steer: {
          status: 'unknown', route: 'other-agent-agent-listener-steer', testedVersion: 'skill-1',
          evidenceRef: null, evidenceRevision: null,
          reason: 'The fallback listener has no retained primary-mode proof; idle agents receive messages only at their next turn.',
        },
        sync: {
          status: 'unknown', route: 'other-agent-agent-listener-sync', testedVersion: 'skill-1',
          evidenceRef: null, evidenceRevision: null,
          reason: 'The fallback listener has no retained primary-mode proof; idle agents receive messages only at their next turn.',
        },
        async: {
          status: 'unknown', route: 'other-agent-agent-listener-async', testedVersion: 'skill-1',
          evidenceRef: null, evidenceRevision: null,
          reason: 'The fallback listener has no retained primary-mode proof; idle agents receive messages only at their next turn.',
        },
      },
      acknowledgement: 'unknown',
    });
  });
});
