import { afterEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ParticipantView, RoomId } from '@khala/contracts/messaging/index';
import { createChannelController } from '../../features/channel/controller';
import { ChannelRoster } from '../../features/channel/AgentPresencePanel';
import { resolveMembers } from '../../features/channel/members';
import { memberCountLabel } from '../../features/channel/roster-model';
import { hostedPresence } from './room';

const roomId = '!channel:hs' as RoomId;
const bob = { participantId: 'bob', ownerId: 'owner_bob', displayName: 'bob', kind: 'human', deviceIds: [] } as unknown as ParticipantView;
const alice = { participantId: 'alice', ownerId: 'owner_alice', displayName: 'alice', kind: 'human', deviceIds: [] } as unknown as ParticipantView;
const agent = { participantId: 'agent', ownerId: alice.ownerId, displayName: 'Scout', kind: 'agent', deviceIds: [] } as unknown as ParticipantView;

afterEach(() => { vi.useRealTimers(); });

it('refreshes the human roster and owner label when participant reads take longer than the poll interval', async () => {
  vi.useFakeTimers();
  let roster: readonly ParticipantView[] = [];
  const read = vi.fn(async (_roomId: RoomId, signal?: AbortSignal) => {
    await new Promise<void>(resolve => setTimeout(resolve, 6_000));
    return signal?.aborted ? null : [bob, alice, agent];
  });
  const controller = createChannelController(hostedPresence({ generation: 1, roomParticipants: read }, participants => { roster = participants; }),
    { roomId, generation: 1 });
  const members = () => resolveMembers({ viewer: { participantId: bob.participantId, ownerId: bob.ownerId, name: 'bob' },
    humans: roster.filter(member => member.kind === 'human' && member.participantId !== bob.participantId),
    agents: controller.getSnapshot().agents });
  const markup = () => renderToStaticMarkup(<ChannelRoster members={members()} phase={controller.getSnapshot().phase}
    creatorOwnerId={alice.ownerId} onOpen={() => {}} />);
  try {
    // The initial read completes after polling starts: agents are populated,
    // while the newer poll owns publication of the full participant roster.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(controller.getSnapshot().agents).toHaveLength(1);
    expect(markup()).toContain('Not in this channel');
    // The read started at 5s must finish at 11s, even though the next tick is at 10s.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(roster).toEqual([bob, alice, agent]);
    expect(markup()).not.toContain('Not in this channel');
    expect(markup()).toContain('OWNER');
    expect(memberCountLabel(members().humans.length + 1, members().agents.length)).toBe('2 humans · 1 agent');
    // Polling continues after the slow response, without overlapping it.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(3);
    expect(roster).toEqual([bob, alice, agent]);
  } finally { controller.dispose(); }
  expect(vi.getTimerCount()).toBe(0);
});

it('aborts an in-flight poll on disposal and never publishes its late result', async () => {
  vi.useFakeTimers();
  const publish = vi.fn();
  let complete: ((members: readonly ParticipantView[]) => void) | undefined;
  const signals: AbortSignal[] = [];
  const read = vi.fn(async (_roomId: RoomId, signal?: AbortSignal) => {
    signals.push(signal!);
    if (read.mock.calls.length === 1) return [bob, agent];
    return new Promise<readonly ParticipantView[]>(resolve => { complete = resolve; });
  });
  const controller = createChannelController(hostedPresence({ generation: 1, roomParticipants: read }, publish), { roomId, generation: 1 });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(read).toHaveBeenCalledTimes(2);
  controller.dispose();
  expect(signals[1]!.aborted).toBe(true);
  complete!([bob, alice, agent]);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot().agents).toHaveLength(1);
  expect(read).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it('retries a failed poll and keeps refreshing the full roster', async () => {
  vi.useFakeTimers();
  const publish = vi.fn();
  const read = vi.fn()
    .mockResolvedValueOnce([bob, agent])
    .mockRejectedValueOnce(new Error('directory temporarily unavailable'))
    .mockResolvedValue([bob, alice, agent]);
  const controller = createChannelController(hostedPresence({ generation: 1, roomParticipants: read }, publish), { roomId, generation: 1 });
  try {
    await vi.advanceTimersByTimeAsync(5_000);
    expect(publish).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(read).toHaveBeenCalledTimes(3);
    expect(publish).toHaveBeenLastCalledWith([bob, alice, agent]);
    expect(controller.getSnapshot().phase).toBe('ready');
  } finally { controller.dispose(); }
  expect(vi.getTimerCount()).toBe(0);
});
