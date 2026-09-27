import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import { createProofSigner } from '@khala/connector/bootstrap/proof';
import { createCapabilityRenewal } from './capability-renewal';

const binding = { v: 1, bindingId: 'binding-renewal-one', ownerId: 'owner-one',
  agentParticipantId: 'agent-one', deviceId: 'DEVICE_ONE', harness: 'codex',
  sessionId: 'thread-one', generation: 0 } as SessionBinding;
const T0 = Date.parse('2026-09-27T00:00:00Z');
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('endpoint capability renewal', () => {
  it('retains only the exact persisted proof-bound token for revoked cleanup after TTL', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'khala-expired-cleanup-'));
    directories.push(directory);
    let now = T0;
    const signer = createProofSigner(generateKeyPairSync('ed25519').privateKey, () => now);
    const token = randomBytes(32).toString('base64url');
    const renewal = createCapabilityRenewal({ stateDirectory: directory,
      appOrigin: 'https://khala.aiur.team', binding, signer, clock: () => now,
      fetch: async () => new Response(null, { status: 503 }) });
    await renewal.acceptInitial({ token, bindingId: binding.bindingId, generation: binding.generation,
      scope: ['publish_own', 'receive_released', 'ack_delivery'], expiresAt: now + 3_600_000 });
    now += 7_200_000;
    expect((await renewal.existingForCleanup())?.token).toBe(token);
    expect(await renewal.ensure()).toBeNull();
    const other = createCapabilityRenewal({ stateDirectory: directory,
      appOrigin: 'https://khala.aiur.team', binding: { ...binding, generation: 1 }, signer, clock: () => now });
    expect(await other.existingForCleanup()).toBeNull();
    const wrongSigner = createCapabilityRenewal({ stateDirectory: directory,
      appOrigin: 'https://khala.aiur.team', binding,
      signer: createProofSigner(generateKeyPairSync('ed25519').privateKey, () => now), clock: () => now });
    expect(await wrongSigner.existingForCleanup()).toBeNull();
  });
  it('keeps one durable challenge and operation after a lost POST reply, then reuses the exact token after restart', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'khala-refresh-'));
    directories.push(directory);
    let now = T0;
    const signer = createProofSigner(generateKeyPairSync('ed25519').privateKey, () => now);
    const nonce = randomBytes(32).toString('base64url');
    const token = randomBytes(32).toString('base64url');
    let challenges = 0;
    let posts = 0;
    const bodies: unknown[] = [];
    const transport: typeof fetch = async (target, request) => {
      if (String(target).includes('/challenge')) {
        challenges++;
        return json({ v: 1, nonce, expires_at: now + 60_000 });
      }
      posts++;
      const body = JSON.parse(String(request?.body)) as unknown;
      bodies.push(body);
      if (posts === 1) throw new Error('response lost after commit');
      return json({ v: 1, binding, adapter_capability: { token, token_type: 'DPoP',
        binding_id: binding.bindingId, generation: binding.generation,
        scope: ['publish_own', 'receive_released', 'ack_delivery'], expires_at: now + 3_600_000 } });
    };
    const options = { stateDirectory: directory, appOrigin: 'https://khala.aiur.team', binding, signer,
      fetch: transport, clock: () => now };
    const first = createCapabilityRenewal(options);
    await first.acceptInitial({ token: randomBytes(32).toString('base64url'), bindingId: binding.bindingId,
      generation: binding.generation, scope: ['publish_own', 'receive_released', 'ack_delivery'], expiresAt: now + 30_000 });
    expect(await first.ensure()).toBeNull();
    const plan = JSON.parse(await readFile(path.join(directory, 'refresh-plan.json'), 'utf8')) as { nonce: string };
    expect(plan.nonce).toBe(nonce);
    now += 65_000;
    const reopened = createCapabilityRenewal(options);
    expect((await reopened.ensure())?.token).toBe(token);
    expect(challenges).toBe(1);
    expect(posts).toBe(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect((await createCapabilityRenewal(options).ensure())?.token).toBe(token);
    expect(posts).toBe(2);
  });

  it('refuses a capability returned for another binding', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'khala-refresh-'));
    directories.push(directory);
    const signer = createProofSigner(generateKeyPairSync('ed25519').privateKey, () => T0);
    const nonce = randomBytes(32).toString('base64url');
    const transport: typeof fetch = async (target) => String(target).includes('/challenge')
      ? json({ v: 1, nonce, expires_at: T0 + 60_000 })
      : json({ v: 1, binding: { ...binding, bindingId: 'binding-other' }, adapter_capability: {
        token: randomBytes(32).toString('base64url'), token_type: 'DPoP',
        binding_id: 'binding-other', generation: 0,
        scope: ['publish_own', 'receive_released', 'ack_delivery'], expires_at: T0 + 3_600_000,
      } });
    const client = createCapabilityRenewal({ stateDirectory: directory,
      appOrigin: 'https://khala.aiur.team', binding, signer, fetch: transport, clock: () => T0 });
    expect(await client.ensure()).toBeNull();
  });
});
