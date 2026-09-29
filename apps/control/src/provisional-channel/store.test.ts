import { describe, expect, it } from 'vitest';
import type { CompareAndSetInput, ControlRecord, ControlStore, JsonValue } from '@khala/contracts/messaging/index';
import { createProvisionalChannelStore } from './store';

function fixture(ticking = false) {
  const records = new Map<string, ControlRecord>();
  const operations = new Map<string, Readonly<{ key: string; value: JsonValue }>>();
  let revision = 0;
  let now = Date.parse('2026-09-28T12:00:00Z');
  let loseResponse = false;
  const store: ControlStore = {
    async read<T extends JsonValue>(key: string) {
      const record = records.get(key);
      return record ? { kind: 'record' as const, record: record as ControlRecord<T> } : { kind: 'absent' as const };
    },
    async compareAndSet<T extends JsonValue>(input: CompareAndSetInput<T>) {
      const used = operations.get(input.operationId);
      if (used && (used.key !== input.key || JSON.stringify(used.value) !== JSON.stringify(input.next.value))) {
        return { kind: 'operation_mismatch' as const };
      }
      const current = records.get(input.key);
      if ((current?.revision ?? null) !== input.expectedRevision) {
        return { kind: 'conflict' as const, current: (current ?? null) as ControlRecord<T> | null };
      }
      const record: ControlRecord<T> = { key: input.key, revision: String(++revision),
        operationId: input.operationId, value: input.next.value, expiresAt: input.next.expiresAt };
      records.set(input.key, record);
      operations.set(input.operationId, { key: input.key, value: input.next.value });
      if (loseResponse) {
        loseResponse = false;
        return { kind: 'outcome_unknown' as const, operationId: input.operationId };
      }
      return { kind: 'applied' as const, record };
    },
    async resolve<T extends JsonValue>({ key, operationId }: Readonly<{ key: string; operationId: string }>) {
      const record = records.get(key);
      return record?.operationId === operationId
        ? { kind: 'applied' as const, record: record as ControlRecord<T> }
        : { kind: 'not_applied' as const };
    },
  };
  const secret = Buffer.alloc(32, 7);
  const open = () => createProvisionalChannelStore({ store, secret, clock: () => ticking ? now++ : now });
  return { open, advance: (milliseconds: number) => { now += milliseconds; }, loseNextResponse: () => { loseResponse = true; } };
}

const session = { harness: 'codex' as const, sessionId: 'thread-1', generation: 0 };

describe('provisional channel claim journal', () => {
  it('reuses the exact session channel across a process restart and a lost create response', async () => {
    const f = fixture();
    f.loseNextResponse();
    const first = await f.open().start(session);
    const retried = await f.open().start(session);
    expect(first).toEqual(retried);
    expect(first.kind).toBe('provisional');
    expect(await f.open().start({ ...session, sessionId: 'thread-2' })).not.toEqual(first);
  });

  it('converges concurrent creates even when their expiry times differ', async () => {
    const f = fixture(true);
    const [first, second] = await Promise.all([f.open().start(session), f.open().start(session)]);
    expect(first.kind).toBe('provisional');
    expect(second).toEqual(first);
  });

  it('lets one human claim and rejects a competing account without changing ownership', async () => {
    const f = fixture();
    const started = await f.open().start(session);
    if (started.kind !== 'provisional') throw new Error('expected provisional channel');
    const [a, b] = await Promise.all([
      f.open().claim(started.claimToken, 'owner-a' as never),
      f.open().claim(started.claimToken, 'owner-b' as never),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(['claimed', 'conflict']);
    const winner = a.kind === 'claimed' ? 'owner-a' : 'owner-b';
    const loser = winner === 'owner-a' ? 'owner-b' : 'owner-a';
    expect(await f.open().claim(started.claimToken, winner as never)).toMatchObject({ kind: 'claimed', repeated: true });
    expect(await f.open().claim(started.claimToken, loser as never)).toEqual({ kind: 'conflict' });
    expect(await f.open().start(session)).toEqual({ kind: 'already_claimed', channelId: started.channelId });
  });

  it('expires and rotates the token without accepting a replay', async () => {
    const f = fixture();
    const first = await f.open().start(session);
    if (first.kind !== 'provisional') throw new Error('expected provisional channel');
    f.advance(24 * 60 * 60 * 1_000);
    expect(await f.open().claim(first.claimToken, 'owner-a' as never)).toEqual({ kind: 'expired' });
    const second = await f.open().start(session);
    expect(second.kind).toBe('provisional');
    expect(second).not.toEqual(first);
    expect(await f.open().claim(first.claimToken, 'owner-a' as never)).toEqual({ kind: 'expired' });
    expect(await f.open().claim(first.claimToken.slice(0, -1) + 'x', 'owner-a' as never)).toEqual({ kind: 'invalid' });
  });

  it('recovers a claim whose CAS response was lost', async () => {
    const f = fixture();
    const started = await f.open().start(session);
    if (started.kind !== 'provisional') throw new Error('expected provisional channel');
    f.loseNextResponse();
    expect(await f.open().claim(started.claimToken, 'owner-a' as never)).toMatchObject({ kind: 'claimed' });
  });
});
