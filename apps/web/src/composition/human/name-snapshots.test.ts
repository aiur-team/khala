import { expect, it, vi } from 'vitest';
import type { OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/index';
import type { NameParticipant, NameTimelineEvent } from '@khala/contracts/messaging/agent-names';
import { publishAgentNameSnapshots } from './name-snapshots';

const ownerId = 'maya' as OwnerId;
const participants: NameParticipant[] = [
  { participantId: 'human_maya' as ParticipantId, ownerId, kind: 'human', initialName: 'Maya' },
  { participantId: 'agent_codex' as ParticipantId, ownerId, kind: 'agent', initialName: 'Codex #420' },
  { participantId: 'agent_scout' as ParticipantId, ownerId: 'theo' as OwnerId, kind: 'agent', initialName: 'Scout' },
];
const events: NameTimelineEvent[] = [{ kind: 'agent_rename', eventId: '$rename',
  actorParticipantId: participants[0]!.participantId, targetParticipantId: participants[1]!.participantId, name: 'Dolan' }];
const input = { roomId: 'room_one' as RoomId, membershipEventId: '$member', ownerId, participants, events, isCurrent: () => true };

it('publishes only owned agent names with source identity and deduplicates retry and concurrent tabs', async () => {
  const send = vi.fn<Parameters<typeof publishAgentNameSnapshots>[0]['send']>(async () => ({ kind: 'done' }));
  await publishAgentNameSnapshots({ ...input, send });
  expect(send).toHaveBeenCalledExactlyOnceWith({ roomId: input.roomId, clientTxnId: expect.stringMatching(/^name_snapshot_[0-9a-f]{64}$/u),
    content: { v: 1, kind: 'agent_name_snapshot', agentParticipantId: participants[1]!.participantId, body: 'Dolan', sourceEventId: '$rename' } });
  const original = send.mock.calls[0];
  await publishAgentNameSnapshots({ ...input, send });
  expect(send.mock.calls[1]).toEqual(original);
  await publishAgentNameSnapshots({ ...input, membershipEventId: '$next-member', send });
  expect(send.mock.calls[2]).not.toEqual(original);
  const rename = events[0];
  if (rename?.kind !== 'agent_rename') throw new Error('missing rename fixture');
  await publishAgentNameSnapshots({ ...input, events: [{ ...rename, name: 'New name' }], send });
  expect(send.mock.calls[3]![0].clientTxnId).not.toBe(original![0].clientTxnId);
});

it('refuses to mark unavailable writes durable and preserves the transaction on retry', async () => {
  const send = vi.fn(async () => ({ kind: 'unavailable' }));
  await expect(publishAgentNameSnapshots({ ...input, send })).rejects.toThrow('name_snapshot_not_durable');
  const original = send.mock.calls[0];
  send.mockImplementation(async () => ({ kind: 'done' }));
  await publishAgentNameSnapshots({ ...input, send });
  expect(send.mock.calls[1]).toEqual(original);
});

it('stops an obsolete owner generation before publishing another owned agent', async () => {
  let current = true;
  const send = vi.fn(async () => { current = false; return { kind: 'done' }; });
  await publishAgentNameSnapshots({ ...input, participants: [...participants,
    { ...participants[1]!, participantId: 'agent_second' as ParticipantId }], isCurrent: () => current, send });
  expect(send).toHaveBeenCalledOnce();
});
