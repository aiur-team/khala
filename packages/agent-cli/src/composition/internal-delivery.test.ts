import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InternalDescriptor } from '@khala/contracts/internal/descriptor';
import { afterEach, describe, expect, it } from 'vitest';
import type { BatchInbox } from '../cli/inbox.js';
import type { InboxDelivery } from '../cli/types.js';
import { deliveringInbox } from './delivering-inbox.js';
import { type InternalDelivery, createInternalDelivery } from './internal-delivery.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const CAPABILITY = 'B'.repeat(43);
const granted: InternalDescriptor = {
  v: 1, channelId: 'channel-one', origin: 'http://127.0.0.1:4100', transportCapability: 'A'.repeat(43),
  grantRef: 'grant-bob', bindingId: 'binding-bob', bindingCapability: CAPABILITY,
} as InternalDescriptor;
const held = { bindingId: 'binding-bob', generation: 3 };

function release(releaseId: string, wake: boolean) {
  const payload = Buffer.from(JSON.stringify(['khala.release.v1', releaseId]));
  return {
    releaseId,
    events: [{
      v: 1, roomId: 'channel-one', eventId: `event-${releaseId}`, authorParticipantId: 'participant-alice',
      authorDeviceId: 'device-alice', contentDigest: `sha256:${'0'.repeat(64)}`,
    }],
    payloadDigest: `sha256:${createHash('sha256').update(payload).digest('hex')}`,
    payloadBase64: payload.toString('base64'),
    releasedAt: '2026-09-25T00:00:00.000Z',
    wake,
  };
}

function page(overrides: Record<string, unknown> = {}) {
  return { v: 1, binding: held, releases: [], nextCursor: 'cursor-1', caughtUp: true, held: null, ...overrides };
}

type Reply = Readonly<{ status: number; body: unknown }>;

function server(replies: Reply[]) {
  const requests: { url: string; authorization: string | null }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
    const reply = replies.shift() ?? { status: 200, body: page() };
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  };
  return { fetch, requests };
}

function fakeInbox() {
  const durable = new Map<string, InboxDelivery>();
  const hints: string[] = [];
  const inbox = {
    async enqueue(delivery: InboxDelivery) {
      if (durable.has(delivery.releaseId)) return 'duplicate' as const;
      durable.set(delivery.releaseId, delivery);
      return 'appended' as const;
    },
    async notifyListener(reason: string) { hints.push(reason); return 'notified' as const; },
  } as unknown as BatchInbox;
  return { durable, hints, open: async () => inbox };
}

function subject(fetch: typeof globalThis.fetch, descriptor: InternalDescriptor = granted): InternalDelivery {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-delivery-'));
  directories.push(stateDirectory);
  return createInternalDelivery({
    descriptorPath: '/unused', stateDirectory, fetch, readDescriptor: () => ({ ok: true, value: descriptor }),
  });
}

