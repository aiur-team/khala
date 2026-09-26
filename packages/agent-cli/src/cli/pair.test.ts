import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from './app.js';
import { listingClient } from './channels/fixtures/listing.js';
import type { BatchInbox } from './inbox.js';
import { PairingService, normalizePairingCode } from './pair.js';
import type { AgentClientPort, PairResult } from './types.js';

const BINDING = {
  v: 1, bindingId: 'bnd_1', ownerId: 'owner_b', agentParticipantId: 'agent_b', deviceId: 'KHALADEV1',
  harness: 'codex', sessionId: 'thread-existing-b', generation: 3,
};

function unusedInbox(): Promise<BatchInbox> { throw new Error('inbox should not be opened'); }

async function run(argv: readonly string[], client: AgentClientPort) {
  const stdin = new PassThrough(); stdin.end();
  const stdout = new PassThrough(); const stderr = new PassThrough(); let out = ''; let err = '';
  stdout.on('data', chunk => { out += String(chunk); }); stderr.on('data', chunk => { err += String(chunk); });
  const code = await runCli(argv, { client, inbox: unusedInbox, stdin, stdout, stderr });
  return { code, stdout: out, stderr: err };
}

function pairingClient(result: PairResult | (() => Promise<PairResult>)) {
  const pair = vi.fn<NonNullable<AgentClientPort['pair']>>(typeof result === 'function' ? result : async () => result);
  return { client: listingClient({ pair }), pair };
}

describe('normalizePairingCode', () => {
  it('accepts the canonical code and forgives case, spacing, the separator and Crockford look-alikes', () => {
    expect(normalizePairingCode('7K3QX-9MZ2P')).toBe('7K3QX-9MZ2P');
    expect(normalizePairingCode(' 7k3qx 9mz2p ')).toBe('7K3QX-9MZ2P');
    expect(normalizePairingCode('7K3QX9MZ2P')).toBe('7K3QX-9MZ2P');
    expect(normalizePairingCode('OIL00-00000')).toBe('01100-00000');
  });

  it('refuses anything that is not exactly one ten-symbol code', () => {
    for (const bad of ['', '7K3QX-9MZ2', '7K3QX-9MZ2PP', '7K3QX-9MZ2U', 'https://khala.example/i/x', 'x'.repeat(33), 42, null]) {
      expect(normalizePairingCode(bad)).toBeNull();
    }
  });
});

describe('khala pair', () => {
  it('AE2: pairs with the canonical code and prints the admitted binding', async () => {
    const { client, pair } = pairingClient({ kind: 'connected', binding: BINDING as never, reused: false });
    const result = await run(['pair', '7k3qx 9mz2p'], client);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, v: 1, binding: BINDING, reused: false });
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(pair).toHaveBeenCalledWith('7K3QX-9MZ2P', undefined);
  });

  it('AE6: prints finite refusals with no code, receipt, grant or channel detail', async () => {
    for (const code of ['pairing_refused', 'pairing_denied', 'pairing_expired', 'rate_limited', 'operation_conflict'] as const) {
      const { client } = pairingClient({ kind: 'refused', code });
      const result = await run(['pair', '7K3QX-9MZ2P'], client);
      expect(result.code).toBe(3);
      expect(JSON.parse(result.stdout)).toEqual({ ok: false, v: 1, error: code });
      expect(result.stdout).not.toContain('7K3QX');
    }
  });

  it('reports a pending approval as resumable with the same code', async () => {
    const { client } = pairingClient({ kind: 'pending', reason: 'approval_timeout' });
    const result = await run(['pair', '7K3QX-9MZ2P'], client);
    expect(result.code).toBe(4);
    expect(JSON.parse(result.stdout)).toEqual({ ok: false, v: 1, error: 'approval_pending', reason: 'approval_timeout', retryable: true });
  });

  it('refuses a malformed code without calling the connector', async () => {
    const { client, pair } = pairingClient({ kind: 'unavailable' });
    const result = await run(['pair', 'not-a-code'], client);
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout)).toEqual({ ok: false, v: 1, error: 'invalid_code' });
    expect(pair).not.toHaveBeenCalled();
  });

  it('requires exactly one argument', async () => {
    const { client } = pairingClient({ kind: 'unavailable' });
    for (const argv of [['pair'], ['pair', '7K3QX-9MZ2P', 'extra']]) {
      const result = await run(argv, client);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stderr)).toEqual({ ok: false, error: 'invalid_arguments' });
    }
  });

  it('reports pairing_unavailable when the connector has no pairing configuration', async () => {
    const result = await run(['pair', '7K3QX-9MZ2P'], listingClient());
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout)).toEqual({ ok: false, v: 1, error: 'pairing_unavailable' });
  });
});

describe('PairingService', () => {
  it('drops thrown error text and unexpected result fields', async () => {
    const thrown = new PairingService({ pair: async () => { throw new Error('receipt=abc grant=def 7K3QX-9MZ2P'); } });
    expect(await thrown.pair('7K3QX-9MZ2P')).toEqual({ ok: false, v: 1, error: 'unavailable' });

    const widened = new PairingService({
      pair: async () => ({ kind: 'refused', code: 'channel_room_1_exists' }) as unknown as PairResult,
    });
    expect(await widened.pair('7K3QX-9MZ2P')).toEqual({ ok: false, v: 1, error: 'unavailable' });

    const extra = new PairingService({
      pair: async () => ({ kind: 'connected', binding: { ...BINDING, grant: 'secret-grant' }, reused: false }) as unknown as PairResult,
    });
    const output = await extra.pair('7K3QX-9MZ2P');
    expect(output).toEqual({ ok: true, v: 1, binding: BINDING, reused: false });
    expect(JSON.stringify(output)).not.toContain('secret-grant');
  });

  it('passes cancellation through to the connector', async () => {
    const controller = new AbortController();
    const pair = vi.fn<NonNullable<AgentClientPort['pair']>>(async () => ({ kind: 'pending', reason: 'cancelled' }));
    expect(await new PairingService({ pair }).pair('7K3QX-9MZ2P', controller.signal))
      .toEqual({ ok: false, v: 1, error: 'approval_pending', reason: 'cancelled', retryable: true });
    expect(pair).toHaveBeenCalledWith('7K3QX-9MZ2P', controller.signal);
  });
});
