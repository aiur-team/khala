import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BindingId, ListeningModeCommand, OwnerRouteGrantCommand, PolicySetCommand } from '@khala/contracts/delivery/index';
import { createOwnerMailboxControlsClient } from './owner-mailbox-client';

const origin = 'https://khala.example';
const bindingId = 'binding_12345678' as BindingId;
const command = { v: 1, commandId: 'command_12345678', bindingId, roomId: '!room:example',
  expectedPolicyVersion: 3, expectedBindingGeneration: 2, mode: 'review', paused: true,
  peerParticipantId: 'agent-1', issuedAt: '2026-09-27T00:00:00Z' } as unknown as PolicySetCommand;
const modeCommand: ListeningModeCommand = { v: 1, commandId: 'mode_command_12345678' as never,
  bindingId, expectedBindingGeneration: 2, expectedVersion: 1,
  requested: 'steer', issuedAt: '2026-09-27T00:00:00Z' };
const grantCommand: OwnerRouteGrantCommand = { v: 1, kind: 'grant_experimental_route',
  commandId: 'grant_command_12345678' as never, bindingId, expectedBindingGeneration: 2,
  expectedVersion: 1, mode: 'steer', route: 'codex-steer', harnessVersion: '0.154.0',
  evidenceRevision: 'proof-1', issuedAt: '2026-09-27T00:00:00Z' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } });

