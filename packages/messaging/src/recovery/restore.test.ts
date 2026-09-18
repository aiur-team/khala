import type { OwnerId } from '@khala/contracts/messaging/index';
import { describe, expect, it } from 'vitest';
import type { RecoveryIdentity, RecoverySession } from './capabilities';
import { runRestore, type RecoverySubstrate, type RestoreResult } from './restore';

const alice = 'owner_alice' as OwnerId;
const ready = { kind: 'signed_in', ownerId: alice, generation: 2 } as const;

function changingIdentity(initial: RecoverySession = ready) {
  let session = initial;
  const listeners = new Set<(next: RecoverySession) => void>();
  const identity: RecoveryIdentity = {
    async current() { return session; },
    observe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return { identity, change(next: RecoverySession) { session = next; for (const listener of listeners) listener(next); } };
}

function substrate(restore: RecoverySubstrate['restore'], material = { ownerId: alice, id: 'material_1', version: 'v1', trusted: true }): RecoverySubstrate {
  return {
    async capabilities() { return { kind: 'ready', modes: ['transfer'] }; },
    async material() { return material; },
    restore,
  };
}

const input = (identity: RecoveryIdentity, sdk: RecoverySubstrate, provideSecret: () => Promise<Uint8Array | null>) => ({
  operationId: 'recover_1', mode: 'transfer', approvedVersion: 'v1', initialSession: ready,
  initialAttempts: 0, initialAttemptPhase: 'idle' as const, maxSecretAttempts: 2, provideSecret,
  checkAttempt: async () => 'available' as const, reserveAttempt: async () => 'reserved' as const,
  onAttempt: async () => true, identity, substrate: sdk,
});

describe('endpoint-local restore', () => {
  it('zeros rejected secrets, bounds retries and exposes no entered value', async () => {
    const account = changingIdentity();
    const first = new Uint8Array([11, 22]);
    const second = new Uint8Array([33, 44]);
    const secrets = [first, second];
    const seen: number[][] = [];
    const sdk = substrate(async ({ secret }): Promise<RestoreResult> => {
      seen.push([...secret]);
      return { kind: 'secret_rejected' };
    });
    const result = await runRestore(input(account.identity, sdk, async () => secrets.shift() ?? null));
    expect(result).toEqual({ kind: 'terminal', state: 'failed', reason: 'secret_rejected', history: { restored: 0, unavailable: 0 }, attempts: 2 });
    expect(seen).toEqual([[11, 22], [33, 44]]);
    expect(secrets).toEqual([]);
    expect([...first]).toEqual([0, 0]);
    expect([...second]).toEqual([0, 0]);
  });

  it('reports partial history rather than claiming a complete restore', async () => {
    const account = changingIdentity();
    const secret = new Uint8Array([1, 2, 3]);
    const result = await runRestore(input(
      account.identity,
      substrate(async () => ({ kind: 'restored', history: { restored: 1, unavailable: 2 } })),
      async () => secret,
    ));
    expect(result).toEqual({ kind: 'terminal', state: 'partial', reason: null, history: { restored: 1, unavailable: 2 }, attempts: 1 });
    expect([...secret]).toEqual([0, 0, 0]);
  });

  it('rejects invalid SDK history counts instead of journaling them', async () => {
    const account = changingIdentity();
    const result = await runRestore(input(
      account.identity,
      substrate(async () => ({ kind: 'restored', history: { restored: -1, unavailable: 0 } })),
      async () => new Uint8Array([1]),
    ));
    expect(result).toEqual({ kind: 'terminal', state: 'failed', reason: 'backup_corrupt', history: { restored: 0, unavailable: 0 }, attempts: 1 });
  });

  it('discards an SDK result after an account generation changes', async () => {
    const account = changingIdentity();
    let finish!: (result: RestoreResult) => void;
    let entered!: () => void;
    const restoring = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<RestoreResult>(resolve => { finish = resolve; });
    const promise = runRestore(input(account.identity, substrate(async () => { entered(); return pending; }), async () => new Uint8Array([9])));
    await restoring;
    account.change({ kind: 'signed_in', ownerId: alice, generation: 3 });
    finish({ kind: 'restored', history: { restored: 10, unavailable: 0 } });
    expect(await promise).toEqual({ kind: 'terminal', state: 'failed', reason: 'cancelled_locally', history: { restored: 0, unavailable: 0 }, attempts: 1 });
  });

  it('aborts the SDK before a switched account can receive imported state', async () => {
    const account = changingIdentity();
    const imported: string[] = [];
    let entered!: () => void;
    let continueRestore!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { continueRestore = resolve; });
    const sdk = substrate(async (_input, options) => {
      entered();
      await resume;
      if (options?.signal?.aborted) return { kind: 'cancelled' };
      imported.push('old-owner-keys');
      return { kind: 'restored', history: { restored: 1, unavailable: 0 } };
    });
    const pending = runRestore(input(account.identity, sdk, async () => new Uint8Array([1])));
    await started;
    account.change({ kind: 'signed_in', ownerId: 'owner_bob' as OwnerId, generation: 3 });
    continueRestore();
    expect(await pending).toMatchObject({ kind: 'terminal', state: 'failed', reason: 'cancelled_locally' });
    expect(imported).toEqual([]);
  });

  it('wipes a late prompt secret and never invokes the SDK after an account switch', async () => {
    const account = changingIdentity();
    let resolvePrompt!: (value: Uint8Array) => void;
    let promptEntered!: () => void;
    const entered = new Promise<void>(resolve => { promptEntered = resolve; });
    const prompt = new Promise<Uint8Array>(resolve => { resolvePrompt = resolve; });
    let restores = 0;
    const pending = runRestore(input(account.identity, substrate(async () => {
      restores += 1;
      return { kind: 'restored', history: { restored: 1, unavailable: 0 } };
    }), async () => { promptEntered(); return prompt; }));
    await entered;
    account.change({ kind: 'signed_in', ownerId: alice, generation: 3 });
    const late = new Uint8Array([9, 8]);
    resolvePrompt(late);
    expect(await pending).toMatchObject({ kind: 'terminal', state: 'failed', reason: 'cancelled_locally' });
    expect([...late]).toEqual([0, 0]);
    expect(restores).toBe(0);
  });

  it('blocks owner, format and trust mismatches before requesting a secret', async () => {
    for (const material of [
      { ownerId: 'owner_bob' as OwnerId, id: 'material_1', version: 'v1', trusted: true },
      { ownerId: alice, id: 'material_1', version: 'v0', trusted: true },
      { ownerId: alice, id: 'material_1', version: 'v1', trusted: false },
    ]) {
      const account = changingIdentity();
      let prompts = 0;
      const result = await runRestore(input(
        account.identity,
        substrate(async () => ({ kind: 'restored', history: { restored: 1, unavailable: 0 } }), material),
        async () => { prompts += 1; return new Uint8Array([1]); },
      ));
      expect(result).toMatchObject({ kind: 'terminal', reason: 'backup_corrupt' });
      expect(prompts).toBe(0);
    }
  });
});
