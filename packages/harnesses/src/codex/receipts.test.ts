import { decodeDeliveryReceipt } from '@khala/contracts/delivery/index';
import { describe, expect, it } from 'vitest';
import { binding, clock, job } from './fakes';
import { createCodexReceiptTracker, receiptIdFor } from './receipts';

const consumed = (clientId: string | null, turnId = 'turn-1', threadId = 'session-b', method = 'item/started') => ({
  method, params: { threadId, turnId, item: { type: 'userMessage', id: 'item-1', clientId, content: [] } },
});
const turnCompleted = (id = 'turn-1', status = 'completed', threadId = 'session-b') => ({
  method: 'turn/completed', params: { threadId, turn: { id, status, items: [] } },
});

function tracker() {
  const t = createCodexReceiptTracker(binding(), clock);
  t.track(job());
  return t;
}

describe('receipt ids', () => {
  it('are stable per release, generation, kind and error code, and bounded in size', () => {
    const id = (j = job(), kind: 'completed' | 'failed' = 'completed', code: 'timeout' | 'stale_binding' | null = null) =>
      receiptIdFor(j, kind, code);
    expect(id()).toBe(id());
    expect(id()).not.toBe(receiptIdFor(job(), 'context_consumed'));
    expect(id(job(), 'failed', 'timeout')).not.toBe(id(job(), 'failed', 'stale_binding'));
    expect(id()).not.toBe(id(job('rel-b-7', binding({ generation: 1 }))));
    expect(id(job('r'.repeat(512))).length).toBeLessThan(96);
  });
});

describe('createCodexReceiptTracker', () => {
  it('maps the correlated userMessage and its turn completion', () => {
    const t = tracker();
    const [consumption] = t.observe(consumed('rel-b-7'));
    expect(consumption).toMatchObject({ kind: 'context_consumed', source: 'harness', releaseId: 'rel-b-7', evidenceRef: 'codex:userMessage.clientId' });
    const [completion] = t.observe(turnCompleted());
    expect(completion).toMatchObject({ kind: 'completed', evidenceRef: 'codex:turn/completed' });
    for (const receipt of [consumption, completion]) expect(decodeDeliveryReceipt(receipt).ok).toBe(true);
  });

  it('yields each receipt once for duplicate notifications', () => {
    const t = tracker();
    expect(t.observe(consumed('rel-b-7'))).toHaveLength(1);
    expect(t.observe(consumed('rel-b-7', 'turn-1', 'session-b', 'item/completed'))).toEqual([]);
    expect(t.observe(turnCompleted())).toHaveLength(1);
    expect(t.observe(turnCompleted())).toEqual([]);
  });

  it('handles a turn completion seen before its userMessage', () => {
    const t = tracker();
    expect(t.observe(turnCompleted())).toEqual([]);
    expect(t.observe(consumed('rel-b-7')).map(r => r.kind)).toEqual(['context_consumed', 'completed']);
  });

  it('does not infer completion from an interrupted or failed turn', () => {
    const t = tracker();
    t.observe(consumed('rel-b-7'));
    expect(t.observe(turnCompleted('turn-1', 'interrupted'))).toEqual([]);
    expect(t.observe(turnCompleted('turn-1', 'failed'))).toEqual([]);
  });

  it('ignores other threads, untracked client ids, human prompts and other events', () => {
    const t = tracker();
    expect(t.observe(consumed('rel-b-7', 'turn-1', 'another-thread'))).toEqual([]);
    expect(t.observe(consumed('someone-elses-id'))).toEqual([]);
    expect(t.observe(consumed(null))).toEqual([]);
    expect(t.observe({ method: 'thread/tokenUsage/updated', params: { threadId: 'session-b', usage: { total: 10 } } })).toEqual([]);
    expect(t.observe({ method: 'thread/queue/changed', params: { threadId: 'session-b' } })).toEqual([]);
    expect(t.observe({ method: 'item/started', params: null })).toEqual([]);
  });

  it('does not track a release for another binding or generation', () => {
    const t = createCodexReceiptTracker(binding(), clock);
    expect(t.track(job('rel-b-7', binding({ generation: 1 })))).toBe(false);
    expect(t.track(job('rel-b-8', binding({ bindingId: 'bind-other' })))).toBe(false);
    expect(t.observe(consumed('rel-b-7'))).toEqual([]);
    expect(t.observe(consumed('rel-b-8'))).toEqual([]);
    expect(t.track(job())).toBe(true);
    expect(t.observe(consumed('rel-b-7'))).toHaveLength(1);
  });

  it('leaves a pending release unresolved when the session exits', () => {
    const t = tracker();
    expect(t.observe({ method: 'thread/status/changed', params: { threadId: 'session-b', status: { type: 'notLoaded' } } })).toEqual([]);
    expect(t.observe({ method: 'thread/closed', params: { threadId: 'session-b' } })).toEqual([]);
  });
});
