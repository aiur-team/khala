import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalCommand } from '@khala/contracts/delivery/index';
import type { ReviewPreviewRequest } from './browser-port';
import { createOwnerMailboxReviewClient } from './owner-mailbox-client';

const ORIGIN = 'https://khala.example';
const command = { v: 1, commandId: 'command_12345678', bindingId: 'binding_12345678',
  roomId: '!room:example', expectedPolicyVersion: 3, expectedBindingGeneration: 2,
  selection: [{ v: 1, roomId: '!room:example', eventId: '$event', authorParticipantId: 'other-agent',
    authorDeviceId: 'device-2', contentDigest: `sha256:${'a'.repeat(64)}` }],
  issuedAt: '2026-09-16T20:00:00Z' } as unknown as ApprovalCommand;
const json = (status: number, value: unknown) => new Response(JSON.stringify(value),
  { status, headers: { 'content-type': 'application/json' } });

describe('authenticated owner mailbox review client', () => {
  beforeEach(() => { if (typeof globalThis.sessionStorage !== 'undefined') globalThis.sessionStorage.clear(); });
  it('types an offline binding with no prior preview as waiting, not a store failure', async () => {
    const fetcher: typeof fetch = async (url, init) => {
      if (String(url).includes('/review-status?')) return json(200, { v: 1, bindingId: command.bindingId,
        generation: 2, status: 'waiting_for_agent', preview: null });
      const operationId = String(url).endsWith('/submit')
        ? (JSON.parse(String(init?.body)) as { operationId: string }).operationId
        : new URL(String(url)).searchParams.get('operation_id');
      return json(200, { v: 1, operationId, outcome: null });
    };
    const client = createOwnerMailboxReviewClient({ origin: ORIGIN, csrf: async () => 'csrf-value', fetch: fetcher, waitMs: 0 });
    expect(await client.review.preview({ bindingId: command.bindingId, candidates: [], releaseIds: [] },
      new AbortController().signal)).toEqual({ kind: 'waiting_for_agent', generation: 2, body: null });
  });
  it('keeps known pending metadata usable offline and reconciles one release identity', async () => {
    const snapshot = { v: 1, bindingId: command.bindingId, bindingGeneration: 2, policyVersion: 3,
      pending: command.selection, receipts: [] };
    let complete = false;
    let writes = 0;
    const fetcher: typeof fetch = async (url, init) => {
      if (String(url).includes('/review-status?')) return json(200, { v: 1, bindingId: command.bindingId,
        generation: 2, status: 'waiting_for_agent', preview: snapshot });
      if (String(url).endsWith('/submit')) {
        const body = JSON.parse(String(init?.body)) as { operationId: string; kind: string };
        if (body.kind === 'review_approve') writes += 1;
        return json(200, { v: 1, operationId: body.operationId, outcome: null });
      }
      const operationId = new URL(String(url)).searchParams.get('operation_id');
      return json(200, { v: 1, operationId, outcome: complete ? { ok: true, releaseIds: ['release_12345678'] } : null });
    };
    const client = createOwnerMailboxReviewClient({ origin: ORIGIN, csrf: async () => 'csrf-value', fetch: fetcher, waitMs: 0 });
    expect(await client.review.preview({ bindingId: command.bindingId, candidates: command.selection, releaseIds: [] },
      new AbortController().signal)).toEqual({ kind: 'waiting_for_agent', generation: 2, body: snapshot });
    expect(await client.review.preview({ bindingId: command.bindingId, candidates: [], releaseIds: [] },
      new AbortController().signal)).toEqual({ kind: 'waiting_for_agent', generation: 2, body: snapshot });
    expect(await client.review.approve(command)).toEqual({ kind: 'waiting_for_agent' });
    expect(await client.review.reconcile(command)).toEqual({ kind: 'waiting_for_agent' });
    complete = true;
    expect(await client.review.reconcile(command)).toEqual({ kind: 'answered', body: { ok: true, releaseIds: ['release_12345678'] } });
    expect(writes).toBe(1);
  });
  it('keeps the same preview ID and backoff across a tab reload', async () => {
    let now = 1_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); } };
    const submitted: string[] = [];
    let reads = 0;
    const body: ReviewPreviewRequest = { bindingId: command.bindingId, candidates: [], releaseIds: [] };
    const fetcher: typeof fetch = async (url, init) => {
      if (String(url).includes('/review-status?')) return json(503, { code: 'unavailable' });
      if (String(url).endsWith('/submit')) {
        const operationId = (JSON.parse(String(init?.body)) as { operationId: string }).operationId;
        submitted.push(operationId);
        return json(200, { v: 1, operationId, outcome: null });
      }
      reads += 1;
      return json(200, { v: 1, operationId: new URL(String(url)).searchParams.get('operation_id'),
        outcome: { ok: true, preview: {} } });
    };
    const create = () => createOwnerMailboxReviewClient({ origin: ORIGIN, csrf: async () => 'csrf-value',
      fetch: fetcher, waitMs: 0, storage });
    const signal = new AbortController().signal;
    expect(await create().review.preview(body, signal)).toEqual({ kind: 'refused', code: 'unavailable' });
    expect(await create().review.preview(body, signal)).toEqual({ kind: 'refused', code: 'unavailable' });
    expect(submitted).toHaveLength(1);
    expect(reads).toBe(0);
    now += 15_000;
    expect((await create().review.preview(body, signal)).kind).toBe('ok');
    expect(submitted).toHaveLength(1);
    expect(reads).toBe(1);
    clock.mockRestore();
  });
  it('reuses an unresolved preview operation until completion, then requests a fresh snapshot', async () => {
    let now = 1_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const submitted: string[] = [];
    let reads = 0;
    let complete = false;
    const body: ReviewPreviewRequest = { bindingId: command.bindingId, candidates: [], releaseIds: [] };
    const fetcher: typeof fetch = async (url, init) => {
      if (String(url).includes('/review-status?')) return json(503, { code: 'unavailable' });
      if (String(url).endsWith('/submit')) {
        const operationId = (JSON.parse(String(init?.body)) as { operationId: string }).operationId;
        submitted.push(operationId);
        return json(200, { v: 1, operationId, outcome: complete ? { ok: true, preview: {} } : null });
      }
      const operationId = new URL(String(url)).searchParams.get('operation_id');
      reads += 1;
      return json(200, { v: 1, operationId, outcome: complete ? { ok: true, preview: {} } : null });
    };
    const client = createOwnerMailboxReviewClient({ origin: ORIGIN, csrf: async () => 'csrf-value',
      fetch: fetcher, waitMs: 0 });
    const signal = new AbortController().signal;
    expect(await client.review.preview(body, signal)).toEqual({ kind: 'refused', code: 'unavailable' });
    expect(await client.review.preview({ ...body }, signal)).toEqual({ kind: 'refused', code: 'unavailable' });
    expect(submitted).toHaveLength(1);
    expect(reads).toBe(0);
    complete = true;
    now += 15_000;
    expect((await client.review.preview({ ...body }, signal)).kind).toBe('ok');
    expect((await client.review.preview({ ...body }, signal)).kind).toBe('ok');
    expect(submitted).toHaveLength(2);
    expect(submitted[1]).not.toBe(submitted[0]);
    clock.mockRestore();
  });

  it('retries a missing preview with the same identity and never returns an old-body preview', async () => {
    let now = 1_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const submitted: Array<{ operationId: string; body: unknown }> = [];
    let completed = false;
    const fetcher: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/submit')) {
        const value = JSON.parse(String(init?.body)) as { operationId: string; body: unknown };
        submitted.push(value);
        return json(200, { v: 1, operationId: value.operationId, outcome: null });
      }
      const operationId = new URL(String(url)).searchParams.get('operation_id');
      return completed ? json(200, { v: 1, operationId, outcome: { ok: true, preview: {} } })
        : json(404, { code: 'not_found' });
    };
    const client = createOwnerMailboxReviewClient({ origin: ORIGIN, csrf: async () => 'csrf-value',
      fetch: fetcher, waitMs: 0 });
    const original: ReviewPreviewRequest = { bindingId: command.bindingId, candidates: [], releaseIds: [] };
    const changed: ReviewPreviewRequest = { ...original, releaseIds: ['release_new' as never] };
    const signal = new AbortController().signal;
    expect(await client.review.preview(original, signal)).toEqual({ kind: 'refused', code: 'unavailable' });
    expect(await client.review.preview(changed, signal)).toEqual({ kind: 'refused', code: 'unavailable' });
    expect(submitted).toHaveLength(1);
    now += 15_000;
    expect(await client.review.preview(changed, signal)).toEqual({ kind: 'lost' });
    expect(submitted).toHaveLength(2);
    expect(submitted[1]).toEqual(submitted[0]);
    completed = true;
    now += 30_000;
    expect(await client.review.preview(changed, signal)).toEqual({ kind: 'lost' });
    expect((await client.review.preview(changed, signal)).kind).toBe('refused');
    expect(submitted).toHaveLength(3);
    expect(submitted[2]!.operationId).not.toBe(submitted[0]!.operationId);
    clock.mockRestore();
  });

  it('discovers the exact room binding and submits references with the original command ID', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetcher: typeof fetch = async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      if (String(url).includes('review-bindings')) return json(200, { v: 1, roomId: command.roomId,
        bindings: [{ bindingId: command.bindingId, generation: 2, agentParticipantId: 'agent-1',
          device: { userId: '@agent:example', deviceId: 'AGENT', fingerprint: 'A'.repeat(43) } }] });
      return json(200, { v: 1, operationId: command.commandId,
        outcome: { ok: true, releaseIds: ['release_12345678'] } });
    };
    const client = createOwnerMailboxReviewClient({ origin: ORIGIN, csrf: async () => 'csrf-value', fetch: fetcher });
    expect(await client.bindings(command.roomId, new AbortController().signal)).toEqual([
      { bindingId: command.bindingId, generation: 2, agentParticipantId: 'agent-1',
        device: { userId: '@agent:example', deviceId: 'AGENT', fingerprint: 'A'.repeat(43) } },
    ]);
    expect(await client.review.approve(command)).toEqual({ kind: 'answered', body: { ok: true, releaseIds: ['release_12345678'] } });
    expect(requests[1]?.url).toBe(`${ORIGIN}/api/human/owner-mailbox/submit`);
    expect(requests[1]?.init.credentials).toBe('same-origin');
    const submitted = JSON.parse(String(requests[1]?.init.body)) as Record<string, unknown>;
    expect(submitted).toEqual({ bindingId: command.bindingId, operationId: command.commandId,
      kind: 'review_approve', body: command });
    expect(JSON.stringify(submitted)).not.toContain('authority');
  });

  it('keeps a lost answer unknown and resolves the same command by read only', async () => {
    let submissions = 0;
    const fetcher: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/submit')) {
        submissions += 1;
        expect(JSON.parse(String(init?.body)).operationId).toBe(command.commandId);
        throw new Error('response lost after possible commit');
      }
      if (String(url).includes('/result?')) return json(200, { v: 1, operationId: command.commandId,
        outcome: { ok: true, releaseIds: ['release_12345678'] } });
      throw new Error('unexpected route');
    };
    const client = createOwnerMailboxReviewClient({ origin: ORIGIN, csrf: async () => 'csrf-value', fetch: fetcher });
    expect(await client.review.approve(command)).toEqual({ kind: 'lost' });
    expect(await client.review.reconcile(command)).toEqual({ kind: 'answered', body: { ok: true, releaseIds: ['release_12345678'] } });
    expect(submissions).toBe(1);
  });

  it('does not accept a response for another command or claim refusal after possible write', async () => {
    const wrong: typeof fetch = async () => json(200, { v: 1, operationId: 'other_command',
      outcome: { ok: true, releaseIds: ['release_other'] } });
    const client = createOwnerMailboxReviewClient({ origin: ORIGIN, csrf: async () => 'csrf-value', fetch: wrong });
    expect(await client.review.approve(command)).toEqual({ kind: 'lost' });
    const forbidden = createOwnerMailboxReviewClient({ origin: ORIGIN, csrf: async () => 'csrf-value',
      fetch: async () => json(403, { code: 'forbidden' }) });
    expect(await forbidden.review.approve(command)).toEqual({ kind: 'lost' });
  });

  it('restores the exact unresolved command after reload and only reads its result', async () => {
    const entries = new Map<string, string>();
    const storage = { getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value); },
      removeItem: (key: string) => { entries.delete(key); } };
    let writes = 0;
    const reads: string[] = [];
    const fetcher: typeof fetch = async url => {
      if (String(url).endsWith('/submit')) { writes += 1; throw new Error('answer lost'); }
      if (String(url).includes('/result?')) {
        reads.push(new URL(String(url)).searchParams.get('operation_id') ?? 'missing');
        return json(200, { v: 1, operationId: command.commandId,
          outcome: { ok: true, releaseIds: ['release_12345678'] } });
      }
      throw new Error('unexpected route');
    };
    const options = { origin: ORIGIN, csrf: async () => 'csrf-value', fetch: fetcher, storage };
    const before = createOwnerMailboxReviewClient(options);
    expect(await before.review.approve(command)).toEqual({ kind: 'lost' });
    const after = createOwnerMailboxReviewClient(options);
    expect(after.review.recoverUnknown?.(command.bindingId, command.roomId, command.expectedBindingGeneration)).toEqual(command);
    expect(after.review.recoverUnknown?.(command.bindingId, command.roomId, command.expectedBindingGeneration + 1)).toBeNull();
    expect(await after.review.reconcile(command)).toEqual({ kind: 'answered', body: { ok: true, releaseIds: ['release_12345678'] } });
    const twiceReloaded = createOwnerMailboxReviewClient(options);
    expect(twiceReloaded.review.recoverUnknown?.(command.bindingId, command.roomId, command.expectedBindingGeneration)).toEqual(command);
    expect(await twiceReloaded.review.reconcile(command)).toEqual({ kind: 'answered', body: { ok: true, releaseIds: ['release_12345678'] } });
    expect(await twiceReloaded.review.approve(command)).toEqual({ kind: 'answered', body: { ok: true, releaseIds: ['release_12345678'] } });
    expect(writes).toBe(1);
    expect(reads).toEqual([command.commandId, command.commandId, command.commandId]);
    const next = { ...command, commandId: 'command_next_12345678' as typeof command.commandId };
    expect(await twiceReloaded.review.approve(next)).toEqual({ kind: 'lost' });
    expect(writes).toBe(2); // A new explicit command can replace the saved completed status.
    expect(createOwnerMailboxReviewClient(options).review.recoverUnknown?.(
      command.bindingId, command.roomId, command.expectedBindingGeneration)).toEqual(next);
    entries.set(`khala.review.unknown.v1:${command.bindingId}:${command.roomId}:${command.expectedBindingGeneration}`, '{bad');
    expect(createOwnerMailboxReviewClient(options).review.recoverUnknown?.(
      command.bindingId, command.roomId, command.expectedBindingGeneration)).toBeNull();
  });

  it('checks the exact persisted command repeatedly without submitting on unknown or unavailable status', async () => {
    const entries = new Map<string, string>();
    const storage = { getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value); },
      removeItem: (key: string) => { entries.delete(key); } };
    let writes = 0;
    const reads: string[] = [];
    let status = 404;
    const fetcher: typeof fetch = async (url, init) => {
      if (init?.method === 'POST') { writes += 1; throw new Error('possible commit'); }
      reads.push(new URL(String(url)).searchParams.get('operation_id') ?? 'missing');
      return json(status, { code: status === 403 ? 'forbidden' : 'not_found' });
    };
    const options = { origin: ORIGIN, csrf: async () => 'csrf-value', fetch: fetcher, storage };
    expect(await createOwnerMailboxReviewClient(options).review.approve(command)).toEqual({ kind: 'lost' });
    const restored = createOwnerMailboxReviewClient(options).review;
    expect(restored.recoverUnknown?.(command.bindingId, command.roomId, command.expectedBindingGeneration)).toEqual(command);
    expect(await restored.reconcile(command)).toEqual({ kind: 'lost' });
    status = 403;
    expect(await restored.reconcile(command)).toEqual({ kind: 'lost' });
    expect(writes).toBe(1);
    expect(reads).toEqual([command.commandId, command.commandId]);
    expect(await restored.reconcile({ ...command, selection: [] })).toEqual({ kind: 'lost' });
    expect(reads).toHaveLength(2);
  });

  it('does not reconcile missing or corrupt persisted command data after reload', async () => {
    const entries = new Map<string, string>();
    const storage = { getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value); },
      removeItem: (key: string) => { entries.delete(key); } };
    let requests = 0;
    const client = createOwnerMailboxReviewClient({ origin: ORIGIN, csrf: async () => 'csrf-value', storage,
      fetch: async () => { requests += 1; throw new Error('unexpected network'); } }).review;
    expect(client.recoverUnknown?.(command.bindingId, command.roomId, command.expectedBindingGeneration)).toBeNull();
    expect(await client.reconcile(command)).toEqual({ kind: 'lost' });
    entries.set(`khala.review.unknown.v1:${command.bindingId}:${command.roomId}:${command.expectedBindingGeneration}`, '{bad');
    expect(client.recoverUnknown?.(command.bindingId, command.roomId, command.expectedBindingGeneration)).toBeNull();
    expect(await client.reconcile(command)).toEqual({ kind: 'lost' });
    expect(requests).toBe(0);
  });
});
