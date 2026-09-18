import { decodeDeliveryReceipt } from '@khala/contracts/delivery/index';
import { describe, expect, it } from 'vitest';
import { type FakeHarness, fakeHarness, job, payload } from './fakes';
import { MAX_QUEUE_PAGES } from './reconcile';

const setup = fakeHarness;

describe('reconcile (while_queued)', () => {
  it('resolves a lost response by the queued entry carrying the release ID', async () => {
    const { harness, server } = setup();
    server.override('thread/queue/add', params => {
      // The native side enqueues, then the connection drops before the reply.
      server.queue.push({ id: 'q-lost', clientUserMessageId: String(params.clientUserMessageId), text: 'x' });
      return { status: 'lost', written: true, cause: 'disconnected' };
    });
    expect((await harness.submit({ job: job(), payload: payload() })).kind).toBe('outcome_unknown');
    const receipt = await harness.reconcile(job());
    expect(receipt).toMatchObject({
      kind: 'harness_queued', source: 'harness', releaseId: 'rel-b-7',
      evidenceRef: 'codex:thread/queue/list.clientUserMessageId',
    });
    expect(decodeDeliveryReceipt(receipt).ok).toBe(true);
  });

  it('claims nothing once the entry leaves the queue, and never reads history', async () => {
    const { harness, server } = setup();
    await harness.submit({ job: job(), payload: payload() });
    server.consumeNext('completed');
    // History holds the consumed turn, but the proof never read history: no claim.
    expect(await harness.reconcile(job())).toBeNull();
    expect(server.calls.filter(call => call.method === 'thread/read').map(call => call.params.includeTurns))
      .toEqual([false, false]);
    expect(server.adds()).toBe(1);
  });

  it('finds an entry beyond the first queue page', async () => {
    const { harness, server } = setup();
    server.pageSize = 2;
    for (let i = 0; i < 5; i++) server.queue.push({ id: `q-${i}`, clientUserMessageId: `other-${i}`, text: 'x' });
    server.queue.push({ id: 'q-mine', clientUserMessageId: 'rel-b-7', text: 'x' });
    expect(await harness.reconcile(job())).toMatchObject({ kind: 'harness_queued' });
  });

  it('returns null when nothing is found; that is not permission to resend', async () => {
    const { harness, server } = setup();
    expect(await harness.reconcile(job())).toBeNull();
    expect(server.adds()).toBe(0);
  });

  it.each<[string, (s: FakeHarness) => void]>([
    ['session exited', s => { s.server.reachable = false; }],
    ['queue unreadable', s => {
      s.server.override('thread/queue/list', () => ({ status: 'lost', written: true, cause: 'disconnected' }));
    }],
    ['queue page malformed', s => {
      s.server.override('thread/queue/list', () => ({ status: 'response', result: { data: [{ id: 'q-1' }] } }));
    }],
    ['queue longer than the page bound', s => {
      s.server.pageSize = 1;
      for (let i = 0; i < MAX_QUEUE_PAGES; i++) s.server.queue.push({ id: `q-${i}`, clientUserMessageId: `other-${i}`, text: 'x' });
      s.server.queue.push({ id: 'q-mine', clientUserMessageId: 'rel-b-7', text: 'x' });
    }],
    ['binding no longer hosted', s => { s.hosts.host = null; }],
    ['listener hosts another thread', s => { s.server.threadId = 'session-replacement'; }],
    ['native thread id differs', s => {
      s.server.queue.push({ id: 'q-1', clientUserMessageId: 'rel-b-7', text: 'x' });
      s.server.override('thread/read', () => ({
        status: 'response', result: { thread: { id: 'session-other', cwd: '/scratch', status: { type: 'idle' } } },
      }));
    }],
  ])('returns null when the queue is unobservable: %s', async (_name, arrange) => {
    const s = setup();
    arrange(s);
    expect(await s.harness.reconcile(job())).toBeNull();
    expect(s.server.adds()).toBe(0);
    expect(s.server.closed).toBe(s.server.opened);
  });

  it('asks the queue of the bound thread only', async () => {
    const { harness, server } = setup();
    server.queue.push({ id: 'q-1', clientUserMessageId: 'rel-b-7', text: 'x' });
    await harness.reconcile(job());
    expect(server.calls.map(call => call.params.threadId)).toEqual(['session-b', 'session-b']);
  });
});