describe('owner mailbox controls client', () => {
  it('sends an exact owner grant through CSRF mailbox and pins its retry body', async () => {
    const bodies: string[] = [];
    let attempts = 0;
    const client = createOwnerMailboxControlsClient({ origin, csrf: async () => 'csrf-value', waitMs: 0,
      fetch: async (_url, init) => {
        if (init?.method === 'GET') return json(404, { code: 'not_found' });
        bodies.push(String(init?.body));
        attempts += 1;
        if (attempts === 1) throw new Error('response lost');
        return json(200, { v: 1, operationId: grantCommand.commandId,
          outcome: { commandId: grantCommand.commandId, outcome: 'applied', reason: null } });
      } });
    expect(await client.setRouteGrant(grantCommand)).toEqual({ kind: 'lost' });
    expect(await client.setRouteGrant({ ...grantCommand, issuedAt: '2026-09-27T00:01:00Z' }))
      .toMatchObject({ kind: 'answered', body: { commandId: grantCommand.commandId } });
    expect(bodies).toEqual([bodies[0], bodies[0]]);
    expect(JSON.parse(bodies[0]!)).toEqual({ bindingId, operationId: grantCommand.commandId,
      kind: 'listening_grant', body: grantCommand });
  });
  it('retries a lost listening response with the exact command and treats a later denial as unknown', async () => {
    const bodies: string[] = [];
    let attempts = 0;
    const client = createOwnerMailboxControlsClient({ origin, csrf: async () => 'csrf-value', waitMs: 0,
      fetch: async (_url, init) => {
        if (init?.method === 'GET') return json(404, { code: 'not_found' });
        bodies.push(String(init?.body));
        attempts += 1;
        if (attempts === 1) throw new Error('lost after submit');
        if (attempts === 2) return json(403, { code: 'forbidden' });
        return json(200, { v: 1, operationId: modeCommand.commandId,
          outcome: { v: 1, commandId: modeCommand.commandId, bindingId, generation: 2,
            outcome: 'applied', version: 2, requested: 'steer', effective: 'steer', reason: null } });
      } });
    expect(await client.setListeningMode(modeCommand)).toEqual({ kind: 'lost' });
    expect(await client.setListeningMode({ ...modeCommand, issuedAt: '2026-09-27T00:01:00Z' })).toEqual({ kind: 'lost' });
    expect(await client.setListeningMode(modeCommand)).toMatchObject({ kind: 'answered', body: { version: 2 } });
    expect(bodies).toEqual([bodies[0], bodies[0], bodies[0]]);
    expect(JSON.parse(bodies[0]!)).toMatchObject({ kind: 'listening_set',
      operationId: modeCommand.commandId, body: modeCommand });
  });
  beforeEach(() => { if (typeof globalThis.sessionStorage !== 'undefined') globalThis.sessionStorage.clear(); });
  it('keeps the same status ID and backoff across a tab reload', async () => {
    let now = 1_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); } };
    const submitted: string[] = [];
    let reads = 0;
    const fetcher: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/submit')) {
        const operationId = (JSON.parse(String(init?.body)) as { operationId: string }).operationId;
        submitted.push(operationId);
        return json(200, { v: 1, operationId, outcome: null });
      }
      reads += 1;
      return json(200, { v: 1, operationId: new URL(String(url)).searchParams.get('operation_id'),
        outcome: { ok: true, status: {} } });
    };
    const create = () => createOwnerMailboxControlsClient({ origin, csrf: async () => 'csrf-value',
      fetch: fetcher, waitMs: 0, storage });
    const signal = new AbortController().signal;
    expect(await create().status(bindingId, signal)).toEqual({ kind: 'refused', code: 'unavailable' });
    expect(await create().status(bindingId, signal)).toEqual({ kind: 'refused', code: 'unavailable' });
    expect(submitted).toHaveLength(1);
    expect(reads).toBe(0);
    now += 15_000;
    expect(await create().status(bindingId, signal)).toEqual({ kind: 'ok', body: {} });
    expect(submitted).toHaveLength(1);
    expect(reads).toBe(1);
    clock.mockRestore();
  });
  it('bounds result requests during and after the first offline wait', async () => {
    let submissions = 0;
    let results = 0;
    const fetcher: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/submit')) {
        submissions += 1;
        return json(200, { v: 1, operationId: (JSON.parse(String(init?.body)) as { operationId: string }).operationId,
          outcome: null });
      }
      results += 1;
      return json(200, { v: 1, operationId: new URL(String(url)).searchParams.get('operation_id'), outcome: null });
    };
    const client = createOwnerMailboxControlsClient({ origin, csrf: async () => 'csrf-value',
      fetch: fetcher, waitMs: 120 });
    const signal = new AbortController().signal;
    expect(await client.status(bindingId, signal)).toEqual({ kind: 'refused', code: 'unavailable' });
    for (let i = 0; i < 10; i++) {
      expect(await client.status(bindingId, signal)).toEqual({ kind: 'refused', code: 'unavailable' });
    }
    expect(submissions).toBe(1);
    expect(results).toBe(1);
  });
  it('uses in-memory retry state when browser storage is blocked', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true,
      get() { throw new Error('storage blocked'); } });
    try {
      let submissions = 0;
      const client = createOwnerMailboxControlsClient({ origin, csrf: async () => 'csrf-value', waitMs: 0,
        fetch: async (_url, init) => {
          submissions += 1;
          return json(200, { v: 1, operationId: (JSON.parse(String(init?.body)) as { operationId: string }).operationId,
            outcome: null });
        } });
      const signal = new AbortController().signal;
      expect(await client.status(bindingId, signal)).toEqual({ kind: 'refused', code: 'unavailable' });
      expect(await client.status(bindingId, signal)).toEqual({ kind: 'refused', code: 'unavailable' });
      expect(submissions).toBe(1);
    } finally {
      if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
      else Reflect.deleteProperty(globalThis, 'sessionStorage');
    }
  });
  it('reuses an unresolved status operation until completion', async () => {
    let now = 1_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const submitted: string[] = [];
    let reads = 0;
    let complete = false;
    const fetcher: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/submit')) {
        const operationId = (JSON.parse(String(init?.body)) as { operationId: string }).operationId;
        submitted.push(operationId);
        return json(200, { v: 1, operationId, outcome: complete ? { ok: true, status: {} } : null });
      }
      const operationId = new URL(String(url)).searchParams.get('operation_id');
      reads += 1;
      return json(200, { v: 1, operationId, outcome: complete ? { ok: true, status: {} } : null });
    };
    const client = createOwnerMailboxControlsClient({ origin, csrf: async () => 'csrf-value',
      fetch: fetcher, waitMs: 0 });
    const signal = new AbortController().signal;
    expect(await client.status(bindingId, signal)).toEqual({ kind: 'refused', code: 'unavailable' });
    expect(await client.status(bindingId, signal)).toEqual({ kind: 'refused', code: 'unavailable' });
    expect(submitted).toHaveLength(1);
    expect(reads).toBe(0);
    complete = true;
    now += 15_000;
    expect(await client.status(bindingId, signal)).toEqual({ kind: 'ok', body: {} });
    expect(await client.status(bindingId, signal)).toEqual({ kind: 'ok', body: {} });
    expect(submitted).toHaveLength(2);
    expect(submitted[1]).not.toBe(submitted[0]);
    clock.mockRestore();
  });

  it('uses the protected owner route and unwraps exact status and policy outcomes', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetcher: typeof fetch = async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      const submitted = JSON.parse(String(init?.body)) as { operationId: string; kind: string };
      return json(200, { v: 1, operationId: submitted.operationId,
        outcome: submitted.kind === 'controls_status'
          ? { ok: true, status: { bindingId, effectiveVersion: 3 } }
          : { ok: true, ack: { commandId: command.commandId, bindingId, connectorState: 'effective' } } });
    };
    const client = createOwnerMailboxControlsClient({ origin, csrf: async () => 'csrf-value', fetch: fetcher });
    expect(await client.status(bindingId, new AbortController().signal)).toEqual({ kind: 'ok', body: {
      bindingId, effectiveVersion: 3,
    } });
    expect(await client.setPolicy(command)).toEqual({ kind: 'answered', body: {
      commandId: command.commandId, bindingId, connectorState: 'effective',
    } });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe(`${origin}/api/human/owner-mailbox/submit`);
    expect(requests[0]?.init.credentials).toBe('same-origin');
    expect((requests[0]?.init.headers as Record<string, string>)['x-khala-csrf']).toBe('csrf-value');
    expect(JSON.parse(String(requests[0]?.init.body))).toMatchObject({ bindingId,
      kind: 'controls_status', body: { bindingId } });
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({ bindingId,
      operationId: command.commandId, kind: 'controls_set', body: command });
    expect(JSON.stringify(requests)).not.toContain('authority');
  });

  it('resends only the same command identity after a lost answer and never treats later denial as proof of no write', async () => {
    const ids: string[] = [];
    const bodies: string[] = [];
    let attempts = 0;
    const fetcher: typeof fetch = async (_url, init) => {
      const submitted = JSON.parse(String(init?.body)) as { operationId: string; body: PolicySetCommand };
      ids.push(submitted.operationId);
      bodies.push(JSON.stringify(submitted.body));
      attempts += 1;
      if (attempts === 1) throw new Error('response lost after possible commit');
      if (attempts === 2) return json(403, { code: 'forbidden' });
      return json(200, { v: 1, operationId: command.commandId,
        outcome: { ok: true, ack: { commandId: command.commandId } } });
    };
    const client = createOwnerMailboxControlsClient({ origin, csrf: async () => 'csrf-value', fetch: fetcher });
    expect(await client.setPolicy(command)).toEqual({ kind: 'lost' });
    const retried = { ...command, issuedAt: '2026-09-27T00:01:00Z' };
    expect(await client.setPolicy(retried)).toEqual({ kind: 'lost' });
    expect(await client.setPolicy(retried)).toEqual({ kind: 'answered', body: { commandId: command.commandId } });
    expect(ids).toEqual([command.commandId, command.commandId, command.commandId]);
    expect(bodies).toEqual([bodies[0], bodies[0], bodies[0]]);
  });

  it('refuses an initial owner denial and rejects mismatched operation outcomes', async () => {
    const denied = createOwnerMailboxControlsClient({ origin, csrf: async () => 'csrf-value',
      fetch: async () => json(403, { code: 'forbidden' }) });
    expect(await denied.status(bindingId, new AbortController().signal)).toEqual({ kind: 'refused', code: 'forbidden' });
    expect(await denied.setPolicy(command)).toEqual({ kind: 'refused', code: 'forbidden' });
    const mismatched = createOwnerMailboxControlsClient({ origin, csrf: async () => 'csrf-value',
      fetch: async () => json(200, { v: 1, operationId: 'another-command', outcome: { ok: true, ack: {} } }) });
    expect(await mismatched.setPolicy(command)).toEqual({ kind: 'lost' });
  });

  it('keeps an expired request unknown when obtaining CSRF outlasts the deadline', async () => {
    let writes = 0;
    const client = createOwnerMailboxControlsClient({ origin, waitMs: 5,
      csrf: async () => { await new Promise(resolve => setTimeout(resolve, 20)); return 'csrf-value'; },
      fetch: async () => { writes += 1; return json(200, {}); } });
    expect(await client.setPolicy(command)).toEqual({ kind: 'lost' });
    expect(writes).toBe(0);
  });
});
