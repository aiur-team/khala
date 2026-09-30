import { expect, it, vi } from 'vitest';
import type { ParticipantView } from '@khala/contracts/messaging/index';
import type { SubstrateEvent } from '@khala/messaging/channels/index';
import { attachNameTargets } from './name-targets';

const participant = { participantId: 'human_one' as never, ownerId: 'owner_one' as never,
  kind: 'human' as const, displayName: 'Maya', deviceIds: [] };
const text: SubstrateEvent = { kind: 'message', participant, eventId: '$text' as never,
  authorDeviceId: 'DEVICE_ONE' as never, content: { v: 1, kind: 'text', body: 'Readable' }, clientTxnId: null, receivedAt: '2026-09-30T00:00:00Z' };
const rename: SubstrateEvent = { ...text, eventId: '$rename' as never,
  content: { v: 1, kind: 'agent_rename', agentParticipantId: 'agent_missing' as never, body: 'Dolan' } };

it('keeps readable neighbours when one valid name target is unknown or unreadable', async () => {
  const resolve = vi.fn(async () => null);
  const result = await attachNameTargets([text, rename, { ...text, eventId: '$after' as never }], resolve, () => true);
  expect(result.map(event => event.kind)).toEqual(['message', 'undecryptable', 'message']);
  expect(result[0]).toEqual(text);
  expect(resolve).toHaveBeenCalledExactlyOnceWith('agent_missing');
});

it('does not turn a target dependency exception into whole-page failure', async () => {
  const result = await attachNameTargets([text, rename], async () => { throw new Error('unavailable'); }, () => true);
  expect(result.map(event => event.kind)).toEqual(['message', 'undecryptable']);
});

it('attaches the authenticated historical target and fences an obsolete session', async () => {
  const target: ParticipantView = { ...participant, participantId: 'agent_missing' as never, kind: 'agent' };
  const resolve = async () => new Map([['@departed:example.test', target]]);
  expect(await attachNameTargets([rename], resolve, () => true)).toMatchObject([{ kind: 'message', targetParticipant: target }]);
  await expect(attachNameTargets([rename], resolve, () => false)).rejects.toThrow('Matrix session changed');
});
