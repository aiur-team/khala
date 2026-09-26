// Port-level tests for connector-side channel-access activation (RD5B). The service
// double seals with the real pinned libsodium binding and the real contract decoders,
// so opening, tampering and key loss behave as they do against the hosted exchange.

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  type AccessRequestOutcome,
  type ChannelAccessReadiness,
  type GrantExchangeRequest,
  type SealedGrantEnvelope,
  type SessionBinding,
  type StableAgentPrincipal,
  CHANNEL_SEALED_BOX_ALGORITHM,
} from '@khala/contracts/messaging/index';
import sodium from 'libsodium-wrappers';
import { describe, expect, it } from 'vitest';
import {
  type ActivationRecord,
  type ChannelAccessActivationPorts,
  type ChannelAccessActivationStore,
  type ExchangeOutcome,
  type RecoveryKeyWrite,
  type ReadinessOutcome,
  type TrustInitialization,
  DEFAULT_ACTIVATION_POLLING,
  activateChannelAccess,
  backoff,
  decodeActivationRecord,
  journalChannelAccessRequest,
  resumeChannelAccessActivations,
} from './channel-access-activation';
import type { AdapterCapability, DeviceActivation } from './ports';
import { createProofSigner } from './proof';

const T0 = Date.parse('2026-09-25T12:00:00Z');
const ORIGIN = 'https://khala.example';
const REQUESTER = 'principal_1' as StableAgentPrincipal;
const OPERATION = 'op_access_1';
const GRANT_LIFETIME_MS = 15 * 60_000;
const signer = createProofSigner(generateKeyPairSync('ed25519').privateKey, () => T0);

/** In-memory journal with the same compare-and-set and record/key atomicity as SQLite. */
function memoryJournal() {
  const rows = new Map<string, { record: string; revision: number; key: Uint8Array | null }>();
  const state = { failSave: false, failLoad: false, saves: 0, writes: [] as { phase: string; key: boolean }[] };
  const journal: ChannelAccessActivationStore = {
    async load(operationId) {
      if (state.failLoad) throw new Error('disk gone');
      const row = rows.get(operationId);
      if (!row) return { kind: 'absent' };
      const record = decodeActivationRecord(JSON.parse(row.record));
      if (record === null) return { kind: 'unavailable' };
      return { kind: 'record', record, revision: row.revision, recoveryKey: row.key === null ? null : new Uint8Array(row.key) };
    },
    async save(record, expectedRevision, key: RecoveryKeyWrite) {
      if (state.failSave) return { kind: 'unavailable' };
      if (decodeActivationRecord(JSON.parse(JSON.stringify(record))) === null) throw new Error('invalid record');
      const row = rows.get(record.operationId);
      if ((row?.revision ?? null) !== expectedRevision) return { kind: 'conflict' };
      state.saves++;
      const nextKey = key.kind === 'set' ? new Uint8Array(key.privateKey) : key.kind === 'clear' ? null : row?.key ?? null;
      const revision = (row?.revision ?? 0) + 1;
      rows.set(record.operationId, { record: JSON.stringify(record), revision, key: nextKey });
      state.writes.push({ phase: record.phase, key: nextKey !== null });
      return { kind: 'saved', revision };
    },
    async listActive() {
      return [...rows.entries()]
        .filter(([, row]) => !['connected', 'closed'].includes((JSON.parse(row.record) as ActivationRecord).phase))
        .map(([operationId]) => operationId);
    },
  };
  return {
    journal,
    rows,
    state,
    record: () => JSON.parse(rows.get(OPERATION)!.record) as ActivationRecord,
    key: () => rows.get(OPERATION)?.key ?? null,
    dropKey() { rows.get(OPERATION)!.key = null; },
  };
}

/**
 * The hosted exchange's observable behaviour: first bound key seals once, a retry returns
 * the byte-identical stored envelope, a new key before sealing supersedes the old one,
 * a different key after sealing is `encryption_key_mismatch`, and readiness deletes it.
 */
