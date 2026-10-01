import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { unknownModeSupportMap, type SessionBinding } from '@khala/contracts/delivery/index';
import type { CompareAndSetInput, ControlStore, JsonValue } from '@khala/contracts/messaging/index';
import { fakeStore, T0 } from '../../auth/support.test';
import { createControlStore } from '../../runtime/control-store';
import { createLocalBlobStores } from '../../runtime/local-blob-store';
import { createOwnerMailbox, type MailboxSubmitDiagnostic, type OwnerMailboxEntry } from './store';

const binding = {
  v: 1, bindingId: 'binding-mailbox', ownerId: 'owner-mailbox', agentParticipantId: 'agent-mailbox',
  deviceId: 'device-mailbox', harness: 'claude', sessionId: 'existing-session', generation: 2,
} as SessionBinding;
const command = { operationId: 'operation_123456', kind: 'controls_status' as const, body: { bindingId: binding.bindingId } };
const principal = { v: 1, ownerId: binding.ownerId, providerIssuer: 'https://id.example',
  providerSubject: 'owner-subject', verifiedEmail: 'owner@example.test', sessionExpiresAt: new Date(T0 + 60_000).toISOString() } as const;
const authoritySecret = 'mailbox-test-secret-at-least-thirty-two-bytes';

describe('metadata-only owner mailbox', () => {
  it('keeps grant command identity and exact binding in typed outcomes', async () => {
    const state = fakeStore(() => T0);
    const mailbox = createOwnerMailbox({ store: state.store, binding, roomId: '!room:example',
      clock: () => T0, authoritySecret });
    const body = { v: 1, kind: 'grant_experimental_route', commandId: 'grant_command_12345678',
      bindingId: binding.bindingId, expectedBindingGeneration: binding.generation,
      expectedVersion: 1, mode: 'steer', route: 'codex-steer', harnessVersion: '0.154.0',
      evidenceRevision: 'proof-1', issuedAt: '2026-09-27T00:00:00Z' };
    const command = { operationId: body.commandId, kind: 'listening_grant' as const, body };
    expect((await mailbox.submit(command, principal)).kind).toBe('ok');
    expect(await mailbox.complete(command.operationId, { commandId: body.commandId,
      outcome: 'applied', reason: null, view: { bindingId: binding.bindingId,
        generation: binding.generation, requested: 'sync', version: 2,
        experimentalGrants: [{ v: 1, kind: 'experimental_route', bindingId: binding.bindingId,
          generation: binding.generation, mode: body.mode, route: body.route,
          harnessVersion: body.harnessVersion, evidenceRevision: body.evidenceRevision,
          grantRevision: 2 }], hardCancelGrants: [], lastChangedBy: { kind: 'unknown' },
        effective: null, effectiveReason: 'capabilities_unavailable',
        support: unknownModeSupportMap('capabilities-unavailable', 'Capabilities unavailable.') } }))
      .toMatchObject({ kind: 'ok', value: { outcome: { outcome: 'applied' } } });
    expect((await mailbox.submit({ ...command, body: { ...body, bindingId: 'other-binding' } }, principal)).kind)
      .toBe('conflict');
  });
  it('accepts a policy status with an explicit unavailable listening section', async () => {
    const state = fakeStore(() => T0);
    const mailbox = createOwnerMailbox({ store: state.store, binding, roomId: '!room:example',
      clock: () => T0, authoritySecret });
    expect((await mailbox.submit(command, principal)).kind).toBe('ok');
    const status = { v: 1, binding, bindingStatus: 'active', capabilities: null,
      policy: { bindingId: binding.bindingId, generation: binding.generation,
        effectiveVersion: 1, effectiveMode: 'review', paused: false },
      requested: null, busy: false, latestReceipt: null,
      listening: null, listeningUnavailable: 'connector_starting' };
    expect((await mailbox.complete(command.operationId, { ok: true, status })).kind).toBe('ok');
    expect((await mailbox.result(command.operationId))).toMatchObject({ kind: 'ok',
      value: { outcome: { ok: true, status: { policy: { effectiveVersion: 1 },
        listening: null, listeningUnavailable: 'connector_starting' } } } });
  });
  it('distinguishes archive rejection from index CAS contention without discarding a read', async () => {
    const state = fakeStore(() => T0);
    const causes: MailboxSubmitDiagnostic[] = [];
    let failure: 'archive' | 'cas' | null = null;
    const store: ControlStore = { ...state.store, async compareAndSet<T extends JsonValue>(input: CompareAndSetInput<T>) {
      if (failure === 'archive' && input.key.startsWith('owner-mailbox-result.')) return { kind: 'unavailable' };
      if (failure === 'cas' && input.key.startsWith('owner-mailbox.v1.')) return { kind: 'conflict', current: null };
      return state.store.compareAndSet(input);
    } };
    const mailbox = createOwnerMailbox({ store, binding, roomId: '!room:example', clock: () => T0,
      authoritySecret, submitDiagnostic: cause => causes.push(cause) });
    for (let index = 0; index < 8; index++) {
      expect((await mailbox.submit({ ...command, operationId: `bounded_${index.toString().padStart(8, '0')}` }, principal)).kind).toBe('ok');
    }
    failure = 'archive';
    expect(await mailbox.submit({ ...command, operationId: 'bounded_next_read' }, principal)).toEqual({ kind: 'unavailable' });
    expect(causes.at(-1)).toBe('archive_write_unavailable');
    expect((await mailbox.pending()).kind).toBe('ok');
    failure = 'cas';
    expect(await mailbox.submit({ ...command, operationId: 'bounded_cas_read' }, principal)).toEqual({ kind: 'unavailable' });
    expect(causes.at(-1)).toBe('index_cas_exhausted');
    failure = null;
    expect((await mailbox.submit({ ...command, operationId: 'bounded_recovered' }, principal)).kind).toBe('ok');
  });
  // Seeding and migrating two 64-entry mailboxes exercises hundreds of filesystem-backed store operations.
  it('admits a preview after two mixed offline mailboxes fill the local blob store', async () => {
    const directory = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'owner-mailbox-729-'));
    try {
      const blobs = createLocalBlobStores(directory);
      const store = createControlStore({ records: blobs('records'), operations: blobs('operations'), clock: () => T0 });
      for (const owner of ['first', 'second']) {
        const scoped = { ...binding, bindingId: `binding-${owner}` } as SessionBinding;
        const mailbox = createOwnerMailbox({ store, binding: scoped, roomId: '!room:example', clock: () => T0, authoritySecret });
        const body = { bindingId: scoped.bindingId, candidates: [], releaseIds: [] };
        const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32);
        const indexKey = `owner-mailbox.v1.${createHash('sha256').update(`${scoped.bindingId}\0${scoped.generation}`).digest('hex')}`;
        const legacyEntries: OwnerMailboxEntry[] = [];
        for (let index = 0; index < 32; index++) {
          for (const request of [
            { operationId: `status_${owner}_${index.toString().padStart(8, '0')}`,
              kind: 'controls_status' as const, body: { bindingId: scoped.bindingId } },
            { operationId: `preview_${digest}_${index.toString(16).padStart(8, '0')}`,
              kind: 'review_preview' as const, body },
          ]) {
            const admitted = await mailbox.submit(request, principal);
            expect(admitted.kind).toBe('ok');
            if (admitted.kind !== 'ok') throw new Error('cannot seed legacy entry');
            legacyEntries.push(admitted.value);
            const current = await store.read<JsonValue>(indexKey);
            if (current.kind !== 'record') throw new Error('missing mailbox index');
            const document = current.record.value as Record<string, JsonValue>;
            expect((await store.compareAndSet({ key: indexKey, expectedRevision: current.record.revision,
              operationId: `legacy-clear-${owner}-${legacyEntries.length}`, next: {
                value: { ...document, entries: [] } as JsonValue, expiresAt: current.record.expiresAt,
              } })).kind).toBe('applied');
          }
        }
        const empty = await store.read<JsonValue>(indexKey);
        if (empty.kind !== 'record') throw new Error('missing empty mailbox index');
        const document = empty.record.value as Record<string, JsonValue>;
        expect((await store.compareAndSet({ key: indexKey, expectedRevision: empty.record.revision,
          operationId: `legacy-seed-${owner}`, next: {
            value: { ...document, entries: legacyEntries } as JsonValue, expiresAt: empty.record.expiresAt,
          } })).kind).toBe('applied');
        const legacy = await mailbox.pending();
        expect(legacy.kind).toBe('ok');
        if (legacy.kind !== 'ok') throw new Error('legacy mailbox unavailable');
        expect(legacy.value).toHaveLength(64);
        expect(legacy.value.filter(entry => entry.kind === 'controls_status')).toHaveLength(32);
        expect(legacy.value.filter(entry => entry.kind === 'review_preview')).toHaveLength(32);
        const firstReload = { operationId: `preview_${digest}_00000020`, kind: 'review_preview' as const, body };
        expect((await mailbox.submit(firstReload, principal)).kind).toBe('ok');
        expect(await mailbox.result(legacyEntries[1]!.operationId)).toMatchObject({ kind: 'ok',
          value: { outcome: { ok: false, code: 'unavailable' } } });
        const migrated = await mailbox.pending();
        expect(migrated.kind).toBe('ok');
        if (migrated.kind !== 'ok') throw new Error('migrated mailbox unavailable');
        expect(migrated.value).toHaveLength(63);
        expect(migrated.value.some(entry => entry.operationId === firstReload.operationId)).toBe(true);
        const reloads = await Promise.all(Array.from({ length: 16 }, (_, index) => mailbox.submit({
          operationId: `preview_${digest}_${(index + 33).toString(16).padStart(8, '0')}`,
          kind: 'review_preview', body,
        }, principal)));
        expect(reloads.map(result => result.kind)).toEqual(Array(16).fill('ok'));
        const pending = await mailbox.pending();
        expect(pending.kind).toBe('ok');
        if (pending.kind !== 'ok') throw new Error('pending mailbox unavailable');
        const newestId = [...pending.value].reverse().find(entry => entry.kind === 'review_preview')?.operationId;
        if (!newestId) throw new Error('missing resumed preview');
        const ref = { v: 1, roomId: '!room:example', eventId: 'event_1', authorParticipantId: 'peer_agent',
          authorDeviceId: 'peer_device', contentDigest: `sha256:${'a'.repeat(64)}` };
        const preview = { v: 1, bindingId: scoped.bindingId, bindingGeneration: 2, policyVersion: 3,
          pending: [ref], receipts: [] };
        expect((await mailbox.complete(newestId, { ok: true, preview })).kind).toBe('ok');
        const approvalId = `approval_${owner}_0001`;
        const approval = { operationId: approvalId, kind: 'review_approve' as const,
          body: { v: 1, commandId: approvalId, bindingId: scoped.bindingId, roomId: '!room:example',
            expectedPolicyVersion: 3, expectedBindingGeneration: 2, issuedAt: new Date(T0).toISOString(), selection: [ref] } };
        const resumed = createOwnerMailbox({ store, binding: scoped, roomId: '!room:example', clock: () => T0, authoritySecret });
        expect((await resumed.submit(approval, principal)).kind).toBe('ok');
        expect((await resumed.complete(approvalId, { ok: true, releaseIds: ['release_12345678'] })).kind).toBe('ok');
        expect(await resumed.submit(approval, principal)).toMatchObject({ kind: 'ok', value: { outcome: { ok: true,
          releaseIds: ['release_12345678'] } } });
        expect(await resumed.complete(approvalId, { ok: true, releaseIds: ['release_other'] })).toEqual({ kind: 'conflict' });
        expect((await resumed.complete(newestId, { ok: true, preview })).kind).toBe('ok');
        expect(await resumed.lastReviewPreview()).toMatchObject({ kind: 'ok', value: { pending: [] } });
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 20_000);
  it('keeps a verified review snapshot and one exact queued release across connector downtime', async () => {
    const state = fakeStore(() => T0);
    const mailbox = createOwnerMailbox({ store: state.store, binding, roomId: '!room:example', clock: () => T0, authoritySecret });
    const previewBody = { bindingId: binding.bindingId, candidates: [], releaseIds: [] };
    const digest = createHash('sha256').update(JSON.stringify(previewBody)).digest('hex').slice(0, 32);
    const previewId = `preview_${digest}_00000001`;
    const snapshot = { v: 1, bindingId: binding.bindingId, bindingGeneration: 2, policyVersion: 3,
      pending: [{ v: 1, roomId: '!room:example', eventId: 'event_1', authorParticipantId: 'peer_agent',
        authorDeviceId: 'peer_device', contentDigest: `sha256:${'a'.repeat(64)}` }], receipts: [] };
    expect((await mailbox.submit({ operationId: previewId, kind: 'review_preview', body: previewBody }, principal)).kind).toBe('ok');
    expect((await mailbox.complete(previewId, { ok: true, preview: snapshot })).kind).toBe('ok');
    const resumed = createOwnerMailbox({ store: state.store, binding, roomId: '!room:example', clock: () => T0, authoritySecret });
    expect(await resumed.lastReviewPreview()).toEqual({ kind: 'ok', value: snapshot });
    const approvalId = 'approval_offline_001';
    const approval = { operationId: approvalId, kind: 'review_approve' as const,
      body: { v: 1, commandId: approvalId, bindingId: binding.bindingId, roomId: '!room:example',
        expectedPolicyVersion: 3, expectedBindingGeneration: 2, issuedAt: new Date(T0).toISOString(),
        selection: snapshot.pending } };
    expect((await resumed.submit(approval, principal)).kind).toBe('ok');
    expect((await resumed.submit(approval, principal)).kind).toBe('ok');
    expect(await resumed.pending()).toMatchObject({ kind: 'ok', value: [{ operationId: approvalId }] });
    expect((await resumed.complete(approvalId, { ok: true, releaseIds: ['release_12345678'] })).kind).toBe('ok');
    expect(await resumed.pending()).toEqual({ kind: 'ok', value: [] });
    expect(await resumed.lastReviewPreview()).toMatchObject({ kind: 'ok', value: { pending: [] } });
    expect(await resumed.result(approvalId)).toMatchObject({ kind: 'ok', value: { outcome: { ok: true,
      releaseIds: ['release_12345678'] } } });
    expect((await resumed.complete(approvalId, { ok: true, releaseIds: ['release_other'] })).kind).toBe('conflict');
  });
  it('leaves preview completion pollable when its durable snapshot write fails', async () => {
    const state = fakeStore(() => T0);
    let failSnapshot = true;
    const store: ControlStore = { ...state.store, async compareAndSet<T extends JsonValue>(input: CompareAndSetInput<T>) {
      if (failSnapshot && input.key.startsWith('owner-review-preview.')) return { kind: 'unavailable' };
      return state.store.compareAndSet(input);
    } };
    const mailbox = createOwnerMailbox({ store, binding, roomId: '!room:example', clock: () => T0, authoritySecret });
    const body = { bindingId: binding.bindingId, candidates: [], releaseIds: [] };
    const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32);
    const operationId = `preview_${digest}_00000001`;
    const preview = { v: 1, bindingId: binding.bindingId, bindingGeneration: 2, policyVersion: 3,
      pending: [], receipts: [] };
    expect((await mailbox.submit({ operationId, kind: 'review_preview', body }, principal)).kind).toBe('ok');
    expect((await mailbox.complete(operationId, { ok: true, preview })).kind).toBe('unavailable');
    expect(await mailbox.pending()).toEqual({ kind: 'unavailable' });
    failSnapshot = false;
    expect(await mailbox.pending()).toEqual({ kind: 'ok', value: [] });
    expect((await mailbox.complete(operationId, { ok: true, preview })).kind).toBe('ok');
    expect(await mailbox.pending()).toEqual({ kind: 'ok', value: [] });
    expect(await mailbox.lastReviewPreview()).toEqual({ kind: 'ok', value: preview });
  });
  it('keeps the later verified preview when two reads share one clock tick', async () => {
    const state = fakeStore(() => T0);
    const mailbox = createOwnerMailbox({ store: state.store, binding, roomId: '!room:example', clock: () => T0, authoritySecret });
    const body = { bindingId: binding.bindingId, candidates: [], releaseIds: [] };
    const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32);
    const preview = { v: 1, bindingId: binding.bindingId, bindingGeneration: 2, policyVersion: 3,
      pending: [], receipts: [] };
    for (let index = 1; index <= 2; index++) {
      const operationId = `preview_${digest}_${index.toString(16).padStart(8, '0')}`;
      expect((await mailbox.submit({ operationId, kind: 'review_preview', body }, principal)).kind).toBe('ok');
      expect((await mailbox.complete(operationId, { ok: true, preview: { ...preview, policyVersion: index } })).kind).toBe('ok');
    }
    expect(await mailbox.lastReviewPreview()).toMatchObject({ kind: 'ok', value: { policyVersion: 2 } });
  });
  it('does not settle pending refs from a losing concurrent approval completion', async () => {
    const state = fakeStore(() => T0);
    const ref = { v: 1, roomId: '!room:example', eventId: 'event_1', authorParticipantId: 'peer_agent',
      authorDeviceId: 'peer_device', contentDigest: `sha256:${'a'.repeat(64)}` };
    let releaseArchive!: () => void;
    let archiveStarted!: () => void;
    const held = new Promise<void>(resolve => { releaseArchive = resolve; });
    const entered = new Promise<void>(resolve => { archiveStarted = resolve; });
    const store: ControlStore = { ...state.store, async compareAndSet<T extends JsonValue>(input: CompareAndSetInput<T>) {
      const value = input.next.value as { outcome?: { ok?: boolean }; operationId?: string };
      if (input.key.startsWith('owner-mailbox-result.') && value.operationId === 'racing_approval_01'
        && value.outcome?.ok === true) { archiveStarted(); await held; }
      return state.store.compareAndSet(input);
    } };
    const mailbox = createOwnerMailbox({ store, binding, roomId: '!room:example', clock: () => T0, authoritySecret });
    const previewBody = { bindingId: binding.bindingId, candidates: [ref], releaseIds: [] };
    const digest = createHash('sha256').update(JSON.stringify(previewBody)).digest('hex').slice(0, 32);
    const previewId = `preview_${digest}_00000001`;
    expect((await mailbox.submit({ operationId: previewId, kind: 'review_preview', body: previewBody }, principal)).kind).toBe('ok');
    expect((await mailbox.complete(previewId, { ok: true, preview: { v: 1, bindingId: binding.bindingId,
      bindingGeneration: 2, policyVersion: 3, pending: [ref], receipts: [] } })).kind).toBe('ok');
    const operationId = 'racing_approval_01';
    expect((await mailbox.submit({ operationId, kind: 'review_approve', body: { v: 1, commandId: operationId,
      bindingId: binding.bindingId, roomId: '!room:example', expectedPolicyVersion: 3,
      expectedBindingGeneration: 2, issuedAt: new Date(T0).toISOString(), selection: [ref] } }, principal)).kind).toBe('ok');
    const losing = mailbox.complete(operationId, { ok: true, releaseIds: ['release_12345678'] });
    await entered;
    expect((await mailbox.complete(operationId, { ok: false, code: 'forbidden' })).kind).toBe('ok');
    releaseArchive();
    expect((await losing).kind).toBe('conflict');
    expect(await mailbox.lastReviewPreview()).toMatchObject({ kind: 'ok', value: { pending: [ref] } });
  });
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
  it('reserves one Stop slot while ordinary commands remain pending', async () => {
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
    expect(pending.value).toHaveLength(9);
    expect(pending.value.map(entry => entry.operationId)).not.toContain('pending_00000000');
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
    expect(pending.value).toHaveLength(9);
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
    for (let i = 0; i < 8; i++) {
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
