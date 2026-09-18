import { describe, expect, it } from 'vitest';
import type { EventId, RoomId } from '@khala/contracts/messaging/ids';
import type { MessageContent, RoomPort } from '@khala/contracts/messaging/index';
import { ok, outcomeUnknown, rejected, unavailable } from '@khala/contracts/messaging/outcomes';
import { isReconciled, resolveOutcomeUnknown, sendDraft } from './send';

const roomId = 'room_demo' as RoomId;
const content: MessageContent = { v: 1, kind: 'text', body: 'hello' };

function portWithResults(results: unknown[]): { port: Pick<RoomPort, 'send'>; calls: string[] } {
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
    const ref = { v: 1 as const, roomId, eventId: 'E1' as EventId, authorParticipantId: 'p1' as never, authorDeviceId: 'd1' as never, contentDigest: `sha256:${'0'.repeat(64)}` };
    const { port } = portWithResults([ok({ clientTxnId: 'txn_1', state: 'accepted', eventRef: ref })]);
    const pending = await sendDraft(port as RoomPort, roomId, 'txn_1', content);
    expect(pending).toEqual({ clientTxnId: 'txn_1', content, phase: 'accepted' });
  });

  it('AE2: an aborted/unavailable wait reports outcome_unknown, never an invented success', async () => {
    const { port } = portWithResults([outcomeUnknown('txn_1')]);
    const pending = await sendDraft(port as RoomPort, roomId, 'txn_1', content);
    expect(pending.phase).toBe('outcome_unknown');
  });

  it('a rejected or unavailable send reports failed, not silently dropped', async () => {
    const { port: rejectedPort } = portWithResults([rejected('too_large')]);
    expect((await sendDraft(rejectedPort as RoomPort, roomId, 'txn_1', content)).phase).toBe('failed');
    const { port: unavailablePort } = portWithResults([unavailable()]);
    expect((await sendDraft(unavailablePort as RoomPort, roomId, 'txn_1', content)).phase).toBe('failed');
  });
});

describe('resolveOutcomeUnknown', () => {
  it('AE2: resolves the same transaction identity — never a fresh retry with new bytes', async () => {
    const { port, calls } = portWithResults([outcomeUnknown('txn_1'), ok({ clientTxnId: 'txn_1', state: 'accepted', eventRef: null })]);
    const first = await sendDraft(port as RoomPort, roomId, 'txn_1', content);
    expect(first.phase).toBe('outcome_unknown');
    const resolved = await resolveOutcomeUnknown(port as RoomPort, roomId, first);
    expect(resolved).toEqual({ clientTxnId: 'txn_1', content, phase: 'accepted' });
    expect(calls).toEqual(['txn_1:hello', 'txn_1:hello']);
  });
});

describe('isReconciled', () => {
  it('is true once an item carries the pending transaction id, letting the caller drop the local echo', () => {
    const pending = { clientTxnId: 'txn_1', content, phase: 'accepted' as const };
    expect(isReconciled(pending, [{ clientTxnId: null }, { clientTxnId: 'txn_1' }])).toBe(true);
    expect(isReconciled(pending, [{ clientTxnId: null }])).toBe(false);
  });

  it('a replay of the same event does not add a second row (dedupe is the caller item list, already deduped by eventId)', () => {
    const pending = { clientTxnId: 'txn_alice_4', content, phase: 'accepted' as const };
    const items = [{ clientTxnId: 'txn_alice_4' }];
    expect(isReconciled(pending, items)).toBe(true);
    expect(items).toHaveLength(1);
  });
});
