import { describe, expect, it } from 'vitest';
import type { BindingId, PolicySetCommand } from '@khala/contracts/delivery/index';
import { createOwnerMailboxControlsClient } from './owner-mailbox-client';

const origin = 'https://khala.example';
const bindingId = 'binding_12345678' as BindingId;
const command = { v: 1, commandId: 'command_12345678', bindingId, roomId: '!room:example',
  expectedPolicyVersion: 3, expectedBindingGeneration: 2, mode: 'review', paused: true,
  peerParticipantId: 'agent-1', issuedAt: '2026-09-27T00:00:00Z' } as unknown as PolicySetCommand;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } });

describe('owner mailbox controls client', () => {
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
