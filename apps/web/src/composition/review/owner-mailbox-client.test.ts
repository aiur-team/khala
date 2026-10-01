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
    expect(await client.review.approve(command)).toEqual({ kind: 'answered', body: { ok: true, releaseIds: ['release_12345678'] } });
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
    const fetcher: typeof fetch = async url => {
      if (String(url).endsWith('/submit')) { writes += 1; throw new Error('answer lost'); }
      if (String(url).includes('/result?')) return json(200, { v: 1, operationId: command.commandId,
        outcome: { ok: true, releaseIds: ['release_12345678'] } });
      throw new Error('unexpected route');
    };
    const options = { origin: ORIGIN, csrf: async () => 'csrf-value', fetch: fetcher, storage };
    const before = createOwnerMailboxReviewClient(options);
    expect(await before.review.approve(command)).toEqual({ kind: 'lost' });
    const after = createOwnerMailboxReviewClient(options);
    expect(after.review.recoverUnknown?.(command.bindingId, command.roomId, command.expectedBindingGeneration)).toEqual(command);
    expect(after.review.recoverUnknown?.(command.bindingId, command.roomId, command.expectedBindingGeneration + 1)).toBeNull();
    expect(await after.review.approve(command)).toEqual({ kind: 'answered', body: { ok: true, releaseIds: ['release_12345678'] } });
    expect(writes).toBe(1);
    expect(entries.size).toBe(0);
  });
});
