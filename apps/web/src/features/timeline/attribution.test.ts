import { describe, expect, it } from 'vitest';
import type { Participant } from '@khala/contracts/m1/participants';
import type { OwnerId, ParticipantId } from '@khala/contracts/messaging/ids';
import { rowLabels, type Attribution } from './attribution';

const attribution: Attribution = { participantId: 'human_maya' as ParticipantId, ownerId: 'owner_maya' as OwnerId,
  displayName: 'Maya', kind: 'human', isLocalEcho: false, isViewerOwned: false };

describe('rowLabels', () => {
  it.each(['codex', 'claude'] as const)('labels %s agents from C3 details', harness => {
    const detail: Participant = { matrixUserId: '@bot:hs', participantId: 'agent_bot', ownerId: 'owner_maya',
      displayName: 'Codex · Maya', kind: 'agent', ownerLabel: 'Maya', harness };
    expect(rowLabels(attribution, detail)).toEqual({ author: detail.displayName,
      kindLabel: harness === 'codex' ? 'Codex agent' : 'Claude Code agent' });
  });
  it('labels unknown members', () => {
    expect(rowLabels(attribution, { matrixUserId: '@stranger:hs', displayName: '@stranger:hs', kind: 'unknown' }))
      .toEqual({ author: 'Unknown', kindLabel: 'Unknown' });
  });
  it('preserves human and viewer ownership labels', () => {
    expect(rowLabels(attribution, { matrixUserId: '@maya:hs', participantId: 'human_maya', ownerId: 'owner_maya',
      displayName: 'Maya', kind: 'human' })).toEqual({ author: null, kindLabel: 'Human' });
    expect(rowLabels({ ...attribution, isViewerOwned: true }, undefined)).toEqual({ author: null, kindLabel: 'You' });
  });
});
