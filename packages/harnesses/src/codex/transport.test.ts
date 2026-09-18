import { type DeliveryReceipt, decodeDeliveryReceipt } from '@khala/contracts/delivery/index';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FakeAppServer, FakeCodec, FakeHosts, PLAINTEXT, RecordingSink, binding, clock, job, limits, payload,
} from './fakes';
import { createCodexHarness } from './index';
import { receiptIdFor } from './receipts';

function setup(hostOverrides: ConstructorParameters<typeof FakeHosts>[0] = {}) {
  const server = new FakeAppServer();
  const hosts = new FakeHosts(hostOverrides);
  const codec = new FakeCodec();
  const evidence = new RecordingSink();
  const harness = createCodexHarness({ client: server, hosts, codec, clock, evidence, limits });
  return { server, hosts, codec, evidence, harness };
}

const kinds = (receipts: readonly DeliveryReceipt[]) => receipts.map(r => r.kind);

function expectValid(receipt: DeliveryReceipt) {
  expect(decodeDeliveryReceipt(receipt)).toEqual({ ok: true, value: receipt });
}

afterEach(() => vi.restoreAllMocks());

describe('submit: worked lifecycle', () => {
  it('queues exactly the released text once, correlated by release ID', async () => {
    const { harness, server, evidence } = setup();
    const receipt = await harness.submit({ job: job(), payload: payload() });

    expectValid(receipt);
    expect(receipt).toMatchObject({
      kind: 'harness_queued', releaseId: 'rel-b-7', bindingId: 'bind-b-1', generation: 0, source: 'harness',
      errorCode: null, receiptId: receiptIdFor(job().releaseId, 'harness_queued'),
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

  it('reports a consumed release instead of adding it again, even from a fresh adapter', async () => {
    const first = setup();
    await first.harness.submit({ job: job(), payload: payload() });
    first.server.consumeNext('inProgress');
    // A restarted process has no in-memory memory of the first submit.
    const restarted = createCodexHarness({
      client: first.server, hosts: first.hosts, codec: new FakeCodec(), clock, evidence: new RecordingSink(), limits,
    });
    expect((await restarted.submit({ job: job(), payload: payload() })).kind).toBe('context_consumed');
    first.server.turns[0]!.status = 'completed';
    expect((await restarted.submit({ job: job(), payload: payload() })).kind).toBe('completed');
    expect(first.server.adds()).toBe(1);
  });

  it('delivers a second release of identical text as its own decision', async () => {
    const { harness, server } = setup();
    await harness.submit({ job: job('rel-b-7'), payload: payload() });
    await harness.submit({ job: job('rel-b-8'), payload: payload() });
    expect(server.queue.map(entry => entry.clientUserMessageId)).toEqual(['rel-b-7', 'rel-b-8']);
  });

  it('refuses to send when native state cannot be read to rule out a duplicate', async () => {
    const { harness, server } = setup();
    server.override('thread/read', () => undefined)
      .override('thread/read', () => ({ status: 'lost', written: true, cause: 'timeout' }));
    const receipt = await harness.submit({ job: job(), payload: payload() });
    expect(receipt).toMatchObject({ kind: 'failed', errorCode: 'harness_unavailable' });
    expect(server.adds()).toBe(0);
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

  it('a port that throws mid-request is treated as a possible send', async () => {
    const { harness, server } = setup();
    server.override('thread/queue/add', () => { throw new Error('socket reset'); });
    expect(await harness.submit({ job: job(), payload: payload() })).toMatchObject({ kind: 'outcome_unknown' });
  });

  it('a native JSON-RPC refusal is a definite failure', async () => {
    const { harness, server } = setup();
    server.override('thread/queue/add', () => ({ status: 'remote_error', code: -32600 }));
    expect(await harness.submit({ job: job(), payload: payload() })).toMatchObject({ kind: 'failed', errorCode: 'harness_rejected' });
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

describe('submit: refusals before any send', () => {
  it.each([
    ['payload digest mismatch', (s: ReturnType<typeof setup>) => { s.codec.verdict = 'digest_mismatch'; }, 'payload_digest_mismatch'],
    ['unapproved event data in the payload', (s: ReturnType<typeof setup>) => { s.codec.verdict = 'event_mismatch'; }, 'payload_digest_mismatch'],
    ['codec unavailable', (s: ReturnType<typeof setup>) => { s.codec.verdict = 'throw'; }, 'payload_digest_mismatch'],
    ['changed binding generation', (s: ReturnType<typeof setup>) => { s.hosts.host = { ...s.hosts.host!, binding: binding({ generation: 1 }) }; }, 'stale_binding'],
    ['stale native session id', (s: ReturnType<typeof setup>) => { s.server.threadId = 'session-replacement'; }, 'session_unavailable'],
    ['absent session', (s: ReturnType<typeof setup>) => { s.hosts.host = null; }, 'session_unavailable'],
    ['session exited', (s: ReturnType<typeof setup>) => { s.server.reachable = false; }, 'harness_unavailable'],
    ['thread held by another executor', (s: ReturnType<typeof setup>) => { s.hosts.host = { ...s.hosts.host!, holdsWriter: false }; }, 'session_unavailable'],
    ['thread not loaded', (s: ReturnType<typeof setup>) => { s.server.status = 'notLoaded'; }, 'session_unavailable'],
    ['unauthenticated endpoint', (s: ReturnType<typeof setup>) => { s.hosts.host = { ...s.hosts.host!, endpointPrivate: false }; }, 'harness_unavailable'],
    ['untested version', (s: ReturnType<typeof setup>) => { s.hosts.host = { ...s.hosts.host!, cliVersion: '0.160.0' }; }, 'harness_unavailable'],
  ] as const)('%s', async (_name, arrange, errorCode) => {
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
    expect(await harness.submit({ job: job(), payload: new Uint8Array([0xff, 0xfe]) }))
      .toMatchObject({ kind: 'failed', errorCode: 'harness_rejected' });
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
    const cases: ((s: ReturnType<typeof setup>) => void)[] = [
      () => {},
      s => s.server.override('thread/queue/add', () => ({ status: 'lost', written: true, cause: 'disconnected' })),
      s => s.server.override('thread/queue/add', () => ({ status: 'remote_error', code: -32000 })),
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