function fakeService(clock: () => number) {
  const state = {
    status: 'pending_owner' as AccessRequestOutcome | 'unavailable',
    boundKey: null as string | null,
    stored: null as { envelope: SealedGrantEnvelope; grant: string; key: string } | null,
    acknowledged: false,
    envelopeDeleted: false,
    seals: 0,
    exchanges: [] as GrantExchangeRequest[],
    acks: [] as ChannelAccessReadiness[],
    redeems: [] as string[],
    loseNextExchangeResponse: false,
    loseNextAckResponse: false,
    tamper: null as ((envelope: SealedGrantEnvelope) => unknown) | null,
    ackResult: null as ReadinessOutcome | null,
    redeemRefusal: null as 'admission_denied' | 'binding_revoked' | null,
    redeemCapability: {} as Partial<AdapterCapability>,
    payload: {} as Record<string, unknown>,
  };
  async function seal(request: GrantExchangeRequest): Promise<SealedGrantEnvelope> {
    await sodium.ready;
    const grant = `cagrant_${randomBytes(32).toString('base64url')}`;
    const payload = {
      v: 1,
      operationId: request.operationId,
      requester: request.requester,
      origin: request.origin,
      sessionGeneration: request.sessionGeneration,
      deviceId: request.deviceId,
      proofKeyThumbprint: request.proofKey.thumbprint,
      recipientKeyThumbprint: request.encryptionKey.thumbprint,
      expiresAt: new Date(clock() + GRANT_LIFETIME_MS).toISOString(),
      grant,
      ...state.payload,
    };
    const publicKey = sodium.from_base64(request.encryptionKey.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
    const ciphertext = sodium.crypto_box_seal(sodium.from_string(JSON.stringify(payload)), publicKey);
    state.seals++;
    const envelope: SealedGrantEnvelope = {
      v: 1,
      algorithm: CHANNEL_SEALED_BOX_ALGORITHM,
      recipientKeyThumbprint: request.encryptionKey.thumbprint,
      ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING),
    };
    state.stored = { envelope, grant, key: request.encryptionKey.thumbprint };
    return envelope;
  }
  const exchange: ChannelAccessActivationPorts['exchange'] = {
    async exchange(request): Promise<ExchangeOutcome> {
      state.exchanges.push(request);
      if (state.acknowledged || state.envelopeDeleted) return { kind: 'rejected', code: 'closed' };
      if (state.status !== 'approved' && state.status !== 'connecting') return { kind: 'unavailable' };
      let envelope: SealedGrantEnvelope;
      if (state.stored !== null) {
        if (state.stored.key !== request.encryptionKey.thumbprint) return { kind: 'rejected', code: 'encryption_key_mismatch' };
        envelope = state.stored.envelope;
      } else {
        state.boundKey = request.encryptionKey.thumbprint;
        envelope = await seal(request);
        state.status = 'connecting';
      }
      if (state.loseNextExchangeResponse) {
        state.loseNextExchangeResponse = false;
        return { kind: 'unavailable' };
      }
      // A JSON round trip, as over HTTP.
      const wire = JSON.parse(JSON.stringify(envelope)) as SealedGrantEnvelope;
      return { kind: 'sealed', envelope: state.tamper ? state.tamper(wire) : wire };
    },
    async acknowledge(readiness) {
      state.acks.push(readiness);
      if (state.ackResult !== null) return state.ackResult;
      if (state.stored === null && !state.acknowledged) return 'rejected';
      state.acknowledged = true;
      state.envelopeDeleted = true;
      state.status = 'connected';
      if (state.loseNextAckResponse) {
        state.loseNextAckResponse = false;
        return 'unavailable';
      }
      return 'acknowledged';
    },
  };
  return { state, exchange };
}

function bindingFor(deviceId: string, generation = 3): SessionBinding {
  return {
    v: 1, bindingId: 'bnd_1' as never, ownerId: 'owner_1' as never, agentParticipantId: 'agent_1' as never,
    deviceId: deviceId as never, harness: 'codex', sessionId: 'thread-1', generation,
  };
}

