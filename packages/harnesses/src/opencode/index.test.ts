import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type DeliveryReceipt, type ReleasedJob, type SessionBinding, decodeApprovalCommand, decodeDeliveryLimits,
  decodeDeliveryReceipt, decodeHarnessCapabilities, decodeSessionBinding, releaseFromApproval,
} from '@khala/contracts/delivery/index';
import exact from '../../../contracts/fixtures/delivery/exact-release.json';
import {
  OPENCODE_HARNESS, type OpenCodeInboxDelivery, type OpenCodeInboxPort, type OpenCodePluginInspection,
  createOpenCodeHarness, openCodeCapabilities,
} from './index';

const unwrap = <T>(decoded: { ok: true; value: T } | { ok: false; field: string }): T => {
  if (!decoded.ok) throw new Error(`fixture failed at ${decoded.field}`);
  return decoded.value;
};

const limits = unwrap(decodeDeliveryLimits(exact.limits));
const text = 'released: please confirm release-nonce-7';
const payload = new TextEncoder().encode(text);
const digest = `sha256:${createHash('sha256').update(payload).digest('hex')}`;
const clock = { now: () => new Date('2026-09-25T10:00:00.000Z') };

function binding(generation = 0): SessionBinding {
  return unwrap(decodeSessionBinding({ ...exact.binding, harness: OPENCODE_HARNESS, sessionId: 'ses-a', generation }));
}

// The approval fixture is fenced to generation 0, so every job targets it.
function releasedJob(overrides: Partial<{ payloadDigest: string }> = {}): ReleasedJob {
  const approval = unwrap(decodeApprovalCommand(exact.approvalCommand, limits));
  const released = releaseFromApproval({
    approval,
    items: approval.selection,
    binding: binding(),
    policyVersion: approval.expectedPolicyVersion,
    release: { ...exact.release, payloadDigest: digest, ...overrides } as never,
  });
  if (!released.ok) throw new Error(`release failed: ${released.code}`);
  return released.value;
}

type Deferred = Readonly<{ promise: Promise<void>; resolve(): void }>;

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/**
 * A durable store shared across adapter instances, standing in for the on-disk
 * inbox: it survives a "crash" of the adapter that wrote it.
 */
function durableStore() {
  const records = new Map<string, string>();
  const log: string[] = [];
  const opened: SessionBinding[] = [];
  const notifyArgs: unknown[][] = [];
  const stored: OpenCodeInboxDelivery[] = [];
  let appendGate: Deferred | null = null;
  let appendFails = false;
  let notification: 'notified' | 'unavailable' | 'throws' = 'notified';

  const inbox = async (target: SessionBinding): Promise<OpenCodeInboxPort> => {
    opened.push(target);
    return {
      async enqueue(delivery) {
        log.push(`enqueue:${target.generation}`);
        if (appendGate) await appendGate.promise;
        if (appendFails) throw new Error('storage_failed');
        const key = `${delivery.bindingId}/${delivery.generation}/${delivery.releaseId}`;
        const encoded = JSON.stringify({ ...delivery, payload: [...delivery.payload], receivedAt: null });
        const previous = records.get(key);
        if (previous !== undefined) {
          if (previous !== encoded) throw new Error('invalid_input');
          log.push('duplicate');
          return 'duplicate';
        }
        records.set(key, encoded);
        stored.push(delivery);
        log.push('synced');
        return 'appended';
      },
      async notifyListener(...args: unknown[]) {
        notifyArgs.push(args);
        log.push(`notify:${target.generation}`);
        if (notification === 'throws') throw new Error('listener crashed');
        return notification;
      },
    };
  };

  return {
    inbox,
    records,
    log,
    opened,
    notifyArgs,
    stored,
    gateAppend() { appendGate = deferred(); return appendGate; },
    failAppend() { appendFails = true; },
    setNotification(next: typeof notification) { notification = next; },
  };
}

