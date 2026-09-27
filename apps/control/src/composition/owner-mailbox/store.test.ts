import { describe, expect, it } from 'vitest';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import { fakeStore, T0 } from '../../auth/support.test';
import { createOwnerMailbox } from './store';

const binding = {
  v: 1, bindingId: 'binding-mailbox', ownerId: 'owner-mailbox', agentParticipantId: 'agent-mailbox',
  deviceId: 'device-mailbox', harness: 'claude', sessionId: 'existing-session', generation: 2,
} as SessionBinding;
const command = { operationId: 'operation_123456', kind: 'controls_status' as const, body: { bindingId: binding.bindingId } };
const principal = { v: 1, ownerId: binding.ownerId, providerIssuer: 'https://id.example',
  providerSubject: 'owner-subject', verifiedEmail: 'owner@example.test', sessionExpiresAt: new Date(T0 + 60_000).toISOString() } as const;
const authoritySecret = 'mailbox-test-secret-at-least-thirty-two-bytes';

describe('metadata-only owner mailbox', () => {
  it('keeps one exact command/result under CAS and refuses changed retries and stale generations', async () => {
    const state = fakeStore(() => T0);
    const mailbox = createOwnerMailbox({ store: state.store, binding, roomId: '!room:example', clock: () => T0, authoritySecret });
    expect(await mailbox.submit(command, principal)).toMatchObject({ kind: 'ok', value: { outcome: null } });
    expect(await mailbox.submit(command, principal)).toMatchObject({ kind: 'ok', value: { operationId: command.operationId } });
    expect(await mailbox.submit({ ...command, body: { bindingId: 'other-binding' } }, principal)).toEqual({ kind: 'conflict' });
    expect(await mailbox.pending()).toMatchObject({ kind: 'ok', value: [{ operationId: command.operationId }] });
    const outcome = { ok: false, code: 'forbidden' };
    expect(await mailbox.complete(command.operationId, outcome)).toMatchObject({ kind: 'ok', value: { outcome } });
    expect(await mailbox.complete(command.operationId, outcome)).toMatchObject({ kind: 'ok', value: { outcome } });
    expect(await mailbox.complete(command.operationId, { ok: true })).toEqual({ kind: 'conflict' });
    expect(await mailbox.pending()).toEqual({ kind: 'ok', value: [] });
    expect(await mailbox.result(command.operationId)).toMatchObject({ kind: 'ok', value: { outcome } });
    const nextGeneration = createOwnerMailbox({ store: state.store, binding: { ...binding, generation: 3 }, roomId: '!room:example', clock: () => T0, authoritySecret });
    expect(await nextGeneration.pending()).toEqual({ kind: 'ok', value: [] });
  });

  it('rejects plaintext and authority injection before writing anything', async () => {
    const state = fakeStore(() => T0);
    const mailbox = createOwnerMailbox({ store: state.store, binding, roomId: '!room:example', clock: () => T0, authoritySecret });
    for (const body of [
      { bindingId: binding.bindingId, body: 'secret plaintext' },
      { bindingId: binding.bindingId, ownerId: binding.ownerId },
      { bindingId: 'other-binding' },
    ]) {
      expect(await mailbox.submit({ ...command, body }, principal)).toEqual({ kind: 'conflict' });
    }
    expect(state.records.size).toBe(0);
  });

  it('rejects plaintext and untyped results even from an authorized agent', async () => {
    const state = fakeStore(() => T0);
    const mailbox = createOwnerMailbox({ store: state.store, binding, roomId: '!room:example', clock: () => T0, authoritySecret });
    expect((await mailbox.submit(command, principal)).kind).toBe('ok');
    expect(await mailbox.complete(command.operationId, { ok: true, body: 'pending secret' }))
      .toEqual({ kind: 'conflict' });
    expect(await mailbox.complete(command.operationId, { ok: false, code: 'forbidden', body: 'pending secret' }))
      .toEqual({ kind: 'conflict' });
    expect(await mailbox.pending()).toMatchObject({ kind: 'ok', value: [{ outcome: null }] });
  });

  it('preserves a lost write as unknown until the same command is observed', async () => {
    const state = fakeStore(() => T0);
    const mailbox = createOwnerMailbox({ store: state.store, binding, roomId: '!room:example', clock: () => T0, authoritySecret });
    state.inject('compareAndSet', 'lose_response');
    expect(await mailbox.submit(command, principal)).toEqual({ kind: 'unavailable' });
    expect(await mailbox.submit(command, principal)).toMatchObject({ kind: 'ok', value: { operationId: command.operationId } });
  });

  it('refuses a forged authority capsule in the backing store', async () => {
    const state = fakeStore(() => T0);
    const mailbox = createOwnerMailbox({ store: state.store, binding, roomId: '!room:example', clock: () => T0, authoritySecret });
    expect((await mailbox.submit(command, principal)).kind).toBe('ok');
    const key = state.keys('owner-mailbox.v1.')[0]!;
    const record = state.records.get(key)!;
    const value = structuredClone(record.value) as { entries: Array<{ authority: { subject: string } }> };
    value.entries[0]!.authority.subject = 'forged-subject';
    state.records.set(key, { ...record, value });
    expect(await mailbox.pending()).toEqual({ kind: 'unavailable' });
  });
});
