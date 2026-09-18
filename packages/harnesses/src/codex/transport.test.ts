import {
  type DeliveryReceipt, type UnverifiedReleasedJob, decodeDeliveryReceipt, decodeReleasedJob,
} from '@khala/contracts/delivery/index';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FakeCodec, type FakeHarness, PLAINTEXT, RecordingSink, binding, clock, deadlines, fakeHarness, job, limits, never,
  payload,
} from './fakes';
import { createCodexHarness } from './index';
import type { CodexRequestOutcome } from './native';
import { MAX_QUEUE_PAGES } from './reconcile';
import { receiptIdFor } from './receipts';

const setup = fakeHarness;
const kinds = (receipts: readonly DeliveryReceipt[]) => receipts.map(r => r.kind);

function expectValid(receipt: DeliveryReceipt) {
  expect(decodeDeliveryReceipt(receipt)).toEqual({ ok: true, value: receipt });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('submit: worked lifecycle', () => {
  it('queues exactly the released text once, correlated by release ID', async () => {
    const { harness, server, evidence } = setup();
    const receipt = await harness.submit({ job: job(), payload: payload() });

    expectValid(receipt);
    expect(receipt).toMatchObject({
      kind: 'harness_queued', releaseId: 'rel-b-7', bindingId: 'bind-b-1', generation: 0, source: 'harness',
      errorCode: null, receiptId: receiptIdFor(job(), 'harness_queued'),
    });
    const add = server.calls.filter(call => call.method === 'thread/queue/add');
    expect(add).toEqual([{
      method: 'thread/queue/add',
      params: {
        threadId: 'session-b', clientUserMessageId: 'rel-b-7',
        input: [{ type: 'text', text: PLAINTEXT, text_elements: [] }],
      },
    }]);
    // Nothing but the released payload: no sender names, previews or queue contents.
    expect(server.queue.map(entry => entry.text)).toEqual([PLAINTEXT]);
    expect(kinds(evidence.receipts)).toEqual(['transport_written', 'harness_queued']);
    evidence.receipts.forEach(expectValid);
    expect(server.closed).toBe(server.opened);
  });

  it('reads only metadata and the queue: never the thread history', async () => {
    const { harness, server } = setup();
    await harness.submit({ job: job(), payload: payload() });
    expect(server.calls.map(call => [call.method, call.params.includeTurns])).toEqual([
      ['thread/read', false], ['thread/queue/list', undefined], ['thread/queue/add', undefined],
    ]);
  });

  it('queues while busy; the running turn is not steered or interrupted', async () => {
    const { harness, server } = setup();
    server.status = 'active';
    expect((await harness.submit({ job: job(), payload: payload() })).kind).toBe('harness_queued');
    expect(server.calls.map(call => call.method)).not.toContain('turn/steer');
  });

  it('never resumes, starts, steers or deletes natively', async () => {
    const { harness, server } = setup();
    await harness.submit({ job: job(), payload: payload() });
    await harness.reconcile(job());
    expect(new Set(server.calls.map(call => call.method))).toEqual(
      new Set(['thread/read', 'thread/queue/list', 'thread/queue/add']),
    );
  });

  it('notify is a hint only and never sends a prompt', async () => {
    const { harness, server } = setup();
    await harness.notify(binding(), { v: 1, releaseId: job().releaseId });
    expect(server.calls).toEqual([]);
  });

  it('accepts only a verified release', () => {
    const { harness } = setup();
    const decoded = decodeReleasedJob(JSON.parse(JSON.stringify(job())), limits);
    if (!decoded.ok) throw new Error(decoded.field);
    const unverified: UnverifiedReleasedJob = decoded.value;
    // @ts-expect-error A decoded release is not a verified ReleasedJob.
    expect(() => harness.reconcile(unverified)).toBeDefined();
    // @ts-expect-error A decoded release is not a verified ReleasedJob.
    expect(() => harness.submit({ job: unverified, payload: payload() })).toBeDefined();
  });
});

describe('submit: payload exactness', () => {
  it.each([
    ['non-ASCII text', 'Zoë’s résumé — 数字 🙂'],
    ['leading and trailing whitespace', '  \n\tpadded\t\n  '],
    ['a leading byte-order mark', '﻿after the BOM'],
  ])('sends %s byte for byte', async (_name, text) => {
    const { harness, server } = setup();
    const bytes = payload(text);
    expect((await harness.submit({ job: job('rel-b-7', binding(), bytes), payload: bytes })).kind).toBe('harness_queued');
    const [add] = server.calls.filter(call => call.method === 'thread/queue/add');
    const [sent] = add!.params.input as { text: string }[];
    expect(sent!.text).toBe(text);
    expect(new TextEncoder().encode(sent!.text)).toEqual(bytes);
  });
});

describe('submit: AE1, a release ID cannot create two turns through routine retry', () => {
  it('reports a still-queued release instead of adding it again', async () => {
    const { harness, server } = setup();
    await harness.submit({ job: job(), payload: payload() });
    const retry = await harness.submit({ job: job(), payload: payload() });
    expect(retry).toMatchObject({ kind: 'harness_queued', source: 'harness' });
    expect(server.adds()).toBe(1);
    expect(server.queue).toHaveLength(1);
  });

  it('reports a still-queued release from a fresh adapter too', async () => {
    const first = setup();
    await first.harness.submit({ job: job(), payload: payload() });
    const restarted = createCodexHarness({
      client: first.server, hosts: first.hosts, codec: new FakeCodec(), clock, evidence: new RecordingSink(), limits,
      deadlines,
    });
    expect((await restarted.submit({ job: job(), payload: payload() })).kind).toBe('harness_queued');
    expect(first.server.adds()).toBe(1);
  });

  it('does not add again in this process once the entry has left the queue', async () => {
    const { harness, server } = setup();
    await harness.submit({ job: job(), payload: payload() });
    server.consumeNext();
    const retry = await harness.submit({ job: job(), payload: payload() });
    expect(retry).toMatchObject({ kind: 'outcome_unknown', source: 'connector', errorCode: null });
    expect(server.adds()).toBe(1);
  });

  it.each<[string, (params: Record<string, unknown>) => CodexRequestOutcome]>([
    ['a malformed reply', () => ({ status: 'response', result: {} })],
    ['an uncorrelated reply', () => ({
      status: 'response', result: { queuedSubmission: { id: 'q-9', clientUserMessageId: 'someone-else' } },
    })],
    ['a native error reply', () => ({ status: 'remote_error', code: -32000 })],
    ['a lost reply', () => ({ status: 'lost', written: true, cause: 'disconnected' })],
    ['an unflushed timeout', () => ({ status: 'lost', written: false, cause: 'timeout' })],
  ])('does not add again after %s', async (_name, reply) => {
    const { harness, server } = setup();
    server.override('thread/queue/add', reply);
    expect((await harness.submit({ job: job(), payload: payload() })).kind).toBe('outcome_unknown');
    expect((await harness.submit({ job: job(), payload: payload() })).kind).toBe('outcome_unknown');
    expect(server.adds()).toBe(1);
  });

  it('may retry after a request that never reached the transport', async () => {
    const { harness, server } = setup();
    server.override('thread/queue/add', () => ({ status: 'not_sent' }));
    expect(await harness.submit({ job: job(), payload: payload() })).toMatchObject({ kind: 'failed', errorCode: 'harness_unavailable' });
    expect((await harness.submit({ job: job(), payload: payload() })).kind).toBe('harness_queued');
    expect(server.queue).toHaveLength(1);
  });

  it('shares one dispatch between concurrent submits of the same release', async () => {
    const { harness, server } = setup();
    const [a, b] = await Promise.all([
      harness.submit({ job: job(), payload: payload() }),
      harness.submit({ job: job(), payload: payload() }),
    ]);
    expect(a).toEqual(b);
    expect(a.kind).toBe('harness_queued');
    expect(server.adds()).toBe(1);
  });

  it('delivers a second release of identical text as its own decision', async () => {
    const { harness, server } = setup();
    await harness.submit({ job: job('rel-b-7'), payload: payload() });
    await harness.submit({ job: job('rel-b-8'), payload: payload() });
    expect(server.queue.map(entry => entry.clientUserMessageId)).toEqual(['rel-b-7', 'rel-b-8']);
  });

  it.each<[string, (s: FakeHarness) => void]>([
    ['the queue read is lost', s => {
      s.server.override('thread/queue/list', () => ({ status: 'lost', written: true, cause: 'timeout' }));
    }],
    ['the queue page is malformed', s => {
      s.server.override('thread/queue/list', () => ({ status: 'response', result: { data: null } }));
    }],
    ['the queue is longer than the page bound', s => {
      s.server.pageSize = 1;
      for (let i = 0; i < MAX_QUEUE_PAGES; i++) s.server.queue.push({ id: `q-${i}`, clientUserMessageId: `other-${i}`, text: 'x' });
      s.server.queue.push({ id: 'q-mine', clientUserMessageId: 'rel-b-7', text: 'x' });
    }],
  ])('refuses to send when %s', async (_name, arrange) => {
    const s = setup();
    arrange(s);
    expect(await s.harness.submit({ job: job(), payload: payload() }))
      .toMatchObject({ kind: 'failed', errorCode: 'harness_unavailable' });
    expect(s.server.adds()).toBe(0);
  });
});

describe('submit: repeat submit never reports failed once attempted', () => {
  it('a lost reply, then the host gone, then a resubmit stays outcome_unknown', async () => {
    const { harness, server, hosts } = setup();
    server.override('thread/queue/add', () => ({ status: 'lost', written: true, cause: 'disconnected' }));
    const first = await harness.submit({ job: job(), payload: payload() });
    expect(first).toMatchObject({ kind: 'outcome_unknown', errorCode: 'disconnected' });
    expect(server.adds()).toBe(1);

    hosts.host = null;
    const resubmit = await harness.submit({ job: job(), payload: payload() });
    expect(resubmit).toMatchObject({ kind: 'outcome_unknown', errorCode: null, source: 'connector' });
    expect(server.adds()).toBe(1);
  });

  it('an unreadable queue on a repeat submit stays outcome_unknown, not failed', async () => {
    const { harness, server } = setup();
    server.override('thread/queue/add', () => ({ status: 'lost', written: true, cause: 'disconnected' }));
    await harness.submit({ job: job(), payload: payload() });
    server.override('thread/queue/list', () => ({ status: 'lost', written: true, cause: 'timeout' }));
    const resubmit = await harness.submit({ job: job(), payload: payload() });
    expect(resubmit).toMatchObject({ kind: 'outcome_unknown', errorCode: 'harness_unavailable', source: 'connector' });
    expect(server.adds()).toBe(1);
  });

  it('a repeat submit against a closed adapter stays outcome_unknown, not failed', async () => {
    const { harness, server } = setup();
    server.override('thread/queue/add', () => ({ status: 'lost', written: true, cause: 'disconnected' }));
    await harness.submit({ job: job(), payload: payload() });
    await harness.close();
    const resubmit = await harness.submit({ job: job(), payload: payload() });
    expect(resubmit).toMatchObject({ kind: 'outcome_unknown', errorCode: null, source: 'connector' });
  });
});

describe('submit: AE2, uncertain outcomes stay uncertain', () => {
  it('a lost response after a flushed write is outcome_unknown, recorded as written', async () => {
    const { harness, server, evidence } = setup();
    server.override('thread/queue/add', () => ({ status: 'lost', written: true, cause: 'disconnected' }));
    const receipt = await harness.submit({ job: job(), payload: payload() });
    expectValid(receipt);
    expect(receipt).toMatchObject({ kind: 'outcome_unknown', errorCode: 'disconnected', source: 'connector' });
    expect(kinds(evidence.receipts)).toEqual(['transport_written']);
    expect(server.adds()).toBe(1);
  });

  it('a timeout with no observed flush is outcome_unknown without a written receipt', async () => {
    const { harness, evidence, server } = setup();
    server.override('thread/queue/add', () => ({ status: 'lost', written: false, cause: 'timeout' }));
    expect(await harness.submit({ job: job(), payload: payload() })).toMatchObject({ kind: 'outcome_unknown', errorCode: 'timeout' });
    expect(evidence.receipts).toEqual([]);
  });

  it('a malformed or uncorrelated native reply is outcome_unknown, not success', async () => {
    for (const result of [{}, { queuedSubmission: { id: 'q-1', clientUserMessageId: 'someone-else' } }]) {
      const { harness, server } = setup();
      server.override('thread/queue/add', () => ({ status: 'response', result }));
      expect(await harness.submit({ job: job(), payload: payload() })).toMatchObject({ kind: 'outcome_unknown', errorCode: null });
    }
  });

  it('a port that throws mid-request is a possible send whose write was not observed', async () => {
    const { harness, server, evidence } = setup();
    server.override('thread/queue/add', () => { throw new Error('socket reset'); });
    expect(await harness.submit({ job: job(), payload: payload() }))
      .toMatchObject({ kind: 'outcome_unknown', errorCode: 'disconnected' });
    expect(evidence.receipts).toEqual([]);
  });

  it('a native error reply is not proof that nothing was queued', async () => {
    const { harness, server } = setup();
    server.override('thread/queue/add', () => ({ status: 'remote_error', code: -32600 }));
    const receipt = await harness.submit({ job: job(), payload: payload() });
    expectValid(receipt);
    expect(receipt).toMatchObject({ kind: 'outcome_unknown', errorCode: 'harness_rejected', source: 'harness' });
  });

  it('a request that never reached the transport is a definite failure', async () => {
    const { harness, server } = setup();
    server.override('thread/queue/add', () => ({ status: 'not_sent' }));
    expect(await harness.submit({ job: job(), payload: payload() })).toMatchObject({ kind: 'failed', errorCode: 'harness_unavailable' });
  });

  it('an evidence store failure does not change the returned outcome', async () => {
    const { harness, evidence } = setup();
    evidence.fail = true;
    expect((await harness.submit({ job: job(), payload: payload() })).kind).toBe('harness_queued');
  });
});

describe('deadlines', () => {
  it('a hung queue/add is outcome_unknown by timeout, with no written receipt', async () => {
    vi.useFakeTimers();
    const { harness, server, evidence } = setup();
    server.override('thread/queue/add', never);
    const submitted = harness.submit({ job: job(), payload: payload() });
    await vi.advanceTimersByTimeAsync(deadlines.callMs);
    expect(await submitted).toMatchObject({ kind: 'outcome_unknown', errorCode: 'timeout' });
    expect(evidence.receipts).toEqual([]);
    expect(server.closed).toBe(server.opened);
  });

  it.each<[string, (s: FakeHarness) => void, string]>([
    ['codec', s => { s.codec.verify = never; }, 'failed'],
    ['evidence sink', s => { s.evidence.record = never; }, 'harness_queued'],
    ['connection close', s => {
      const connect = s.server.connect.bind(s.server);
      s.server.connect = async endpoint => {
        const connection = await connect(endpoint);
        return connection && { request: connection.request, close: never };
      };
    }, 'harness_queued'],
  ])('a hung %s cannot hang submit', async (_name, arrange, kind) => {
    vi.useFakeTimers();
    const s = setup();
    arrange(s);
    const submitted = s.harness.submit({ job: job(), payload: payload() });
    await vi.advanceTimersByTimeAsync(deadlines.callMs * 3);
    expect((await submitted).kind).toBe(kind);
  });

  it('close waits for in-flight work', async () => {
    const { harness, server } = setup();
    let release!: () => void;
    server.override('thread/queue/add', () => new Promise(resolve => {
      release = () => resolve({ status: 'response', result: { queuedSubmission: { id: 'q-1', clientUserMessageId: 'rel-b-7' } } });
    }));
    const submitted = harness.submit({ job: job(), payload: payload() });
    await vi.waitFor(() => expect(server.adds()).toBe(1));
    let closed = false;
    const closing = harness.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(closed).toBe(false);
    release();
    await closing;
    expect((await submitted).kind).toBe('harness_queued');
    expect(server.closed).toBe(server.opened);
  });

  it('a resubmit racing a concurrent close joins the in-flight submit instead of reporting failed', async () => {
    const { harness, server } = setup();
    let release!: () => void;
    server.override('thread/queue/add', () => new Promise(resolve => {
      release = () => resolve({ status: 'response', result: { queuedSubmission: { id: 'q-1', clientUserMessageId: 'rel-b-7' } } });
    }));
    const first = harness.submit({ job: job(), payload: payload() });
    await vi.waitFor(() => expect(server.adds()).toBe(1));
    const closing = harness.close();
    const resubmit = harness.submit({ job: job(), payload: payload() });
    release();
    const [firstReceipt, resubmitReceipt] = await Promise.all([first, resubmit]);
    await closing;
    expect(firstReceipt).toEqual(resubmitReceipt);
    expect(resubmitReceipt.kind).toBe('harness_queued');
    expect(server.adds()).toBe(1);
  });

  it('close is bounded when in-flight work hangs', async () => {
    vi.useFakeTimers();
    // The call deadline is far longer than the close deadline, so close must not wait it out.
    const stuck = createCodexHarness({
      client: setup().server, hosts: { lookup: never }, codec: new FakeCodec(), clock, evidence: new RecordingSink(),
      limits, deadlines: { callMs: 60_000, closeMs: deadlines.closeMs },
    });
    void stuck.inspect(binding());
    let closed = false;
    const closing = stuck.close().then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(deadlines.closeMs);
    await closing;
    expect(closed).toBe(true);
  });
});

describe('submit: refusals before any send', () => {
  it.each<[string, (s: FakeHarness) => void, string]>([
    ['payload digest mismatch', s => { s.codec.verdict = 'digest_mismatch'; }, 'payload_digest_mismatch'],
    ['unapproved event data in the payload', s => { s.codec.verdict = 'event_mismatch'; }, 'payload_digest_mismatch'],
    ['codec unavailable', s => { s.codec.verdict = 'throw'; }, 'payload_digest_mismatch'],
    ['changed binding generation', s => { s.hosts.host = { ...s.hosts.host!, binding: binding({ generation: 1 }) }; }, 'stale_binding'],
    ['stale native session id', s => { s.server.threadId = 'session-replacement'; }, 'session_unavailable'],
    ['absent session', s => { s.hosts.host = null; }, 'session_unavailable'],
    ['session exited', s => { s.server.reachable = false; }, 'harness_unavailable'],
    ['thread held by another executor', s => { s.hosts.host = { ...s.hosts.host!, holdsWriter: false }; }, 'session_unavailable'],
    ['thread not loaded', s => { s.server.status = 'notLoaded'; }, 'session_unavailable'],
    ['thread working in another directory', s => { s.server.cwd = '/home/owner/other'; }, 'session_unavailable'],
    ['unauthenticated endpoint', s => { s.hosts.host = { ...s.hosts.host!, endpointPrivate: false }; }, 'harness_unavailable'],
    ['untested version', s => { s.hosts.host = { ...s.hosts.host!, cliVersion: '0.160.0' }; }, 'harness_unavailable'],
    ['connect throws synchronously instead of rejecting', s => { s.server.connect = () => { throw new Error('socket exploded'); }; }, 'harness_unavailable'],
  ])('%s', async (_name, arrange, errorCode) => {
    const s = setup();
    arrange(s);
    const receipt = await s.harness.submit({ job: job(), payload: payload() });
    expectValid(receipt);
    expect(receipt).toMatchObject({ kind: 'failed', errorCode });
    expect(s.server.adds()).toBe(0);
    expect(s.server.closed).toBe(s.server.opened);
  });

  it('rejects a payload over the configured limit', async () => {
    const { harness, server } = setup();
    const big = new Uint8Array(limits.maxPayloadBytes + 1).fill(0x61);
    expect(await harness.submit({ job: job(), payload: big })).toMatchObject({ kind: 'failed', errorCode: 'limit_exceeded' });
    expect(server.opened).toBe(0);
  });

  it('rejects bytes that are not UTF-8 text', async () => {
    const { harness, server } = setup();
    const bytes = new Uint8Array([0xff, 0xfe]);
    expect(await harness.submit({ job: job('rel-b-7', binding(), bytes), payload: bytes }))
      .toMatchObject({ kind: 'failed', errorCode: 'harness_rejected' });
    expect(server.opened).toBe(0);
  });

  it('rejects bytes that differ from the released digest, whatever the codec says', async () => {
    const { harness, server } = setup();
    expect(await harness.submit({ job: job(), payload: payload('released text, edited after approval') }))
      .toMatchObject({ kind: 'failed', errorCode: 'payload_digest_mismatch' });
    expect(server.opened).toBe(0);
  });

  it('refuses after close', async () => {
    const { harness, server } = setup();
    await harness.close();
    expect(await harness.submit({ job: job(), payload: payload() })).toMatchObject({ kind: 'failed', errorCode: 'harness_unavailable' });
    expect(await harness.reconcile(job())).toBeNull();
    expect(server.opened).toBe(0);
  });
});

describe('plaintext handling', () => {
  it('keeps released text out of receipts, endpoints and logs on every path', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(level => vi.spyOn(console, level));
    const outcomes: DeliveryReceipt[] = [];
    const cases: ((s: FakeHarness) => void)[] = [
      () => {},
      s => s.server.override('thread/queue/add', () => ({ status: 'lost', written: true, cause: 'disconnected' })),
      s => s.server.override('thread/queue/add', () => ({ status: 'remote_error', code: -32000 })),
      s => s.server.override('thread/queue/add', () => { throw new Error(PLAINTEXT); }),
      s => { s.codec.verdict = 'digest_mismatch'; },
    ];
    for (const arrange of cases) {
      const s = setup();
      arrange(s);
      outcomes.push(await s.harness.submit({ job: job(), payload: payload() }), ...s.evidence.receipts);
      expect(JSON.stringify(s.server.endpoints)).not.toContain('quarterly');
    }
    expect(JSON.stringify(outcomes)).not.toContain('quarterly');
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