function harness(overrides: Partial<{
  activate: () => DeviceActivation;
  trust: () => TrustInitialization;
}> = {}) {
  let now = T0;
  const clock = () => now;
  const store = memoryJournal();
  const service = fakeService(clock);
  const devices = { reserved: new Map<string, string>(), ready: new Set<string>(), activations: 0, statusOverride: null as null | 'missing' };
  const sleeps: number[] = [];
  const trustCalls: SessionBinding[] = [];
  const ports: { -readonly [K in keyof ChannelAccessActivationPorts]: ChannelAccessActivationPorts[K] } = {
    journal: store.journal,
    status: { inspect: async () => service.state.status },
    exchange: service.exchange,
    redeem: {
      async redeem({ grant, deviceId }) {
        service.state.redeems.push(grant);
        if (service.state.stored === null || grant !== service.state.stored.grant) return { kind: 'refused', code: 'admission_denied' };
        if (service.state.redeemRefusal) return { kind: 'refused', code: service.state.redeemRefusal };
        return {
          kind: 'admitted',
          binding: bindingFor(deviceId),
          capability: {
            token: 'adapter-capability-secret',
            scope: ['publish_own', 'receive_released', 'ack_delivery'],
            bindingId: 'bnd_1',
            generation: 3,
            expiresAt: now + 3_600_000,
            ...service.state.redeemCapability,
          },
        };
      },
    },
    devices: {
      async reserve(operationId) {
        const existing = devices.reserved.get(operationId) ?? `device_${devices.reserved.size + 1}`;
        devices.reserved.set(operationId, existing);
        return { kind: 'reserved', deviceId: existing };
      },
      async activate({ deviceId }) {
        devices.activations++;
        const result = overrides.activate?.() ?? { kind: 'ready' };
        if (result.kind === 'ready') devices.ready.add(deviceId);
        return result;
      },
      async status(deviceId) {
        if (devices.statusOverride) return devices.statusOverride;
        return devices.ready.has(deviceId) ? 'ready' : 'incomplete';
      },
    },
    trust: {
      async initialize(binding) {
        trustCalls.push(binding);
        return overrides.trust?.() ?? { kind: 'initialized', mode: 'review', paused: false };
      },
    },
    signer,
    clock,
    random: () => 0.5,
    polling: { baseMs: 1_000, maxMs: 60_000, maxAttempts: 3 },
    async sleep(ms) {
      sleeps.push(ms);
      now += ms;
    },
  };
  return {
    ports,
    store,
    service,
    devices,
    sleeps,
    trustCalls,
    setNow(value: number) { now = value; },
    now: () => now,
    journal: () => journalChannelAccessRequest(
      { operationId: OPERATION, requester: REQUESTER, origin: ORIGIN, sessionGeneration: 3 }, ports,
    ),
    activate: (options: { repair?: boolean } = {}) => activateChannelAccess(OPERATION, ports, options),
  };
}

async function approvedAndJournaled(overrides: Parameters<typeof harness>[0] = {}) {
  const h = harness(overrides);
  expect(await h.journal()).toBe('journaled');
  h.service.state.status = 'approved';
  return h;
}

