import { describe, expect, it, vi } from 'vitest';
import type { Participant } from '@khala/contracts/m1/participants';
import type { ParticipantView, TimelineItem } from '@khala/contracts/messaging/index';
import type { OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/ids';
import type { ChannelView } from '../../features/channel/controller';
import { projectTimelineNames } from '../../features/timeline/names';
import { channelNameMembers, channelNameSaveError, renameChannelAgent, roomNameParticipants } from './room';

const kevin = 'owner_kevin' as OwnerId;
const viewer = { participantId: 'p_kevin', ownerId: kevin, kind: 'human', displayName: 'Kevin', deviceIds: [] } as unknown as ParticipantView;
const agentX = 'agent_x' as ParticipantId;
const room = (ownerId: OwnerId) => ({ getSnapshot: (): ChannelView => ({ phase: 'ready', agents: [{
  participantId: agentX, ownerId, displayName: 'Kevin-Claude', ownerDisplayName: 'Kevin', connection: 'unknown', routeLabel: 'Channel agent',
  acknowledgement: 'unknown', lastReceipt: null, installCommand: null, installCommandError: false,
}] }) });
const describeParticipant = (participantId: string): Participant | undefined => participantId === agentX
  ? { kind: 'agent', matrixUserId: '@agent-x:khala.example', participantId, ownerId: kevin, displayName: 'Kevin-Claude', ownerLabel: 'Kevin', harness: 'claude' }
  : undefined;

describe('renameChannelAgent', () => {
  it('renames through the agent names API by the agent’s Matrix user id', async () => {
    const rename = vi.fn<(matrixUserId: string, name: string, signal?: AbortSignal) => Promise<{ kind: 'ok'; name: string }>>(async (_matrixUserId, name) => ({ kind: 'ok', name }));
    const { signal } = new AbortController();
    const result = await renameChannelAgent({ agentNames: { rename }, describeParticipant }, room(kevin), viewer, agentX, 'Reviewer', signal);
    expect(result).toEqual({ kind: 'ok', name: 'Reviewer' });
    expect(rename).toHaveBeenCalledWith('@agent-x:khala.example', 'Reviewer', signal);
  });

  it('never sends an in-channel agent_rename event', async () => {
    const send = vi.fn();
    const context = { agentNames: { rename: async (_matrixUserId: string, name: string) => ({ kind: 'ok' as const, name }) },
      describeParticipant, room: { send } };
    await renameChannelAgent(context, room(kevin), viewer, agentX, 'Reviewer');
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses another owner’s agent without calling the API', async () => {
    const rename = vi.fn();
    expect(await renameChannelAgent({ agentNames: { rename }, describeParticipant }, room('owner_theo' as OwnerId), viewer, agentX, 'Reviewer'))
      .toEqual({ kind: 'error', code: 'not_owner' });
    expect(rename).not.toHaveBeenCalled();
  });

  it('reports unavailable when the agent’s Matrix user is unknown', async () => {
    const rename = vi.fn();
    expect(await renameChannelAgent({ agentNames: { rename }, describeParticipant: () => undefined }, room(kevin), viewer, agentX, 'Reviewer'))
      .toEqual({ kind: 'error', code: 'unavailable' });
    expect(rename).not.toHaveBeenCalled();
  });
});

describe('per-channel names', () => {
  it('passes the channel to the rename API so the name stays unique there', async () => {
    const rename = vi.fn(async (_matrixUserId: string, name: string) => ({ kind: 'ok' as const, name }));
    await renameChannelAgent({ agentNames: { rename }, describeParticipant }, room(kevin), viewer, agentX, 'Reviewer', undefined, '!a:hs' as RoomId);
    expect(rename).toHaveBeenCalledWith('@agent-x:khala.example', 'Reviewer', undefined, '!a:hs');
  });

  it('renders a member by the name they hold in each channel, and lets this tab’s saved name win', () => {
    const bob = { participantId: 'p_bob', ownerId: 'owner_bob', kind: 'human', displayName: 'alice', deviceIds: [] } as unknown as ParticipantView;
    const message = { ref: { eventId: '$m', authorParticipantId: bob.participantId }, participant: bob,
      content: { kind: 'text', body: 'hi' } } as unknown as TimelineItem;
    const inChannel = (name: string) => projectTimelineNames([message], viewer,
      roomNameParticipants([], [viewer, { ...bob, displayName: name }], viewer.participantId)).currentNames.get(bob.participantId);
    // The same member is alice2 in the channel where they met another alice, alice everywhere else.
    expect([inChannel('alice2'), inChannel('alice')]).toEqual(['alice2', 'alice']);
    const members = channelNameMembers([viewer, bob], new Map([[viewer.participantId, 'Kevin2']]), id => id === bob.participantId ? 5 : null);
    expect(members).toEqual([
      { participantId: viewer.participantId, kind: 'human', ownerId: kevin, name: 'Kevin2', since: null },
      { participantId: bob.participantId, kind: 'human', ownerId: 'owner_bob', name: 'alice', since: 5 }]);
  });

  it('words failed saves for the prompt', () => {
    expect(channelNameSaveError({ kind: 'error', code: 'name_taken' })).toBe('Someone here already uses that name.');
    expect(channelNameSaveError({ kind: 'error', code: 'signed_out' })).toBe('You were signed out. Sign in again.');
    expect(channelNameSaveError({ kind: 'error', code: 'not_owner' })).toBe('Couldn’t save. Try again.');
  });
});

describe('roomNameParticipants', () => {
  it('names another human by the directory after a username change, not by the stale name on their messages (#1088)', () => {
    const bob = { participantId: 'p_bob', ownerId: 'owner_bob', kind: 'human', displayName: 'bob', deviceIds: [] } as unknown as ParticipantView;
    const message = { ref: { eventId: '$m', authorParticipantId: bob.participantId }, participant: bob,
      content: { kind: 'text', body: 'hi' } } as unknown as TimelineItem;
    const roster = [{ ...viewer, displayName: 'Stale Kevin' }, { ...bob, displayName: 'robert' }];
    const extra = roomNameParticipants(room(kevin).getSnapshot().agents, roster, viewer.participantId);
    const names = projectTimelineNames([message], viewer, extra).currentNames;
    expect(names.get(bob.participantId)).toBe('robert');
    expect(names.get(viewer.participantId)).toBe('Kevin');
    expect(names.get(agentX)).toBe('Kevin-Claude');
  });
});
