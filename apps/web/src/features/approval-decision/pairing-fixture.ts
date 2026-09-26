import type { PairingOwnerResult } from '@khala/contracts/messaging/index';
import type { DecisionPrompt } from './model';

/**
 * Fixture adapter proving a pairing request runs through the same shell as
 * channel access. The production pairing adapter belongs to
 * `pairing-approval-ui` (`features/pairing/**`); this one exists for tests and
 * the browser harness only.
 */
export function pairingFixturePrompt(pairing: PairingOwnerResult): DecisionPrompt {
  const claim = pairing.claim;
  return {
    kind: 'Pairing request',
    question: 'Pair this agent session with your channel?',
    verified: claim === null
      ? [{ label: 'Pairing code', value: 'Not claimed yet' }]
      : [
        { label: 'Harness', value: claim.harness },
        { label: 'Session fingerprint', value: claim.fingerprint, code: true },
        { label: 'Session generation', value: String(claim.generation) },
        { label: 'Service', value: pairing.origin },
      ],
    untrusted: [],
    capabilities: [
      { label: 'Channel', value: 'Read and send messages in this channel' },
      { label: 'history', value: 'none' },
    ],
    notices: ['Approving admits only this session. You can stop it later from the channel.'],
    progress: [{ label: 'Your decision', value: pairing.state === 'claimed' ? 'Pending' : pairing.state }],
    approveLabel: 'Approve pairing',
    denyLabel: 'Deny pairing',
  };
}

export const PAIRING_FIXTURE: PairingOwnerResult = {
  v: 1,
  requestHandle: 'pair_fixture',
  state: 'claimed',
  channelId: '!pairing:example.test' as PairingOwnerResult['channelId'],
  origin: 'https://khala.example.test',
  descriptorId: 'descriptor-fixture',
  createdAt: '2026-09-25T10:00:00Z',
  expiresAt: '2026-09-25T10:10:00Z',
  claim: {
    jkt: 'jkt-fixture',
    harness: 'codex',
    sessionId: 'session-fixture',
    generation: 2,
    deviceId: 'device-fixture' as NonNullable<PairingOwnerResult['claim']>['deviceId'],
    evidenceDigest: 'evidence-fixture',
    fingerprint: 'SHA256:pair-4Kd9',
    verification: 'connector_verified',
  },
  decidedAt: null,
  revision: '1',
};
