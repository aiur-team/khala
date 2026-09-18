import type {
  ControlRecord, ControlStore, JsonValue, OwnerId, WriteResult,
} from '@khala/contracts/messaging/index';
import { decodeRecoveryStatus, sameJsonValue } from '@khala/contracts/messaging/index';
import { describe, expect, it } from 'vitest';
import type { RecoveryIdentity } from './capabilities';
import { createRecoveryService } from './service';
import type { RecoverySubstrate } from './restore';

const alice = 'owner_alice' as OwnerId;
const mode = { id: 'trusted-device-transfer', version: 'webcrypto-aes-gcm/v1' };

function memoryControlStore(unknownWrite?: (operationId: string) => boolean): ControlStore {
  const records = new Map<string, ControlRecord>();
  const writes = new Map<string, Readonly<{ key: string; value: JsonValue }>>();
  let revision = 0;
  return {
    async read<T extends JsonValue>(key: string) {
      const record = records.get(key);
      return record ? { kind: 'record' as const, record: record as ControlRecord<T> } : { kind: 'absent' as const };
    },
    async compareAndSet<T extends JsonValue>(input: Parameters<ControlStore['compareAndSet']>[0]): Promise<WriteResult<T>> {
      const prior = writes.get(input.operationId);
      if (prior && (prior.key !== input.key || !sameJsonValue(prior.value, input.next.value))) return { kind: 'operation_mismatch' };
      const current = records.get(input.key) ?? null;
      if (prior && current?.operationId === input.operationId) return { kind: 'applied', record: current as ControlRecord<T> };
      if ((current?.revision ?? null) !== input.expectedRevision) return { kind: 'conflict', current: current as ControlRecord<T> | null };
      if (unknownWrite?.(input.operationId)) {
        writes.set(input.operationId, { key: input.key, value: input.next.value });
        return { kind: 'outcome_unknown', operationId: input.operationId };
      }
      revision += 1;
      const record: ControlRecord = { key: input.key, revision: `r${revision}`, operationId: input.operationId, ...input.next };
      records.set(input.key, record);
      writes.set(input.operationId, { key: input.key, value: input.next.value });
      return { kind: 'applied', record: record as ControlRecord<T> };
    },
    async resolve<T extends JsonValue>(input: Readonly<{ key: string; operationId: string }>) {
      if (unknownWrite?.(input.operationId)) return { kind: 'outcome_unknown' as const, operationId: input.operationId };
      const record = records.get(input.key);
      return record?.operationId === input.operationId
        ? { kind: 'applied' as const, record: record as ControlRecord<T> }
        : { kind: 'not_applied' as const };
    },
  };
}

function identity(): RecoveryIdentity {
  return {
    async current() { return { kind: 'signed_in', ownerId: alice, generation: 7 }; },
    observe() { return () => undefined; },
  };
}

async function encryptedTransfer(secret: Uint8Array, events: Readonly<Record<string, string>>) {
  const digest = await crypto.subtle.digest('SHA-256', secret);
  const key = await crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(events));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
  return { iv, ciphertext };
}

function transferSubstrate(
  encrypted: Awaited<ReturnType<typeof encryptedTransfer>> | null,
  requested: readonly string[],
  restored: Map<string, string>,
): RecoverySubstrate {
  return {
    async capabilities() { return { kind: 'ready', modes: [mode.id] }; },
    async material() { return encrypted ? { ownerId: alice, id: 'transfer_1', version: mode.version, trusted: true } : null; },
    async restore({ secret }) {
      if (!encrypted) return { kind: 'backup_missing' };
      try {
        const digest = await crypto.subtle.digest('SHA-256', secret);
        const key = await crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['decrypt']);
        const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: encrypted.iv }, key, encrypted.ciphertext);
        const events = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, string>;
        for (const [eventId, body] of Object.entries(events)) restored.set(eventId, body);
        return {
          kind: 'restored',
          history: { restored: requested.filter(id => restored.has(id)).length, unavailable: requested.filter(id => !restored.has(id)).length },
        };
      } catch {
        return { kind: 'secret_rejected' };
      }
    },
  };
}