describe('channel-access activation', () => {
  it('journals the request before anything else and is idempotent for the same input', async () => {
    const h = harness();
    expect(await h.journal()).toBe('journaled');
    expect(await h.journal()).toBe('journaled');
    expect(h.store.record()).toMatchObject({ phase: 'pending', deviceId: null, recoveryPublicKey: null, proofKeyThumbprint: signer.jkt });
    expect(await journalChannelAccessRequest(
      { operationId: OPERATION, requester: REQUESTER, origin: ORIGIN, sessionGeneration: 4 }, h.ports,
    )).toBe('operation_conflict');
    for (const bad of [
      { operationId: 'short', requester: REQUESTER, origin: ORIGIN, sessionGeneration: 3 },
      { operationId: OPERATION, requester: REQUESTER, origin: 'http://khala.example', sessionGeneration: 3 },
      { operationId: OPERATION, requester: REQUESTER, origin: `${ORIGIN}/path`, sessionGeneration: 3 },
      { operationId: OPERATION, requester: REQUESTER, origin: ORIGIN, sessionGeneration: -1 },
    ]) {
      expect(await journalChannelAccessRequest(bad, h.ports)).toBe('invalid_request');
    }
    expect(await activateChannelAccess('unknown_operation', h.ports)).toEqual({ kind: 'blocked', code: 'not_journaled' });
  });

  it('connects end to end: key before exchange, validated envelope, review baseline, then readiness', async () => {
    const h = await approvedAndJournaled();
    const result = await h.activate();
    expect(result).toEqual({ kind: 'connected', binding: bindingFor('device_1'), reused: false });

    expect(h.service.state.seals).toBe(1);
    expect(h.service.state.exchanges).toHaveLength(1);
    const request = h.service.state.exchanges[0]!;
    expect(request).toMatchObject({
      operationId: OPERATION, requester: REQUESTER, origin: ORIGIN, deviceId: 'device_1', sessionGeneration: 3,
      proofKey: { algorithm: 'Ed25519', publicKey: signer.publicKey, thumbprint: signer.jkt },
      encryptionKey: { algorithm: 'X25519' },
    });
    // A distinct X25519 recovery key, never the proof key.
    expect(request.encryptionKey.publicKey).not.toBe(signer.publicKey);
    expect(h.trustCalls).toEqual([bindingFor('device_1')]);
    expect(h.service.state.acks).toEqual([{
      v: 1, operationId: OPERATION, requester: REQUESTER, origin: ORIGIN, sessionGeneration: 3, deviceId: 'device_1',
      proofKeyThumbprint: signer.jkt, recipientKeyThumbprint: request.encryptionKey.thumbprint,
    }]);
    // The server deleted its envelope on readiness; the local private key is dropped too.
    expect(h.service.state.envelopeDeleted).toBe(true);
    expect(h.store.record().phase).toBe('connected');
    expect(h.store.key()).toBeNull();
    // A lost response after success reports the recorded outcome without another exchange.
    expect(await h.activate()).toEqual({ kind: 'connected', binding: bindingFor('device_1'), reused: true });
    expect(h.service.state.exchanges).toHaveLength(1);
  });

  it('persists the device, recovery key and tuple before calling the exchange', async () => {
    const h = await approvedAndJournaled();
    const seen: ActivationRecord[] = [];
    const exchange = h.ports.exchange.exchange;
    h.ports.exchange.exchange = async request => {
      seen.push(h.store.record());
      expect(h.store.key()).not.toBeNull();
      return exchange(request);
    };
    await h.activate();
    expect(seen[0]).toMatchObject({ phase: 'keyed', deviceId: 'device_1', recoveryKeyThumbprint: h.service.state.boundKey });
    expect(seen[0]!.recoveryPublicKey).toBe(h.service.state.exchanges[0]!.encryptionKey.publicKey);
    // The device reservation and the private key commit in the same write, never one without the other.
    expect(h.store.state.writes.slice(0, 2)).toEqual([{ phase: 'pending', key: false }, { phase: 'keyed', key: true }]);
    expect(h.store.state.writes.filter(write => write.phase === 'keyed' && !write.key)).toEqual([]);
  });

  it('keeps private key material out of the record, results and logs', async () => {
    const h = await approvedAndJournaled();
    h.service.state.loseNextAckResponse = false;
    h.service.state.ackResult = 'unavailable';
    const logged: unknown[] = [];
    const original = { log: console.log, error: console.error, warn: console.warn };
    console.log = console.error = console.warn = (...args: unknown[]) => { logged.push(args); };
    let result;
    try {
      result = await h.activate();
    } finally {
      Object.assign(console, original);
    }
    const key = h.store.key()!;
    const encoded = [Buffer.from(key).toString('base64url'), Buffer.from(key).toString('base64'), Buffer.from(key).toString('hex')];
    const visible = JSON.stringify([result, h.store.record(), logged, h.service.state.exchanges]);
    for (const form of encoded) expect(visible).not.toContain(form);
    expect(visible).not.toContain(h.service.state.stored!.grant);
    expect(visible).not.toContain('adapter-capability-secret');
    expect(logged).toEqual([]);
  });

  // Wrong-implementation test (contract RD5B): an owner-approved request with no
  // connector activation acknowledgment must never report `connected`.
  it('never reports connected for an approved request whose readiness was not acknowledged', async () => {
    const h = await approvedAndJournaled();
    h.service.state.ackResult = 'unavailable';
    const result = await h.activate();
    expect(result).toEqual({ kind: 'unavailable', retryable: true });
    expect(h.store.record().phase).toBe('activated');
    expect(h.service.state.status).not.toBe('connected');
    // Even with the device ready and the envelope recovered, a restart still cannot claim it.
    expect(await resumeChannelAccessActivations(h.ports)).toEqual([{ operationId: OPERATION, result: { kind: 'unavailable', retryable: true } }]);
    expect(h.store.record().phase).toBe('activated');
    h.service.state.ackResult = null;
    expect(await h.activate()).toMatchObject({ kind: 'connected', reused: false });
  });

  it('never reports connected without local activation, even when the service already did', async () => {
    const h = await approvedAndJournaled({ activate: () => ({ kind: 'unavailable' }) });
    h.service.state.status = 'approved';
    expect(await h.activate()).toEqual({ kind: 'unavailable', retryable: true });
    expect(h.service.state.acks).toHaveLength(0);
    expect(h.store.record().phase).toBe('admitted');
  });

  it('waits while the connector is online but the owner has not decided, with bounded jittered backoff', async () => {
    const h = harness();
    await h.journal();
    expect(await h.activate()).toEqual({ kind: 'pending', outcome: 'pending_owner' });
    expect(h.sleeps).toEqual([750, 1_500]);
    expect(h.devices.reserved.size).toBe(0);
    expect(h.store.key()).toBeNull();
    const polling = DEFAULT_ACTIVATION_POLLING;
    expect(backoff(0, polling, () => 0)).toBe(500);
    expect(backoff(0, polling, () => 0.999999)).toBeLessThanOrEqual(1_000);
    expect(backoff(20, polling, () => 0)).toBe(30_000);
    expect(backoff(20, polling, () => 1)).toBe(60_000);
  });

  it('activates after approval that happened while the connector was offline, resuming after restart', async () => {
    const h = harness();
    await h.journal();
    // Connector offline: nothing runs while the owner approves.
    h.service.state.status = 'approved';
    // Restart: a fresh port set over the same durable journal resumes the operation.
    const resumed = await resumeChannelAccessActivations(h.ports);
    expect(resumed).toEqual([{ operationId: OPERATION, result: { kind: 'connected', binding: bindingFor('device_1'), reused: false } }]);
    expect(await resumeChannelAccessActivations(h.ports)).toEqual([]);
  });

  it('restarts from approved without reserving a second device or key', async () => {
    const h = await approvedAndJournaled();
    h.service.state.status = 'approved';
    // The exchange cannot answer yet; the durable tuple is already fixed.
    h.ports.exchange = { ...h.ports.exchange, exchange: async () => ({ kind: 'unavailable' }) };
    expect(await h.activate()).toEqual({ kind: 'unavailable', retryable: true });
    const keyed = h.store.record();
    expect(keyed.phase).toBe('keyed');
    expect(h.store.key()).not.toBeNull();
    // Restart: the same durable journal, with the exchange reachable again.
    const result = await activateChannelAccess(OPERATION, { ...h.ports, exchange: h.service.exchange });
    expect(result).toMatchObject({ kind: 'connected' });
    expect(h.service.state.exchanges[0]!.encryptionKey.thumbprint).toBe(keyed.recoveryKeyThumbprint);
    expect(h.devices.reserved.size).toBe(1);
  });

  it('recovers the identical stored envelope after a lost exchange response, without resealing', async () => {
    const h = await approvedAndJournaled();
    h.service.state.loseNextExchangeResponse = true;
    expect(await h.activate()).toMatchObject({ kind: 'connected' });
    expect(h.service.state.exchanges).toHaveLength(2);
    expect(h.service.state.seals).toBe(1);
    expect(h.service.state.exchanges[1]!.encryptionKey).toEqual(h.service.state.exchanges[0]!.encryptionKey);
  });

  it('recovers after a crash between admission and activation by redeeming the same recovered grant', async () => {
    let crash = true;
    const h = await approvedAndJournaled({
      activate: () => {
        if (crash) throw new Error('process died');
        return { kind: 'ready' };
      },
    });
    expect(await h.activate()).toEqual({ kind: 'unavailable', retryable: true });
    expect(h.store.record()).toMatchObject({ phase: 'admitted', binding: bindingFor('device_1') });
    crash = false;
    expect(await h.activate()).toMatchObject({ kind: 'connected', reused: false });
    expect(h.service.state.seals).toBe(1);
    expect(new Set(h.service.state.redeems).size).toBe(1);
  });

  it('rotates a recovery key lost before the exchange sealed anything', async () => {
    const h = await approvedAndJournaled();
    h.ports.exchange = { ...h.service.exchange, exchange: async () => ({ kind: 'unavailable' }) };
    await h.activate();
    const first = h.store.record().recoveryKeyThumbprint;
    h.store.dropKey();
    h.ports.exchange = h.service.exchange;
    expect(await h.activate()).toMatchObject({ kind: 'connected' });
    const used = h.service.state.exchanges.at(-1)!.encryptionKey.thumbprint;
    expect(used).not.toBe(first);
    expect(h.service.state.seals).toBe(1);
  });

  it('is repair_required without reminting when the recovery key is lost after consumption', async () => {
    const h = await approvedAndJournaled();
    h.service.state.loseNextExchangeResponse = true;
    h.ports.polling = { ...DEFAULT_ACTIVATION_POLLING, maxAttempts: 1 };
    expect(await h.activate()).toEqual({ kind: 'unavailable', retryable: true });
    expect(h.service.state.seals).toBe(1);
    h.store.dropKey();
    h.ports.polling = { ...DEFAULT_ACTIVATION_POLLING, maxAttempts: 3 };
    expect(await h.activate()).toEqual({ kind: 'repair_required', reason: 'recovery_key_lost' });
    expect(h.store.record()).toMatchObject({ phase: 'repair_required', repair: 'recovery_key_lost', deviceId: 'device_1' });
    // A repair request cannot recover it either, and nothing is sealed or admitted again.
    expect(await h.activate({ repair: true })).toEqual({ kind: 'repair_required', reason: 'recovery_key_lost' });
    expect(h.service.state.seals).toBe(1);
    expect(h.service.state.redeems).toHaveLength(0);
  });

  it('treats a stored private key that does not match the recorded public key as lost', async () => {
    const h = await approvedAndJournaled();
    h.service.state.loseNextExchangeResponse = true;
    h.ports.polling = { ...DEFAULT_ACTIVATION_POLLING, maxAttempts: 1 };
    await h.activate();
    await sodium.ready;
    h.store.rows.get(OPERATION)!.key = sodium.crypto_box_keypair().privateKey;
    h.ports.polling = { ...DEFAULT_ACTIVATION_POLLING, maxAttempts: 3 };
    expect(await h.activate()).toEqual({ kind: 'repair_required', reason: 'recovery_key_lost' });
    expect(h.service.state.seals).toBe(1);
  });

  it('rejects a tampered envelope and every sealed-context mismatch before activation', async () => {
    const flip = (envelope: SealedGrantEnvelope) => {
      const bytes = Buffer.from(envelope.ciphertext, 'base64url');
      bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 1, bytes.length - 1);
      return { ...envelope, ciphertext: bytes.toString('base64url') };
    };
    const cases: [string, Partial<{ tamper: (e: SealedGrantEnvelope) => unknown; payload: Record<string, unknown> }>, string][] = [
      ['ciphertext bit flip', { tamper: flip }, 'envelope_rejected'],
      ['truncated ciphertext', { tamper: e => ({ ...e, ciphertext: e.ciphertext.slice(0, 64) }) }, 'envelope_rejected'],
      ['unknown version', { tamper: e => ({ ...e, v: 2 }) }, 'envelope_rejected'],
      ['unknown algorithm', { tamper: e => ({ ...e, algorithm: 'hpke_x25519' }) }, 'envelope_rejected'],
      ['extra envelope field', { tamper: e => ({ ...e, grant: 'cagrant_x' }) }, 'envelope_rejected'],
      ['other recipient thumbprint', { tamper: e => ({ ...e, recipientKeyThumbprint: 'A'.repeat(43) }) }, 'envelope_rejected'],
      ['other operation', { payload: { operationId: 'op_access_2' } }, 'envelope_rejected'],
      ['other requester', { payload: { requester: 'principal_2' } }, 'envelope_rejected'],
      ['other origin', { payload: { origin: 'https://other.example' } }, 'envelope_rejected'],
      ['other generation', { payload: { sessionGeneration: 4 } }, 'envelope_rejected'],
      ['other device', { payload: { deviceId: 'device_9' } }, 'envelope_rejected'],
      ['other proof key', { payload: { proofKeyThumbprint: 'A'.repeat(43) } }, 'envelope_rejected'],
      ['other sealed recipient', { payload: { recipientKeyThumbprint: 'A'.repeat(43) } }, 'envelope_rejected'],
      ['expired grant', { payload: { expiresAt: new Date(T0 - 1_000).toISOString() } }, 'grant_expired'],
    ];
    for (const [name, change, reason] of cases) {
      const h = await approvedAndJournaled();
      h.service.state.tamper = change.tamper ?? null;
      h.service.state.payload = change.payload ?? {};
      expect([name, await h.activate()]).toEqual([name, { kind: 'repair_required', reason }]);
      expect(h.service.state.redeems).toHaveLength(0);
      expect(h.devices.activations).toBe(0);
      expect(h.service.state.acks).toHaveLength(0);
    }
  });

  it('repairs a tampered delivery by recovering the same stored envelope, never a new grant', async () => {
    const h = await approvedAndJournaled();
    h.service.state.tamper = envelope => ({ ...envelope, ciphertext: envelope.ciphertext.slice(0, 64) });
    expect(await h.activate()).toEqual({ kind: 'repair_required', reason: 'envelope_rejected' });
    h.service.state.tamper = null;
    // Without an explicit repair, the state is reported as-is.
    expect(await h.activate()).toEqual({ kind: 'repair_required', reason: 'envelope_rejected' });
    expect(await h.activate({ repair: true })).toMatchObject({ kind: 'connected' });
    expect(h.service.state.seals).toBe(1);
    expect(h.devices.reserved.size).toBe(1);
  });

  it('is repair_required on a deterministic activation failure and resumes the same device on repair', async () => {
    let fail = true;
    const h = await approvedAndJournaled({
      activate: () => (fail ? { kind: 'failed', reason: 'initialization_failed' } : { kind: 'ready' }),
    });
    expect(await h.activate()).toEqual({ kind: 'repair_required', reason: 'activation_failed' });
    expect(h.store.record()).toMatchObject({ phase: 'repair_required', deviceId: 'device_1', binding: bindingFor('device_1') });
    expect(h.store.key()).not.toBeNull();
    expect(h.service.state.acks).toHaveLength(0);
    expect(h.service.state.status).toBe('connecting');
    // A repeated failure during repair is reported once, not retried in a loop.
    expect(await h.activate({ repair: true })).toEqual({ kind: 'repair_required', reason: 'activation_failed' });
    expect(h.devices.activations).toBe(2);
    fail = false;
    expect(await h.activate({ repair: true })).toEqual({ kind: 'connected', binding: bindingFor('device_1'), reused: false });
    expect(h.devices.reserved.size).toBe(1);
    expect(h.service.state.seals).toBe(1);
  });

  it('requires the review, unpaused trust baseline before readiness', async () => {
    for (const trust of [
      { kind: 'initialized', mode: 'auto', paused: false },
      { kind: 'initialized', mode: 'review', paused: true },
      { kind: 'failed' },
    ] as const) {
      const h = await approvedAndJournaled({ trust: () => trust });
      expect(await h.activate()).toEqual({ kind: 'repair_required', reason: 'activation_failed' });
      expect(h.service.state.acks).toHaveLength(0);
    }
  });

  it('rejects a redeemed binding or capability for another device, generation or scope', async () => {
    for (const capability of [
      { bindingId: 'bnd_2' },
      { generation: 4 },
      { expiresAt: T0 - 1 },
      { scope: ['publish_own', 'receive_released', 'ack_delivery', 'approve'] as never },
    ]) {
      const h = await approvedAndJournaled();
      h.service.state.redeemCapability = capability;
      expect(await h.activate()).toEqual({ kind: 'repair_required', reason: 'admission_refused' });
      expect(h.devices.activations).toBe(0);
    }
    const revoked = await approvedAndJournaled();
    revoked.service.state.redeemRefusal = 'binding_revoked';
    expect(await revoked.activate()).toEqual({ kind: 'closed', outcome: 'revoked' });
  });

  it('treats a duplicate readiness acknowledgement as the same connection', async () => {
    const h = await approvedAndJournaled();
    h.service.state.loseNextAckResponse = true;
    expect(await h.activate()).toMatchObject({ kind: 'connected', reused: false });
    expect(h.service.state.acks).toHaveLength(2);
    expect(h.service.state.status).toBe('connected');
  });

  it('closes on denial, expiry, revocation and a closed exchange, dropping the recovery key', async () => {
    for (const status of ['denied', 'expired', 'revoked'] as const) {
      const h = harness();
      await h.journal();
      h.service.state.status = status;
      expect(await h.activate()).toEqual({ kind: 'closed', outcome: status });
      expect(h.devices.reserved.size).toBe(0);
    }
    const h = await approvedAndJournaled();
    h.ports.exchange = { ...h.service.exchange, exchange: async () => ({ kind: 'rejected', code: 'closed' }) };
    expect(await h.activate()).toEqual({ kind: 'closed', outcome: 'closed' });
    expect(h.store.key()).toBeNull();
    expect(await resumeChannelAccessActivations(h.ports)).toEqual([]);
  });

  it('collapses unknown status to unavailable and never reserves on it', async () => {
    const h = harness();
    await h.journal();
    h.service.state.status = 'unavailable';
    expect(await h.activate()).toEqual({ kind: 'unavailable', retryable: true });
    h.ports.status = { inspect: async () => { throw new Error('secret transport detail'); } };
    expect(await h.activate()).toEqual({ kind: 'unavailable', retryable: true });
    expect(h.devices.reserved.size).toBe(0);
  });

  it('reports a connected device that stopped being ready as repair_required, not connected', async () => {
    const h = await approvedAndJournaled();
    await h.activate();
    h.devices.statusOverride = 'missing';
    expect(await h.activate()).toEqual({ kind: 'repair_required', reason: 'activation_failed' });
  });

  it('refuses a journaled record whose phase invariants do not hold', () => {
    const base = {
      v: 1, operationId: OPERATION, requester: REQUESTER, origin: ORIGIN, sessionGeneration: 3, proofKeyThumbprint: signer.jkt,
      phase: 'pending', deviceId: null, recoveryPublicKey: null, recoveryKeyThumbprint: null, binding: null, repair: null, closed: null,
    };
    expect(decodeActivationRecord(base)).toEqual(base);
    expect(decodeActivationRecord({ ...base, phase: 'connected' })).toBeNull();
    expect(decodeActivationRecord({ ...base, phase: 'keyed' })).toBeNull();
    expect(decodeActivationRecord({ ...base, privateKey: 'x' })).toBeNull();
    expect(decodeActivationRecord({ ...base, phase: 'closed' })).toBeNull();
    expect(decodeActivationRecord({ ...base, phase: 'closed', closed: 'denied' })).toMatchObject({ phase: 'closed' });
  });
});
