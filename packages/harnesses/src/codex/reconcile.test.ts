import { decodeDeliveryReceipt } from '@khala/contracts/delivery/index';
import { describe, expect, it } from 'vitest';
import { FakeAppServer, FakeCodec, FakeHosts, RecordingSink, clock, job, limits, payload } from './fakes';
import { createCodexHarness } from './index';
import { MAX_QUEUE_PAGES } from './reconcile';

function setup() {
  const server = new FakeAppServer();
  const hosts = new FakeHosts();
  const harness = createCodexHarness({
    client: server, hosts, codec: new FakeCodec(), clock, evidence: new RecordingSink(), limits,
  });
  return { server, hosts, harness };
}

describe('reconcile', () => {
  it('resolves a lost response by the queued entry carrying the release ID', async () => {
    const { harness, server } = setup();
    server.override('thread/queue/add', params => {
      // The native side enqueues, then the connection drops before the reply.
      server.queue.push({ id: 'q-lost', clientUserMessageId: String(params.clientUserMessageId), text: 'x' });
      return { status: 'lost', written: true, cause: 'disconnected' };
    });
    expect((await harness.submit({ job: job(), payload: payload() })).kind).toBe('outcome_unknown');
    const receipt = await harness.reconcile(job());
    expect(receipt).toMatchObject({ kind: 'harness_queued', source: 'harness', releaseId: 'rel-b-7' });
    expect(decodeDeliveryReceipt(receipt).ok).toBe(true);
  });

  it('follows the entry into history: consumed, then completed', async () => {
    const { harness, server } = setup();
    await harness.submit({ job: job(), payload: payload() });
    server.consumeNext('inProgress');
    expect(await harness.reconcile(job())).toMatchObject({ kind: 'context_consumed', evidenceRef: 'codex:userMessage.clientId' });
    server.turns[0]!.status = 'completed';
    expect(await harness.reconcile(job())).toMatchObject({ kind: 'completed' });
  });

  it('does not treat an interrupted or failed turn as completed', async () => {
    const { harness, server } = setup();
    await harness.submit({ job: job(), payload: payload() });
    server.consumeNext('interrupted');
    expect(await harness.reconcile(job())).toMatchObject({ kind: 'context_consumed' });
  });

  it('finds an entry beyond the first queue page', async () => {
    const { harness, server } = setup();
    server.pageSize = 2;
    for (let i = 0; i < 5; i++) server.queue.push({ id: `q-${i}`, clientUserMessageId: `other-${i}`, text: 'x' });
    server.queue.push({ id: 'q-mine', clientUserMessageId: 'rel-b-7', text: 'x' });
    expect(await harness.reconcile(job())).toMatchObject({ kind: 'harness_queued' });
  });

  it('catches an entry consumed between the history and queue reads', async () => {
    const { harness, server } = setup();
    server.queue.push({ id: 'q-1', clientUserMessageId: 'rel-b-7', text: 'x' });
    server.override('thread/read', () => undefined).override('thread/read', () => undefined);
    server.override('thread/queue/list', () => {
      server.consumeNext();
      return undefined;
    });
    expect(await harness.reconcile(job())).toMatchObject({ kind: 'completed' });
  });

  it('returns null when nothing is found; that is not permission to resend', async () => {
    const { harness, server } = setup();
    expect(await harness.reconcile(job())).toBeNull();
    expect(server.adds()).toBe(0);
  });

  it.each([
    ['session exited', (s: ReturnType<typeof setup>) => { s.server.reachable = false; }],
    ['history unreadable', (s: ReturnType<typeof setup>) => {
      s.server.override('thread/read', () => undefined).override('thread/read', () => ({ status: 'response', result: { thread: null } }));
    }],
    ['queue unreadable', (s: ReturnType<typeof setup>) => {
      s.server.override('thread/queue/list', () => ({ status: 'lost', written: true, cause: 'disconnected' }));
    }],
    ['queue longer than the page bound', (s: ReturnType<typeof setup>) => {
      s.server.pageSize = 1;
      for (let i = 0; i <= MAX_QUEUE_PAGES; i++) s.server.queue.push({ id: `q-${i}`, clientUserMessageId: `other-${i}`, text: 'x' });
    }],
    ['binding no longer hosted', (s: ReturnType<typeof setup>) => { s.hosts.host = null; }],
  ])('returns null when native state is unobservable: %s', async (_name, arrange) => {
    const s = setup();
    arrange(s);
    expect(await s.harness.reconcile(job())).toBeNull();
    expect(s.server.adds()).toBe(0);
    expect(s.server.closed).toBe(s.server.opened);
  });

  it('reports consumption when a duplicate entry is also still queued', async () => {
    const { harness, server } = setup();
    server.turns.push({ id: 't-1', status: 'completed', clientIds: ['rel-b-7'] });
    server.queue.push({ id: 'q-dup', clientUserMessageId: 'rel-b-7', text: 'x' });
    expect(await harness.reconcile(job())).toMatchObject({ kind: 'completed' });
  });
});