describe('encrypted recovery integration', () => {
  it('restores a designated pre-loss event and reports unavailable history separately', async () => {
    const secret = new Uint8Array([3, 1, 4, 1, 5, 9]);
    const encrypted = await encryptedTransfer(secret, { event_before_loss: 'ciphertext restored only at endpoint' });
    const target = new Map<string, string>();
    const service = createRecoveryService({
      ownerId: alice, identity: identity(), substrate: transferSubstrate(encrypted, ['event_before_loss', 'event_without_key'], target),
      journal: memoryControlStore(), approvedModes: [mode],
    });

    const result = await service.begin({ operationId: 'recover_1', mode: mode.id }, async () => secret.slice());
    expect(result).toEqual({
      kind: 'ok',
      value: { operationId: 'recover_1', mode: mode.id, state: 'partial', reason: null },
    });
    expect(target.get('event_before_loss')).toBe('ciphertext restored only at endpoint');
    expect(target.has('event_without_key')).toBe(false);
    expect(await service.inspect('recover_1')).toEqual(result);
    expect(decodeRecoveryStatus(result.kind === 'ok' ? result.value : null)).toEqual({ ok: true, value: result.kind === 'ok' ? result.value : null });
  });

  it('keeps all-device loss explicit and never asks for a secret without material', async () => {
    let prompts = 0;
    const service = createRecoveryService({
      ownerId: alice, identity: identity(), substrate: transferSubstrate(null, ['old_event'], new Map()),
      journal: memoryControlStore(), approvedModes: [mode],
    });
    const result = await service.begin({ operationId: 'recover_missing', mode: mode.id }, async () => {
      prompts += 1;
      return new Uint8Array([1]);
    });
    expect(result).toMatchObject({ kind: 'ok', value: { state: 'unrecoverable', reason: 'backup_missing' } });
    expect(prompts).toBe(0);
  });

  it('implements the no-recovery policy without a plaintext or server fallback', async () => {
    let substrateCalls = 0;
    let prompts = 0;
    const sdk = transferSubstrate(null, ['old_event'], new Map());
    const service = createRecoveryService({
      ownerId: alice,
      identity: identity(),
      substrate: {
        ...sdk,
        async material(modeId, options) { substrateCalls += 1; return sdk.material(modeId, options); },
      },
      journal: memoryControlStore(),
      approvedModes: [],
    });
    expect(await service.capabilities()).toEqual({ modes: [], unavailableReason: 'not_configured' });
    expect(await service.begin({ operationId: 'recover_none', mode: mode.id }, async () => {
      prompts += 1;
      return new Uint8Array([1]);
    })).toEqual({ kind: 'rejected', code: 'unsupported_mode' });
    expect({ substrateCalls, prompts }).toEqual({ substrateCalls: 0, prompts: 0 });
  });

  it('rejects a concurrent operation ID reused for another mode', async () => {
    let finish!: () => void;
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    const sdk = transferSubstrate(await encryptedTransfer(new Uint8Array([1]), { event: 'history' }), ['event'], new Map());
    const service = createRecoveryService({
      ownerId: alice,
      identity: identity(),
      substrate: { ...sdk, async restore(input, options) { await waiting; return sdk.restore(input, options); } },
      journal: memoryControlStore(),
      approvedModes: [mode],
    });
    const first = service.begin({ operationId: 'recover_concurrent', mode: mode.id }, async () => new Uint8Array([1]));
    await Promise.resolve();
    expect(await service.begin({ operationId: 'recover_concurrent', mode: 'other-mode' }, async () => new Uint8Array([1])))
      .toEqual({ kind: 'rejected', code: 'operation_mismatch' });
    finish();
    await first;
  });

  it('resumes the same SDK attempt after an uncertain terminal write', async () => {
    const secret = new Uint8Array([8, 6, 7, 5]);
    const encrypted = await encryptedTransfer(secret, { event: 'once' });
    const target = new Map<string, string>();
    const base = transferSubstrate(encrypted, ['event'], target);
    const attempts: number[] = [];
    let imports = 0;
    const cached = new Map<string, Awaited<ReturnType<RecoverySubstrate['restore']>>>();
    const sdk: RecoverySubstrate = {
      ...base,
      async restore(input, options) {
        attempts.push(input.attempt);
        const key = `${input.operationId}:${input.attempt}`;
        const prior = cached.get(key);
        if (prior) return prior;
        imports += 1;
        const result = await base.restore(input, options);
        cached.set(key, result);
        return result;
      },
    };
    let failTerminal = true;
    const store = memoryControlStore(operationId => failTerminal && operationId.includes('.restored.'));
    const create = () => createRecoveryService({
      ownerId: alice, identity: identity(), substrate: sdk, journal: store, approvedModes: [mode],
    });
    expect(await create().begin({ operationId: 'recover_resume', mode: mode.id }, async () => secret.slice()))
      .toEqual({ kind: 'outcome_unknown', operationId: 'recover_resume' });
    failTerminal = false;
    expect(await create().begin({ operationId: 'recover_resume', mode: mode.id }, async () => secret.slice()))
      .toMatchObject({ kind: 'ok', value: { state: 'restored' } });
    expect(attempts).toEqual([1, 1]);
    expect(imports).toBe(1);
    let prompts = 0;
    expect(await create().begin({ operationId: 'recover_resume', mode: mode.id }, async () => {
      prompts += 1;
      return secret.slice();
    })).toMatchObject({ kind: 'ok', value: { state: 'restored' } });
    expect(prompts).toBe(0);
  });

  it('does not reset a material retry budget when the operation ID changes', async () => {
    const wrong = new Uint8Array([0]);
    const encrypted = await encryptedTransfer(new Uint8Array([1]), { event: 'history' });
    const sdk = transferSubstrate(encrypted, ['event'], new Map());
    const store = memoryControlStore();
    const create = () => createRecoveryService({
      ownerId: alice, identity: identity(), substrate: sdk, journal: store, approvedModes: [mode], maxSecretAttempts: 2,
    });
    let prompts = 0;
    const prompt = async () => { prompts += 1; return wrong.slice(); };
    expect(await create().begin({ operationId: 'recover_guess_1', mode: mode.id }, prompt))
      .toMatchObject({ kind: 'ok', value: { state: 'failed', reason: 'secret_rejected' } });
    expect(await create().begin({ operationId: 'recover_guess_2', mode: mode.id }, prompt))
      .toMatchObject({ kind: 'ok', value: { state: 'failed', reason: 'secret_rejected' } });
    expect(prompts).toBe(2);
  });

  it('returns outcome unknown when the caller aborts after intent persistence', async () => {
    const secret = new Uint8Array([1]);
    const encrypted = await encryptedTransfer(secret, { event: 'history' });
    let resolvePrompt!: (value: Uint8Array) => void;
    let promptEntered!: () => void;
    const entered = new Promise<void>(resolve => { promptEntered = resolve; });
    const prompt = new Promise<Uint8Array>(resolve => { resolvePrompt = resolve; });
    let restores = 0;
    const base = transferSubstrate(encrypted, ['event'], new Map());
    const service = createRecoveryService({
      ownerId: alice,
      identity: identity(),
      substrate: { ...base, async restore(input, options) { restores += 1; return base.restore(input, options); } },
      journal: memoryControlStore(),
      approvedModes: [mode],
    });
    const abort = new AbortController();
    const pending = service.begin(
      { operationId: 'recover_abort', mode: mode.id },
      async () => { promptEntered(); return prompt; },
      { signal: abort.signal },
    );
    await entered;
    abort.abort();
    const lateSecret = secret.slice();
    resolvePrompt(lateSecret);
    expect(await pending).toEqual({ kind: 'outcome_unknown', operationId: 'recover_abort' });
    expect([...lateSecret]).toEqual([0]);
    expect(restores).toBe(0);
  });

  it('does nothing when already aborted before intent persistence', async () => {
    const abort = new AbortController();
    abort.abort();
    let prompts = 0;
    let restores = 0;
    const base = transferSubstrate(null, ['event'], new Map());
    const service = createRecoveryService({
      ownerId: alice,
      identity: identity(),
      substrate: { ...base, async restore(input, options) { restores += 1; return base.restore(input, options); } },
      journal: memoryControlStore(),
      approvedModes: [mode],
    });
    expect(await service.begin({ operationId: 'recover_preabort', mode: mode.id }, async () => {
      prompts += 1;
      return new Uint8Array([1]);
    }, { signal: abort.signal })).toEqual({ kind: 'unavailable', retryable: true });
    expect({ prompts, restores }).toEqual({ prompts: 0, restores: 0 });
    expect(await service.inspect('recover_preabort')).toEqual({ kind: 'rejected', code: 'not_found' });
  });

  it('leaves stale binding dispatch rejected and completed releases single-shot', async () => {
    const releases = new Map([['job_completed', { generation: 6, dispatches: 1 }]]);
    const bindings = new Map([['binding_old', { generation: 7, active: true }]]);
    const dispatch = (bindingId: string, generation: number, jobId: string) => {
      const binding = bindings.get(bindingId);
      const release = releases.get(jobId);
      if (!binding?.active || binding.generation !== generation || release) return 'rejected' as const;
      releases.set(jobId, { generation, dispatches: 1 });
      return 'accepted' as const;
    };
    const secret = new Uint8Array([2, 7, 1, 8]);
    const encrypted = await encryptedTransfer(secret, { event_before_loss: 'history' });
    const service = createRecoveryService({
      ownerId: alice, identity: identity(), substrate: transferSubstrate(encrypted, ['event_before_loss'], new Map()),
      journal: memoryControlStore(), approvedModes: [mode],
    });
    // Component composition: recovery supplies crypto only; every later dispatch still crosses
    // the injected generation-keyed ledger rather than inheriting authority from restoration.
    const lifecycle = {
      recover: () => service.begin({ operationId: 'recover_no_replay', mode: mode.id }, async () => secret.slice()),
      dispatch,
    };
    await lifecycle.recover();
    expect(lifecycle.dispatch('binding_old', 6, 'job_old_generation')).toBe('rejected');
    expect(lifecycle.dispatch('binding_old', 7, 'job_completed')).toBe('rejected');
    expect(releases.get('job_completed')).toEqual({ generation: 6, dispatches: 1 });
  });
});