function probeFor(target: SessionBinding | null, version: string | null = '1.17.10') {
  const calls: string[] = [];
  return {
    calls,
    probe: {
      async inspect(sessionId: string): Promise<OpenCodePluginInspection> {
        calls.push(sessionId);
        return { version, bindingId: target?.bindingId ?? null, generation: target?.generation ?? null };
      },
    },
  };
}

async function inspectedHarness(store: ReturnType<typeof durableStore>, generation = 0) {
  const harness = createOpenCodeHarness({ probe: probeFor(binding(generation)).probe, inbox: store.inbox, clock, limits });
  await harness.inspect(binding(generation));
  return harness;
}

describe('openCodeCapabilities', () => {
  it('claims no deliverable route until the delivery contract names one', () => {
    const report = openCodeCapabilities('1.17.10', limits);
    expect(unwrap(decodeHarnessCapabilities(report))).toEqual(report);
    expect(report).toMatchObject({
      harness: OPENCODE_HARNESS,
      support: 'unsupported',
      existingSession: 'unknown',
      immediateNotification: 'unknown',
      evidenceRef: null,
      acknowledgement: 'unknown',
    });
    expect(Object.values(report.modes).map(mode => mode.status)).toEqual(['unknown', 'unknown', 'unknown']);
    expect(report.receiptEvidence).not.toContain('context_consumed');
  });

  it('reports an absent or malformed version as unknown without echoing it', () => {
    expect(openCodeCapabilities(null, limits).version).toBe('unknown');
    expect(openCodeCapabilities('1.17.10\nsecret', limits).version).toBe('unknown');
  });
});

