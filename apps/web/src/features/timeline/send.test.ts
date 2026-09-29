import { describe, expect, it } from 'vitest';
import type { EventId, RoomId } from '@khala/contracts/messaging/ids';
import type { MessageContent, ChannelPort } from '@khala/contracts/messaging/index';
import { ok, outcomeUnknown, rejected, unavailable } from '@khala/contracts/messaging/outcomes';
import { isReconciled, retrySend, sendDraft } from './send';

const roomId = 'room_demo' as RoomId;
const content: MessageContent = { v: 1, kind: 'text', body: 'hello' };
const acceptedRef = { v: 1 as const, roomId, eventId: 'E1' as EventId, authorParticipantId: 'p1' as never,
  authorDeviceId: 'd1' as never, contentDigest: `sha256:${'0'.repeat(64)}` };

function portWithResults(results: unknown[]): { port: Pick<ChannelPort, 'send'>; calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  return {
    calls,
    port: {
      send: async input => {
        calls.push(`${input.clientTxnId}:${input.content.body}`);
        const result = results[Math.min(index, results.length - 1)];
        index += 1;
        return result as never;
      },
    },
  };
}

describe('sendDraft', () => {
  it('reports accepted with the eventRef from the transport', async () => {
    const { port } = portWithResults([ok({ clientTxnId: 'txn_1', state: 'accepted', eventRef: acceptedRef })]);
    const pending = await sendDraft(port as ChannelPort, roomId, 'txn_1', content);
    expect(pending).toEqual({ clientTxnId: 'txn_1', content, phase: 'accepted', eventId: acceptedRef.eventId });
  });

  it('AE2: an aborted/unavailable wait reports outcome_unknown, never an invented success', async () => {
    const { port } = portWithResults([outcomeUnknown('txn_1')]);
    const pending = await sendDraft(port as ChannelPort, roomId, 'txn_1', content);
    expect(pending.phase).toBe('outcome_unknown');
  });

  it('a rejected or unavailable send reports failed, not silently dropped', async () => {
    const { port: rejectedPort } = portWithResults([rejected('too_large')]);
    expect((await sendDraft(rejectedPort as ChannelPort, roomId, 'txn_1', content)).phase).toBe('failed');
    const { port: unavailablePort } = portWithResults([unavailable()]);
    expect((await sendDraft(unavailablePort as ChannelPort, roomId, 'txn_1', content)).phase).toBe('failed');
  });
});

describe('retrySend', () => {
  it('AE2: resolves an outcome_unknown transaction by the same transaction identity — never a fresh retry with new bytes', async () => {
    const { port, calls } = portWithResults([outcomeUnknown('txn_1'), ok({ clientTxnId: 'txn_1', state: 'accepted', eventRef: acceptedRef })]);
    const first = await sendDraft(port as ChannelPort, roomId, 'txn_1', content);
    expect(first.phase).toBe('outcome_unknown');
    const resolved = await retrySend(port as ChannelPort, roomId, first);
    expect(resolved).toEqual({ clientTxnId: 'txn_1', content, phase: 'accepted', eventId: acceptedRef.eventId });
    expect(calls).toEqual(['txn_1:hello', 'txn_1:hello']);
  });

  it('retries a definite failure through the same transaction identity, so the transport dedups instead of double-sending', async () => {
    const { port, calls } = portWithResults([rejected('too_large'), ok({ clientTxnId: 'txn_1', state: 'accepted', eventRef: acceptedRef })]);
    const first = await sendDraft(port as ChannelPort, roomId, 'txn_1', content);
    expect(first.phase).toBe('failed');
    const resolved = await retrySend(port as ChannelPort, roomId, first);
    expect(resolved).toEqual({ clientTxnId: 'txn_1', content, phase: 'accepted', eventId: acceptedRef.eventId });
    expect(calls).toEqual(['txn_1:hello', 'txn_1:hello']);
  });
});

describe('isReconciled', () => {
  it('is true once an item carries the pending transaction id, letting the caller drop the local echo', () => {
    const pending = { clientTxnId: 'txn_1', content, phase: 'accepted' as const };
    expect(isReconciled(pending, [{ clientTxnId: null, ref: { eventId: 'E0' as EventId } }, { clientTxnId: 'txn_1', ref: { eventId: 'E1' as EventId } }])).toBe(true);
    expect(isReconciled(pending, [{ clientTxnId: null, ref: { eventId: 'E0' as EventId } }])).toBe(false);
  });

  it('matches an acknowledged event when Matrix sync omits the transaction, without collapsing a distinct identical send', () => {
    const pending = { clientTxnId: 'txn_1', content, phase: 'accepted' as const, eventId: 'E1' as EventId };
    expect(isReconciled(pending, [{ clientTxnId: null, ref: { eventId: 'E1' as EventId } }])).toBe(true);
    expect(isReconciled(pending, [{ clientTxnId: null, ref: { eventId: 'E2' as EventId } }])).toBe(false);
  });
});
