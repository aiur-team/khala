import type { PairingOwnerResult } from '@khala/contracts/messaging/index';
import type { DecisionPrompt, DecisionStatus } from '../approval-decision/model';

export type PairingPhase = 'loading' | 'ready' | 'load_failed' | 'unavailable';

export type PairingView = Readonly<{
  phase: PairingPhase;
  pairing: PairingOwnerResult | null;
  /** Decision state for the shared dialog. Terminal states carry no decision controls. */
  status: DecisionStatus;
  /** Set when the owner can no longer act (signed out or not the owner). */
  readOnly: boolean;
}>;

export const INITIAL_PAIRING_VIEW: PairingView = {
  phase: 'loading',
  pairing: null,
  status: { kind: 'idle' },
  readOnly: false,
};

/** Only a claimed, unexpired request with a verified claim can be decided. */
export function isAwaitingDecision(pairing: PairingOwnerResult, nowMs: number): boolean {
  return pairing.state === 'claimed' && pairing.claim !== null && nowMs < Date.parse(pairing.expiresAt);
}

/** The claim the owner is shown; a change in any part of it needs a new prompt. */
export function claimIdentity(pairing: PairingOwnerResult): string {
  const claim = pairing.claim;
  return claim === null
    ? `${pairing.requestHandle}|none`
    : [pairing.requestHandle, claim.fingerprint, claim.generation, claim.sessionId, claim.harness, claim.deviceId].join('|');
}

const STATE_LABEL: Readonly<Record<PairingOwnerResult['state'], string>> = {
  issued: 'Waiting for an agent to claim the code',
  claimed: 'Pending',
  approved: 'Approved',
  denied: 'Denied. Nothing was granted',
  expired: 'Expired. Nothing was granted',
};

export const pairingStateLabel = (pairing: PairingOwnerResult): string => STATE_LABEL[pairing.state];

/**
 * The production pairing adapter for the shared decision shell. Every field is
 * text; the verified session facts come from the control service's claim
 * projection, never from anything the agent typed.
 */
export function toDecisionPrompt(pairing: PairingOwnerResult): DecisionPrompt {
  const claim = pairing.claim;
  return {
    kind: 'Pairing request',
    question: 'Pair this agent session with your channel?',
    verified: claim === null
      ? [{ label: 'Pairing code', value: 'Not claimed yet' }]
      : [
        { label: 'Harness', value: claim.harness },
        { label: 'Session fingerprint', value: claim.fingerprint, code: true },
        { label: 'Session ID', value: claim.sessionId, code: true },
        { label: 'Session generation', value: String(claim.generation) },
        { label: 'Target channel', value: pairing.channelId, code: true },
        { label: 'Service', value: pairing.origin },
      ],
    untrusted: [],
    capabilities: [
      { label: 'Channel', value: 'Read and send messages in this channel' },
      { label: 'History', value: 'none' },
    ],
    notices: [
      'Approving admits only this session and generation. If the session changes you will be asked again.',
      'You can stop delivery later from the channel. Stopping does not close the agent’s CLI.',
    ],
    progress: [
      { label: 'Your decision', value: pairingStateLabel(pairing) },
      { label: 'Expires', value: pairing.expiresAt },
    ],
    approveLabel: 'Approve pairing',
    denyLabel: 'Deny pairing',
  };
}

export type { DecisionStatus };