describe('createOpenCodeHarness', () => {
  it('syncs the release before the first hint is sent', async () => {
    const store = durableStore();
    const harness = await inspectedHarness(store);
    const gate = store.gateAppend();

    const receipt = harness.submit({ job: releasedJob(), payload });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(store.log).toEqual(['enqueue:0']);
    gate.resolve();

    expect((await receipt).kind).toBe('transport_written');
    expect(store.log).toEqual(['enqueue:0', 'synced', 'notify:0']);
  });

  it('sends no hint when the append is not known to be durable', async () => {
    const store = durableStore();
    const harness = await inspectedHarness(store);
    store.failAppend();

    const receipt = await harness.submit({ job: releasedJob(), payload });
    expect(receipt).toMatchObject({ kind: 'outcome_unknown', errorCode: 'harness_unavailable' });
    expect(store.log).toEqual(['enqueue:0']);
  });

  it('recovers a crash between append and hint with one catch-up hint and no second record', async () => {
    const store = durableStore();
    const crashed = await inspectedHarness(store);
    store.setNotification('throws');
    const first = await crashed.submit({ job: releasedJob(), payload });
    expect(store.records.size).toBe(1);

    store.setNotification('notified');
    store.log.length = 0;
    const restarted = await inspectedHarness(store);
    const retry = await restarted.submit({ job: releasedJob(), payload });

    expect(store.log).toEqual(['enqueue:0', 'duplicate', 'notify:0']);
    expect(store.records.size).toBe(1);
    expect(retry).toEqual(first);
  });

  it('joins concurrent submissions of one release into one durable write and one hint', async () => {
    const store = durableStore();
    const harness = await inspectedHarness(store);
    const gate = store.gateAppend();

    const submissions = [0, 1, 2].map(() => harness.submit({ job: releasedJob(), payload }));
    gate.resolve();
    const receipts = await Promise.all(submissions);

    expect(new Set(receipts.map(receipt => receipt.receiptId)).size).toBe(1);
    expect(store.log).toEqual(['enqueue:0', 'synced', 'notify:0']);
  });

  it('refuses stale, uninspected, mismatched or oversized releases before touching the inbox', async () => {
    const store = durableStore();
    const harness = await inspectedHarness(store);
    const newer = await inspectedHarness(store, 1);
    const uninspected = createOpenCodeHarness({ probe: probeFor(null).probe, inbox: store.inbox, clock, limits });
    await uninspected.inspect(binding(0));

    // Sequential: concurrent submissions of one release would join each other.
    const cases: Array<[() => Promise<DeliveryReceipt>, string]> = [
      [() => newer.submit({ job: releasedJob(), payload }), 'stale_binding'],
      [() => uninspected.submit({ job: releasedJob(), payload }), 'session_unavailable'],
      [
        () => harness.submit({ job: releasedJob({ payloadDigest: `sha256:${'0'.repeat(64)}` }), payload }),
        'payload_digest_mismatch',
      ],
      [() => harness.submit({ job: releasedJob(), payload: new Uint8Array(limits.maxPayloadBytes + 1) }), 'limit_exceeded'],
    ];
    for (const [submit, errorCode] of cases) {
      expect(await submit()).toMatchObject({ kind: 'failed', errorCode });
    }
    await harness.close();
    expect(await harness.submit({ job: releasedJob(), payload }))
      .toMatchObject({ kind: 'failed', errorCode: 'harness_unavailable' });
    expect(store.log).toEqual([]);
    expect(store.opened).toEqual([]);
  });

  it('keeps the release durable and claims only the write when no listener is live', async () => {
    const store = durableStore();
    const harness = await inspectedHarness(store);
    store.setNotification('unavailable');

    const receipt = await harness.submit({ job: releasedJob(), payload });
    expect(receipt).toMatchObject({ kind: 'transport_written', source: 'connector', evidenceRef: null });
    expect(unwrap(decodeDeliveryReceipt(receipt))).toEqual(receipt);
    expect(store.records.size).toBe(1);
  });

  it('keeps released bytes out of the hint and the receipt', async () => {
    const store = durableStore();
    const harness = await inspectedHarness(store);

    const receipt = await harness.submit({ job: releasedJob(), payload });
    expect(store.notifyArgs).toEqual([[]]);
    expect(store.stored[0]?.payload).toEqual(payload);
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain('release-nonce-7');
    expect(serialized).not.toContain(Buffer.from(payload).toString('base64'));
    expect(serialized).not.toContain('ses-a');
  });

  it('wakes only the exactly inspected binding generation', async () => {
    const store = durableStore();
    const harness = await inspectedHarness(store, 1);

    await harness.catchUp(binding(0));
    await harness.notify(binding(0), { v: 1, releaseId: releasedJob().releaseId });
    expect(store.log).toEqual([]);

    await harness.catchUp(binding(1));
    expect(store.log).toEqual(['notify:1']);
    expect(store.opened.map(opened => opened.generation)).toEqual([1]);

    const mismatched = createOpenCodeHarness({ probe: probeFor(binding(0)).probe, inbox: store.inbox, clock, limits });
    await mismatched.inspect(binding(1));
    await mismatched.catchUp(binding(1));
    expect(store.log).toEqual(['notify:1']);
  });

  it('lets an in-flight submission finish on close, then revokes every later wake', async () => {
    const store = durableStore();
    const harness = await inspectedHarness(store);
    const gate = store.gateAppend();

    const receipt = harness.submit({ job: releasedJob(), payload });
    const closing = harness.close();
    const joined = harness.submit({ job: releasedJob(), payload });
    gate.resolve();
    await closing;
    expect((await receipt).kind).toBe('transport_written');
    expect(await joined).toBe(await receipt);

    store.log.length = 0;
    await harness.catchUp(binding());
    await harness.notify(binding(), { v: 1, releaseId: releasedJob().releaseId });
    expect(store.log).toEqual([]);
    await expect(harness.inspect(binding())).rejects.toThrow('closed');
  });

  it('exposes no process-control surface', () => {
    const harness = createOpenCodeHarness({
      probe: probeFor(binding()).probe, inbox: durableStore().inbox, clock, limits,
    });
    expect(Object.keys(harness).sort()).toEqual(['catchUp', 'close', 'inspect', 'notify', 'reconcile', 'submit']);
  });

  it('refuses a binding for another harness before probing', async () => {
    const { probe, calls } = probeFor(binding());
    const harness = createOpenCodeHarness({ probe, inbox: durableStore().inbox, clock, limits });
    await expect(harness.inspect({ ...binding(), harness: 'codex' })).rejects.toThrow('another harness');
    expect(calls).toEqual([]);
  });
});