describe('internal delivery pull', () => {
  it('pulls with the binding capability and resumes from the committed cursor', async () => {
    const { fetch, requests } = server([
      { status: 200, body: page({ releases: [release('r1', false)], nextCursor: 'cursor-1', caughtUp: false }) },
      { status: 200, body: page({ releases: [release('r2', false)], nextCursor: 'cursor-2' }) },
      { status: 200, body: page({ nextCursor: 'cursor-2' }) },
    ]);
    const delivery = subject(fetch);
    const inbox = fakeInbox();
    expect(await delivery.pull(held, inbox.open)).toBe('caught_up');
    expect(await delivery.pull(held, inbox.open)).toBe('caught_up');
    expect([...inbox.durable.keys()]).toEqual(['r1', 'r2']);
    expect(requests.map(request => new URL(request.url).search)).toEqual([
      '?limit=50', '?limit=50&cursor=cursor-1', '?limit=50&cursor=cursor-2',
    ]);
    expect(requests.every(request => request.authorization === `Bearer ${CAPABILITY}`)).toBe(true);
  });

  it('stamps records with the server release time so a re-pull is identical', async () => {
    const { fetch } = server([{ status: 200, body: page({ releases: [release('r1', false)] }) }]);
    const inbox = fakeInbox();
    await subject(fetch).pull(held, inbox.open);
    expect(inbox.durable.get('r1')).toMatchObject({
      bindingId: 'binding-bob', generation: 3, receivedAt: '2026-09-25T00:00:00.000Z',
    });
  });

  it('hints the listener only for a newly appended release marked wake', async () => {
    const quiet = fakeInbox();
    await subject(server([{ status: 200, body: page({ releases: [release('r1', false)] }) }]).fetch).pull(held, quiet.open);
    expect(quiet.hints).toEqual([]);

    const woken = fakeInbox();
    await subject(server([{ status: 200, body: page({ releases: [release('r1', true)] }) }]).fetch).pull(held, woken.open);
    expect(woken.hints).toEqual(['released']);

    const duplicate = fakeInbox();
    duplicate.durable.set('r1', {} as InboxDelivery);
    await subject(server([{ status: 200, body: page({ releases: [release('r1', true)] }) }]).fetch).pull(held, duplicate.open);
    expect(duplicate.hints).toEqual([]);
  });

  it('enqueues nothing from a page computed for another binding generation', async () => {
    const inbox = fakeInbox();
    const { fetch } = server([{
      status: 200, body: page({ binding: { ...held, generation: 4 }, releases: [release('r1', true)] }),
    }]);
    expect(await subject(fetch).pull(held, inbox.open)).toBe('revoked');
    expect(inbox.durable.size).toBe(0);
  });

  it('treats 401 as revoked and a 403 as retryable, enqueueing nothing', async () => {
    const revoked = fakeInbox();
    expect(await subject(server([{ status: 401, body: { error: { code: 'unauthenticated' } } }]).fetch)
      .pull(held, revoked.open)).toBe('revoked');
    const forbidden = fakeInbox();
    expect(await subject(server([{ status: 403, body: { error: { code: 'not_joined' } } }]).fetch)
      .pull(held, forbidden.open)).toBe('unavailable');
    expect(revoked.durable.size + forbidden.durable.size).toBe(0);
  });

  it('reports partial when the page budget runs out before the server is caught up', async () => {
    const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-delivery-'));
    directories.push(stateDirectory);
    const { fetch } = server([
      { status: 200, body: page({ releases: [release('r1', false)], nextCursor: 'cursor-1', caughtUp: false }) },
      { status: 200, body: page({ releases: [release('r2', false)], nextCursor: 'cursor-2', caughtUp: true }) },
    ]);
    const delivery = createInternalDelivery({
      descriptorPath: '/unused', stateDirectory, fetch, maxPages: 1, readDescriptor: () => ({ ok: true, value: granted }),
    });
    const inbox = fakeInbox();
    expect(await delivery.pull(held, inbox.open)).toBe('partial');
    expect(await delivery.pull(held, inbox.open)).toBe('caught_up');
    expect([...inbox.durable.keys()]).toEqual(['r1', 'r2']);
  });

  it('lets only one puller per binding generation run at a time', async () => {
    let unblock!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const fetch: typeof globalThis.fetch = async () => {
      await gate;
      return new Response(JSON.stringify(page({ releases: [release('r1', true)] })), { status: 200 });
    };
    const delivery = subject(fetch);
    const inbox = fakeInbox();
    const first = delivery.pull(held, inbox.open);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(await delivery.pull(held, inbox.open)).toBe('busy');
    unblock();
    expect(await first).toBe('caught_up');
    expect(await delivery.pull(held, inbox.open)).toBe('caught_up');
  });

  it('is revoked without a request when the descriptor no longer grants this binding', async () => {
    const { fetch, requests } = server([]);
    const transportOnly = { v: 1, channelId: 'channel-one', origin: granted.origin, transportCapability: 'A'.repeat(43) };
    expect(await subject(fetch, transportOnly as InternalDescriptor).pull(held, fakeInbox().open)).toBe('revoked');
    expect(await subject(fetch, { ...granted, bindingId: 'binding-other' } as InternalDescriptor).pull(held, fakeInbox().open))
      .toBe('revoked');
    expect(requests).toEqual([]);
  });

  it('keeps a held page behind its cursor', async () => {
    const inbox = fakeInbox();
    const { fetch } = server([{ status: 200, body: page({ held: 'paused', nextCursor: null, caughtUp: false }) }]);
    expect(await subject(fetch).pull(held, inbox.open)).toBe('held');
    expect(inbox.durable.size).toBe(0);
  });

  it('refuses a malformed release without enqueueing any of its page', async () => {
    const inbox = fakeInbox();
    const tampered = { ...release('r2', true), payloadDigest: `sha256:${'f'.repeat(64)}`, extra: true };
    const { fetch } = server([{ status: 200, body: page({ releases: [release('r1', true), tampered] }) }]);
    expect(await subject(fetch).pull(held, inbox.open)).toBe('unavailable');
    expect(inbox.durable.size).toBe(0);
  });
});

describe('delivering inbox', () => {
  it('pulls before the first open and stops pulling once stopped', async () => {
    const pulls: string[] = [];
    const delivery: InternalDelivery = {
      async pull(generation) { pulls.push(`${generation.bindingId}:${generation.generation}`); return 'caught_up'; },
      async acknowledge() {},
    };
    const opened: string[] = [];
    const wrapped = deliveringInbox(async (bindingId, generation) => {
      opened.push(`${bindingId}:${generation}`);
      return {} as BatchInbox;
    }, delivery, { intervalMs: 5 });
    await wrapped.inbox('binding-bob', 3);
    expect(pulls).toEqual(['binding-bob:3']);
    await new Promise(resolve => setTimeout(resolve, 30));
    await wrapped.stop();
    const after = pulls.length;
    expect(after).toBeGreaterThan(1);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(pulls.length).toBe(after);
  });

  it('waits for a concurrent puller before the first open', async () => {
    const outcomes: ('busy' | 'caught_up')[] = ['busy', 'busy', 'caught_up'];
    let pulls = 0;
    const wrapped = deliveringInbox(async () => ({} as BatchInbox), {
      async pull() { pulls += 1; return outcomes.shift() ?? 'caught_up'; },
      async acknowledge() {},
    }, { intervalMs: 60_000 });
    await wrapped.inbox('binding-bob', 3);
    await wrapped.stop();
    expect(pulls).toBe(3);
  });

  it('never loops for a revoked generation', async () => {
    let pulls = 0;
    const wrapped = deliveringInbox(async () => ({} as BatchInbox), {
      async pull() { pulls += 1; return 'revoked'; },
      async acknowledge() {},
    }, { intervalMs: 1 });
    await wrapped.inbox('binding-bob', 3);
    await new Promise(resolve => setTimeout(resolve, 20));
    await wrapped.stop();
    expect(pulls).toBe(1);
  });
});
