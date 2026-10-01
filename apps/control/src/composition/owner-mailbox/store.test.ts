import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { CompareAndSetInput, ControlStore, JsonValue } from '@khala/contracts/messaging/index';
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
  it('does not redeliver archived commands when index retirement fails and recovers full capacity', async () => {
    const state = fakeStore(() => T0);
    let holdRetirement = true;
    const store: ControlStore = {
      read: state.store.read,
      resolve: state.store.resolve,
      async compareAndSet<T extends JsonValue>(input: CompareAndSetInput<T>) {
        const current = state.records.get(input.key)?.value as { entries?: unknown[] } | undefined;
        const next = input.next.value as { entries?: unknown[] };
        if (holdRetirement && input.key.startsWith('owner-mailbox.v1.')
          && current?.entries && next.entries && next.entries.length < current.entries.length) {
          return { kind: 'unavailable' as const };
        }
        return state.store.compareAndSet<T>(input);
      },
    };
    const mailbox = createOwnerMailbox({ store, binding, roomId: '!room:example', clock: () => T0, authoritySecret });
    const first = { ...command, operationId: 'status_archive_0000' };
    for (let index = 0; index < 64; index++) {
      const current = { ...command, operationId: `status_archive_${index.toString().padStart(4, '0')}` };
      expect((await mailbox.submit(current, principal)).kind).toBe('ok');
      expect((await mailbox.complete(current.operationId, { ok: false, code: 'forbidden' })).kind).toBe('ok');
    }
    expect(await mailbox.pending()).toEqual({ kind: 'ok', value: [] });
    expect(await mailbox.result(first.operationId)).toMatchObject({ kind: 'ok', value: { outcome: { ok: false,
      code: 'forbidden' } } });
    expect(await mailbox.submit({ ...first, body: { bindingId: 'other-binding' } }, principal)).toEqual({ kind: 'conflict' });
    holdRetirement = false;
    expect((await mailbox.submit({ ...command, operationId: 'status_after_recovery' }, principal)).kind).toBe('ok');
    expect(await mailbox.pending()).toMatchObject({ kind: 'ok', value: [{ operationId: 'status_after_recovery' }] });
    expect(await mailbox.submit(first, principal)).toMatchObject({ kind: 'ok', value: { outcome: { ok: false,
      code: 'forbidden' } } });
  });
  it('keeps exact results after more than 64 sequential approvals without exhausting the poll index', async () => {
    const state = fakeStore(() => T0);
    const mailbox = createOwnerMailbox({ store: state.store, binding, roomId: '!room:example', clock: () => T0, authoritySecret });
    const makeApproval = (index: number) => {
      const operationId = `approval_${index.toString().padStart(8, '0')}`;
      return { operationId, kind: 'review_approve' as const,
        body: { v: 1, commandId: operationId, bindingId: binding.bindingId, roomId: '!room:example',
          expectedPolicyVersion: 3, expectedBindingGeneration: 2, issuedAt: new Date(T0).toISOString(),
          selection: [{ v: 1, roomId: '!room:example', eventId: 'event_1', authorParticipantId: 'peer_agent',
            authorDeviceId: 'peer_device', contentDigest: `sha256:${'a'.repeat(64)}` }] } };
    };
    for (let index = 0; index < 72; index++) {
      const approval = makeApproval(index);
      expect((await mailbox.submit(approval, principal)).kind).toBe('ok');
      expect(await mailbox.complete(approval.operationId, { ok: true, releaseIds: ['release_12345678'] }))
        .toMatchObject({ kind: 'ok', value: { outcome: { ok: true, releaseIds: ['release_12345678'] } } });
    }
    const first = makeApproval(0);
    expect(await mailbox.pending()).toEqual({ kind: 'ok', value: [] });
    expect(await mailbox.submit(first, principal)).toMatchObject({ kind: 'ok', value: { operationId: first.operationId,
      outcome: { ok: true, releaseIds: ['release_12345678'] } } });
    expect(await mailbox.submit({ ...first, body: { ...first.body, expectedPolicyVersion: 4 } }, principal))
      .toEqual({ kind: 'conflict' });
    expect(await mailbox.complete(first.operationId, { ok: true, releaseIds: ['release_different'] }))
      .toEqual({ kind: 'conflict' });
    expect(await mailbox.result(first.operationId)).toMatchObject({ kind: 'ok', value: { outcome: { ok: true,
      releaseIds: ['release_12345678'] } } });
  });
  it('compacts completed preview reads while preserving unresolved reads and exact approval/control outcomes', async () => {
    const state = fakeStore(() => T0);
    const mailbox = createOwnerMailbox({ store: state.store, binding, roomId: '!room:example', clock: () => T0, authoritySecret });
    const previewBody = { bindingId: binding.bindingId, candidates: [], releaseIds: [] };
    const digest = createHash('sha256').update(JSON.stringify(previewBody)).digest('hex').slice(0, 32);
    const preview = (index: number) => ({ operationId: `preview_${digest}_${index.toString(16).padStart(8, '0')}`,
      kind: 'review_preview' as const, body: previewBody });
    const controlled = { ...command, operationId: 'status_durable_0001' };
    expect((await mailbox.submit(controlled, principal)).kind).toBe('ok');
    expect((await mailbox.complete(controlled.operationId, { ok: false, code: 'forbidden' })).kind).toBe('ok');
    expect((await mailbox.submit(preview(0), principal)).kind).toBe('ok'); // unresolved
    for (let index = 1; index < 64; index++) {
      const observation = preview(index);
      expect((await mailbox.submit(observation, principal)).kind).toBe('ok');
      expect((await mailbox.complete(observation.operationId, { ok: false, code: 'forbidden' })).kind).toBe('ok');
    }
    const approval = { operationId: 'approve_durable_0001', kind: 'review_approve' as const,
      body: { v: 1, commandId: 'approve_durable_0001', bindingId: binding.bindingId, roomId: '!room:example',
        expectedPolicyVersion: 3, expectedBindingGeneration: 2, issuedAt: new Date(T0).toISOString(),
        selection: [{ v: 1, roomId: '!room:example', eventId: 'event_1', authorParticipantId: 'peer_agent',
          authorDeviceId: 'peer_device', contentDigest: `sha256:${'a'.repeat(64)}` }] } };
    expect((await mailbox.submit(approval, principal)).kind).toBe('ok');
    expect((await mailbox.complete(approval.operationId, { ok: true, releaseIds: ['release_12345678'] })).kind).toBe('ok');
    expect(await mailbox.result(controlled.operationId)).toMatchObject({ kind: 'ok', value: { outcome: { ok: false, code: 'forbidden' } } });
    expect(await mailbox.result(approval.operationId)).toMatchObject({ kind: 'ok', value: { outcome: { ok: true, releaseIds: ['release_12345678'] } } });
    expect(await mailbox.result(preview(0).operationId)).toMatchObject({ kind: 'ok', value: { outcome: null } });
    expect((await mailbox.submit(preview(1), principal)).kind).toBe('ok'); // read-only replay may be recomputed
    expect(await mailbox.submit({ ...preview(1), body: { ...previewBody, releaseIds: ['release_other'] } }, principal))
      .toEqual({ kind: 'conflict' });
  });
  it('reserves one Stop slot while 64 ordinary commands remain pending', async () => {
    const state = fakeStore(() => T0);
    const mailbox = createOwnerMailbox({ store: state.store, binding, roomId: '!room:example', clock: () => T0, authoritySecret });
    for (let i = 0; i < 64; i++) {
      expect((await mailbox.submit({ ...command, operationId: `pending_${i.toString().padStart(8, '0')}` }, principal)).kind).toBe('ok');
    }
    const stop = { operationId: 'close_operation_one', kind: 'channel_stop' as const,
      body: { operationId: 'close_operation_one', ownerId: binding.ownerId, roomId: '!room:example', expectedRoomRevision: 0 } };
    expect((await mailbox.submit(stop, principal)).kind).toBe('ok');
    expect((await mailbox.submit(stop, principal)).kind).toBe('ok');
    const pending = await mailbox.pending();
    expect(pending.kind).toBe('ok');
    if (pending.kind !== 'ok') throw new Error('pending mailbox unavailable');
    expect(pending.value).toHaveLength(65);
    expect(pending.value.map(entry => entry.operationId)).toContain('pending_00000000');
    expect(pending.value.map(entry => entry.operationId)).toContain('pending_00000063');
    expect(pending.value.map(entry => entry.operationId)).toContain(stop.operationId);
    expect(await mailbox.submit({ ...stop, operationId: 'another_stop_0001',
      body: { ...stop.body, operationId: 'another_stop_0001' } }, principal)).toEqual({ kind: 'capacity' });
  });

  it('archives displaced offline reads before admitting reads and writes', async () => {
    const state = fakeStore(() => T0);
    const mailbox = createOwnerMailbox({ store: state.store, binding, roomId: '!room:example', clock: () => T0, authoritySecret });
    for (let i = 0; i < 64; i++) {
      expect((await mailbox.submit({ ...command, operationId: `offline_${i.toString().padStart(8, '0')}` }, principal)).kind).toBe('ok');
    }
    expect((await mailbox.submit({ ...command, operationId: 'offline_new_read' }, principal)).kind).toBe('ok');
    const approvalId = 'offline_approval_01';
    const approval = { operationId: approvalId, kind: 'review_approve' as const,
      body: { v: 1, commandId: approvalId, bindingId: binding.bindingId, roomId: '!room:example',
        expectedPolicyVersion: 3, expectedBindingGeneration: 2, issuedAt: new Date(T0).toISOString(),
        selection: [{ v: 1, roomId: '!room:example', eventId: 'event_1', authorParticipantId: 'peer_agent',
          authorDeviceId: 'peer_device', contentDigest: `sha256:${'a'.repeat(64)}` }] } };
    expect((await mailbox.submit(approval, principal)).kind).toBe('ok');
    const restarted = createOwnerMailbox({ store: state.store, binding, roomId: '!room:example', clock: () => T0, authoritySecret });
    for (let i = 0; i < 2; i++) {
      const old = { ...command, operationId: `offline_${i.toString().padStart(8, '0')}` };
      expect(await restarted.result(old.operationId)).toMatchObject({ kind: 'ok', value: { outcome: { ok: false, code: 'unavailable' } } });
      expect(await restarted.submit(old, principal)).toMatchObject({ kind: 'ok', value: { outcome: { ok: false, code: 'unavailable' } } });
      expect(await restarted.complete(old.operationId, { ok: false, code: 'forbidden' })).toEqual({ kind: 'conflict' });
    }
    const pending = await restarted.pending();
    expect(pending.kind).toBe('ok');
    if (pending.kind !== 'ok') throw new Error('pending mailbox unavailable');
    expect(pending.value).toHaveLength(64);
    expect(pending.value.at(-1)?.operationId).toBe(approvalId);
    expect(pending.value.filter(item => item.kind === 'review_approve')).toHaveLength(1);
  });

  it('lets only one terminal result win a compaction and completion race', async () => {
    const state = fakeStore(() => T0);
    let releaseArchive!: () => void;
    let archiveStarted!: () => void;
    const held = new Promise<void>(resolve => { releaseArchive = resolve; });
    const entered = new Promise<void>(resolve => { archiveStarted = resolve; });
    const store: ControlStore = { ...state.store, async compareAndSet<T extends JsonValue>(input: CompareAndSetInput<T>) {
      const value = input.next.value as { operationId?: string; outcome?: { code?: string } };
      if (input.key.startsWith('owner-mailbox-result.') && value.operationId === 'race_00000000'
        && value.outcome?.code === 'unavailable') {
        archiveStarted();
        await held;
      }
      return state.store.compareAndSet(input);
    } };
    const mailbox = createOwnerMailbox({ store, binding, roomId: '!room:example', clock: () => T0, authoritySecret });
    for (let i = 0; i < 64; i++) {
      expect((await mailbox.submit({ ...command, operationId: `race_${i.toString().padStart(8, '0')}` }, principal)).kind).toBe('ok');
    }
    const admission = mailbox.submit({ ...command, operationId: 'race_new_read_01' }, principal);
    await entered;
    const completed = await mailbox.complete('race_00000000', { ok: false, code: 'forbidden' });
    releaseArchive();
    const admitted = await admission;
    expect(admitted.kind).toBe('ok');
    const result = await mailbox.result('race_00000000');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok' || !result.value) throw new Error('missing terminal result');
    expect(result.value.outcome).toEqual({ ok: false, code: 'forbidden' });
    expect(completed).toMatchObject({ kind: 'ok', value: { outcome: { ok: false, code: 'forbidden' } } });
    expect((await mailbox.pending()).kind).toBe('ok');
  });

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

  it('accepts only an exact binding stop receipt for the queued closure', async () => {
    const state = fakeStore(() => T0);
    const mailbox = createOwnerMailbox({ store: state.store, binding, roomId: '!room:example', clock: () => T0, authoritySecret });
    const stop = { operationId: 'close_operation_one', kind: 'channel_stop' as const,
      body: { operationId: 'close_operation_one', ownerId: binding.ownerId, roomId: '!room:example', expectedRoomRevision: 0 } };
    expect((await mailbox.submit(stop, principal)).kind).toBe('ok');
    const receipt = { ...stop.body, bindingId: binding.bindingId, bindingGeneration: binding.generation,
      state: 'stopped', cleanupRequested: true };
    expect(await mailbox.complete(stop.operationId, { kind: 'stopped', receipt: { ...receipt, bindingId: 'other-binding' } }))
      .toEqual({ kind: 'conflict' });
    expect(await mailbox.complete(stop.operationId, { kind: 'stopped', receipt: { ...receipt, operationId: 'other_operation' } }))
      .toEqual({ kind: 'conflict' });
    expect((await mailbox.complete(stop.operationId, { kind: 'stopped', receipt })).kind).toBe('ok');
  });
});
