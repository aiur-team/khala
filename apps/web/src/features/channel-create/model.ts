// Creation adapter for the shared channel-request inbox and decision dialog
// (RD9A, `channel-create-workflow`). Approving a creation request creates one
// secret channel right away and authorizes only the requesting session; the
// agent joins later, when its own connector picks the approval up. The proposed
// title is the agent's text: it is listed as unverified data and never used as
// a heading, label, or subject.

import type { ChannelAccessOwnerOutcome, ChannelAccessOwnerProjection } from '@khala/contracts/messaging/index';
import type { DecisionFact } from '../approval-decision/model';

export type CreateRequest = Extract<ChannelAccessOwnerProjection, { operationKind: 'create' }>;

export const CREATE_OPERATION_LABEL = 'Channel creation request';
export const CREATE_SUBJECT_LABEL = 'Create a new secret channel';
export const CREATE_QUESTION = 'Create a secret channel for this agent session?';
export const CREATE_APPROVE_LABEL = 'Approve and create';

export const CREATE_CAPABILITIES: readonly DecisionFact[] = [
  { label: 'Creates', value: 'One new secret channel that you own' },
  { label: 'Messages', value: 'Read new messages and send messages in that channel' },
  { label: 'history', value: 'none' },
  { label: 'Admits', value: 'Only the requesting agent session' },
];

export const CREATE_NOTICES: readonly string[] = [
  'Approving creates exactly one secret channel and authorizes admission only for the requesting session. The channel is created as soon as you approve. Nobody else can find it, and anyone else still needs your approval to join.',
  'The agent joins only when its own connector picks up your approval. This page shows that separately.',
];

export const CREATE_DECIDED_MESSAGE =
  'Approved. Your secret channel is being created. The agent joins when its connector picks this up; this page shows when it connects.';

/** Untrusted facts the agent supplied for a creation request. */
export function createUntrustedFacts(request: CreateRequest): readonly DecisionFact[] {
  return [{ label: 'Proposed channel title', value: request.detail.proposedTitle }];
}

/**
 * The agent's connector reports readiness separately from creation. The
 * owner projection cannot tell a created channel from one still being
 * reconciled, so neither state claims the agent is in it.
 */
export function createConnectionLabel(outcome: ChannelAccessOwnerOutcome): string | null {
  switch (outcome) {
    case 'approved':
      return 'Creating the secret channel';
    case 'connecting':
      return 'Waiting for the agent’s connector to join the new channel';
    case 'repair_required':
      return 'Repair required on the agent’s connector. The channel stays yours.';
    case 'revoked':
      return 'Not connected. The request was closed and no channel is shared with the agent.';
    default:
      return null;
  }
}
