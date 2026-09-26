// Port-level tests for the bootstrap choreography. Doubles prove module
// behaviour only; real ownership, storage and harness proof belongs to KHA-133/139.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SessionBinding } from '@khala/contracts/messaging/index';
import { type HarnessCapabilities, unknownModeSupportMap } from '@khala/contracts/delivery/index';
import { type BootstrapInput, type PairingBootstrapInput, bootstrapAgent, operationFingerprint } from './orchestrator';
import type {
  AdapterCapability, AdmissionOutcome, BootstrapPorts, DeviceActivation, OperationRecord, OwnershipOutcome, PairingOutcome,
  PairingOwnershipPort, SessionInspection,
} from './ports';
import type { DiscoveryResult, PairingDiscoveryResult } from './discovery';
import {
  AUTHORIZE_PATH, PAIRING_CLAIM_PATH, PAIRING_RESULT_PATH, REDEEM_PATH, TOKEN_PATH, type PairingDescriptor,
} from './descriptor';
import { sessionEvidenceDigest } from './pairing';

const ORIGIN = 'https://khala.example';
const T0 = Date.parse('2026-09-18T12:00:00Z');
const INPUT: BootstrapInput = {
  channelUrl: `${ORIGIN}/i/room-invite`,
  session: { harness: 'codex', sessionId: 'thread-existing-b', workdir: '/work/b' },
  operationId: 'bootstrap-b-1',
};
const LEGACY_INPUT: BootstrapInput = {
  chatUrl: INPUT.channelUrl,
  session: INPUT.session,
  operationId: INPUT.operationId,
};
const DESCRIPTOR = {
  v: 1 as const, invite: 'room-invite', methods: ['loopback-browser-v1' as const],
  authorize: `${ORIGIN}${AUTHORIZE_PATH}`, token: `${ORIGIN}${TOKEN_PATH}`, redeem: `${ORIGIN}${REDEEM_PATH}`,
};
const SESSION = { harness: 'codex', sessionId: 'thread-existing-b', generation: 3 };
const CAPABILITIES: HarnessCapabilities = {
  v: 3, harness: 'codex', version: '1.0.0', adapterVersion: '1', support: 'tested', existingSession: 'khala_hosted_resume',
  immediateNotification: 'khala_hosted_idle', busy: 'queue', receiptEvidence: [], reconcileByReleaseId: 'unknown',
  limits: { maxPayloadBytes: 1024, maxBatchItems: 1 } as never, evidenceRef: 'docs/evidence/codex.md',
  modes: unknownModeSupportMap('test-codex-interactive', 'Test fixture has no primary mode proof.', '1.0.0'),
  acknowledgement: 'unknown',
};

function bindingFor(deviceId: string, generation = 3): SessionBinding {
  return {
    v: 1, bindingId: 'bnd_1' as never, ownerId: 'owner_b' as never, agentParticipantId: 'agent_b' as never,
    deviceId: deviceId as never, harness: 'codex', sessionId: 'thread-existing-b', generation,
  };
}

function capabilityFor(overrides: Partial<AdapterCapability> = {}): AdapterCapability {
  return { token: 'adapter-capability-secret', scope: ['publish_own', 'receive_released', 'ack_delivery'], bindingId: 'bnd_1', generation: 3, expiresAt: T0 + 3_600_000, ...overrides };
}

/** Wires doubles; each field can be overridden per test. Counts every side effect. */
function harness(overrides: {
  discovery?: () => DiscoveryResult;
  inspect?: () => SessionInspection;
  prove?: (deviceId: string) => OwnershipOutcome;
  redeem?: (deviceId: string) => AdmissionOutcome;
  activate?: () => DeviceActivation;
  saveFails?: () => boolean;
} = {}) {
  const records = new Map<string, { record: OperationRecord; revision: number }>();
  const readyDevices = new Set<string>();
  const counts = { reserve: 0, prove: 0, redeem: 0, activate: 0, admittedDevices: new Set<string>() };
  let nextDevice = 0;
  const ports: BootstrapPorts = {
    clock: () => T0,
    discovery: { resolve: async () => overrides.discovery?.() ?? { kind: 'resolved', origin: ORIGIN, descriptor: DESCRIPTOR } },
    sessions: { inspect: async () => overrides.inspect?.() ?? { kind: 'verified', session: SESSION, capabilities: CAPABILITIES } },
    ownership: {
      methods: ['loopback-browser-v1'],
      async prove({ deviceId }) {
        counts.prove++;
        return overrides.prove?.(deviceId) ?? {
          kind: 'granted',
          grant: { method: 'loopback-browser-v1', redeem: DESCRIPTOR.redeem, session: SESSION, deviceId, expiresAt: T0 + 60_000, secret: 'grant-secret-value' },
        };
      },
    },
    admission: {
      async redeem({ grant }) {
        counts.redeem++;
        counts.admittedDevices.add(grant.deviceId);
        return overrides.redeem?.(grant.deviceId) ?? {
          kind: 'admitted', binding: bindingFor(grant.deviceId), capability: capabilityFor(),
        };
      },
    },
    devices: {
      async reserve() {
        counts.reserve++;
        return { kind: 'reserved', deviceId: `KHALADEV${++nextDevice}` };
      },
      async activate({ deviceId }) {
        counts.activate++;
        const result = overrides.activate?.() ?? { kind: 'ready' };
        if (result.kind === 'ready') readyDevices.add(deviceId);
        return result;
      },
      async status(deviceId) {
        return readyDevices.has(deviceId) ? 'ready' : 'incomplete';
      },
    },
    operations: {
      async load(operationId) {
        const entry = records.get(operationId);
        return entry ? { kind: 'record', record: entry.record, revision: entry.revision } : { kind: 'absent' };
      },
      async save(record, expected) {
        if (overrides.saveFails?.()) return { kind: 'unavailable' };
        const current = records.get(record.operationId);
        if ((current?.revision ?? null) !== expected) return { kind: 'conflict' };
        const revision = (current?.revision ?? 0) + 1;
        records.set(record.operationId, { record, revision });
        return { kind: 'saved', revision };
      },
    },
  };
  return { ports, counts, records, readyDevices };
}

describe('bootstrapAgent', () => {
  it('preserves the established fingerprint bytes for canonical and legacy links', () => {
    expect(operationFingerprint(INPUT)).toBe('VQzXYp6ofh66QHUcN6dN4_qDqVGpB3u8lY1iBKEayWg');
    expect(operationFingerprint(LEGACY_INPUT)).toBe(operationFingerprint(INPUT));
  });

  it('accepts the legacy chatUrl input and normalizes it for discovery', async () => {
    const { ports } = harness();
    let discovered = '';
    const result = await bootstrapAgent(LEGACY_INPUT, {
      ...ports,
      discovery: {
        async resolve(channelUrl) {
          discovered = channelUrl;
          return { kind: 'resolved', origin: ORIGIN, descriptor: DESCRIPTOR };
        },
      },
    });

    expect(result).toMatchObject({ kind: 'connected' });
    expect(discovered).toBe(INPUT.channelUrl);
  });

  it('connects the existing session through its own device after ownership and admission', async () => {
    const { ports, counts, records } = harness();
    const result = await bootstrapAgent(INPUT, ports);
    expect(result).toEqual({ kind: 'connected', binding: bindingFor('KHALADEV1'), reused: false });
    expect(records.get(INPUT.operationId)?.record.phase).toBe('connected');
    expect(counts).toMatchObject({ reserve: 1, prove: 1, redeem: 1, activate: 1 });
  });

  it('admits a tested native CLI queue route with evidence', async () => {
    const { ports, counts } = harness({
      inspect: () => ({
        kind: 'verified',
        session: SESSION,
        capabilities: { ...CAPABILITIES, existingSession: 'native_cli_queue', immediateNotification: 'native_cli_queue' },
      }),
    });
    expect(await bootstrapAgent(INPUT, ports)).toMatchObject({ kind: 'connected' });
    expect(counts).toMatchObject({ reserve: 1, prove: 1, redeem: 1, activate: 1 });
  });

  it('admits the experimental agent listener only with an explicit opt-in', async () => {
    const listener: HarnessCapabilities = {
      ...CAPABILITIES,
      support: 'experimental',
      existingSession: 'agent_installed_listener',
      immediateNotification: 'agent_installed_listener',
      busy: 'unknown',
      evidenceRef: null,
    };
    const { ports, counts } = harness({
      inspect: () => ({ kind: 'verified', session: SESSION, capabilities: listener }),
    });
    expect(await bootstrapAgent(INPUT, { ...ports, allowExperimentalAgentListener: true })).toMatchObject({ kind: 'connected' });
    expect(counts).toMatchObject({ reserve: 1, prove: 1, redeem: 1, activate: 1 });
  });

  it('refuses the experimental agent listener by default', async () => {
    const { ports, counts } = harness({
      inspect: () => ({
        kind: 'verified',
        session: SESSION,
        capabilities: {
          ...CAPABILITIES,
          support: 'experimental',
          existingSession: 'agent_installed_listener',
          immediateNotification: 'agent_installed_listener',
          busy: 'unknown',
          evidenceRef: null,
        },
      }),
    });
    expect(await bootstrapAgent(INPUT, ports)).toEqual({ kind: 'blocked', code: 'unsupported_harness' });
    expect(counts).toMatchObject({ reserve: 0, prove: 0, redeem: 0 });
  });

  it('AE1: a retry after a lost response returns the recorded binding without admitting again', async () => {
    const { ports, counts } = harness();
    const first = await bootstrapAgent(INPUT, ports);
    const second = await bootstrapAgent(INPUT, ports);
    expect(second).toEqual({ kind: 'connected', binding: (first as { binding: SessionBinding }).binding, reused: true });
    expect(counts).toMatchObject({ reserve: 1, prove: 1, redeem: 1, activate: 1 });
  });

  it('AE1: an unknown admission outcome is retried on the same reserved device', async () => {
    let lose = true;
    const { ports, counts } = harness({
      redeem: deviceId => {
        if (lose) {
          lose = false;
          return { kind: 'outcome_unknown' };
        }
        return { kind: 'admitted', binding: bindingFor(deviceId), capability: capabilityFor() };
      },
    });
    expect(await bootstrapAgent(INPUT, ports)).toEqual({ kind: 'unavailable', retryable: true, operationId: INPUT.operationId });
    const retried = await bootstrapAgent(INPUT, ports);
    expect(retried).toMatchObject({ kind: 'connected', reused: false });
    expect(counts.reserve).toBe(1);
    expect([...counts.admittedDevices]).toEqual(['KHALADEV1']);
  });

  it('keeps a failed device reserved for repair and never mints another', async () => {
    let fail = true;
    const { ports, counts, records } = harness({ activate: () => (fail ? { kind: 'failed', reason: 'storage_unavailable' } : { kind: 'ready' }) });
    expect(await bootstrapAgent(INPUT, ports)).toEqual({ kind: 'blocked', code: 'device_unavailable' });
    const repair = records.get(INPUT.operationId)?.record;
    expect(repair).toMatchObject({ phase: 'repair_required', deviceId: 'KHALADEV1', binding: bindingFor('KHALADEV1') });
    expect(JSON.stringify(repair)).not.toContain('secret');
    fail = false;
    expect(await bootstrapAgent(INPUT, ports)).toMatchObject({ kind: 'connected', binding: bindingFor('KHALADEV1') });
    expect(counts.reserve).toBe(1);
    expect([...counts.admittedDevices]).toEqual(['KHALADEV1']);
  });

  it('refuses to reuse an operation ID for a different link or session', async () => {
    const { ports } = harness();
    await bootstrapAgent(INPUT, ports);
    const other = { ...INPUT, session: { ...INPUT.session, sessionId: 'thread-other' } };
    expect(await bootstrapAgent(other, ports)).toEqual({ kind: 'blocked', code: 'operation_conflict' });
    expect(await bootstrapAgent({ ...INPUT, channelUrl: `${ORIGIN}/i/other` }, ports)).toEqual({ kind: 'blocked', code: 'operation_conflict' });
  });

  it('reports an unsupported or missing harness before any owner-facing step', async () => {
    for (const [inspection, code] of [
      [{ kind: 'unsupported' }, 'unsupported_harness'],
      [{ kind: 'missing' }, 'harness_session_missing'],
      [{ kind: 'verified', session: SESSION, capabilities: { ...CAPABILITIES, existingSession: 'unknown' } }, 'unsupported_harness'],
      [{ kind: 'verified', session: SESSION, capabilities: { ...CAPABILITIES, support: 'unsupported' } }, 'unsupported_harness'],
      [{ kind: 'verified', session: SESSION, capabilities: { ...CAPABILITIES, support: 'experimental' } }, 'unsupported_harness'],
      [{ kind: 'verified', session: SESSION, capabilities: { ...CAPABILITIES, evidenceRef: null } }, 'unsupported_harness'],
      [{ kind: 'verified', session: SESSION, capabilities: { ...CAPABILITIES, immediateNotification: 'unknown' } }, 'unsupported_harness'],
      [{ kind: 'verified', session: { ...SESSION, sessionId: 'thread-someone-else' }, capabilities: CAPABILITIES }, 'unsupported_harness'],
    ] as const) {
      const { ports, counts } = harness({ inspect: () => inspection as SessionInspection });
      expect(await bootstrapAgent(INPUT, ports)).toEqual({ kind: 'blocked', code });
      expect(counts).toMatchObject({ reserve: 0, prove: 0, redeem: 0 });
    }
  });

  it('R1: an untrusted link is refused before anything else happens', async () => {
    const { ports, counts } = harness({ discovery: () => ({ kind: 'rejected', code: 'untrusted_origin' }) });
    expect(await bootstrapAgent(INPUT, ports)).toEqual({ kind: 'blocked', code: 'untrusted_origin' });
    expect(counts).toMatchObject({ reserve: 0, prove: 0 });
  });

  it('AE2: a forwarded link held by someone who is not the owner never binds', async () => {
    const { ports, counts } = harness({ prove: () => ({ kind: 'refused', code: 'ownership_required' }) });
    expect(await bootstrapAgent(INPUT, ports)).toEqual({ kind: 'blocked', code: 'ownership_required' });
    expect(counts.redeem).toBe(0);
  });

  it('rejects a grant for another session, device, endpoint or an expired grant', async () => {
    const grants = [
      { session: { ...SESSION, generation: 4 } },
      { deviceId: 'KHALADEV-OTHER' },
      { redeem: 'https://evil.example/api/agent/bootstrap/redeem' },
      { expiresAt: T0 },
    ];
    for (const change of grants) {
      const { ports, counts } = harness({
        prove: deviceId => ({
          kind: 'granted',
          grant: { method: 'loopback-browser-v1', redeem: DESCRIPTOR.redeem, session: SESSION, deviceId, expiresAt: T0 + 60_000, secret: 'x', ...change },
        }),
      });
      expect(await bootstrapAgent(INPUT, ports)).toEqual({ kind: 'blocked', code: 'ownership_required' });
      expect(counts.redeem).toBe(0);
    }
  });

  it('AE2: rejects a binding for another device or session and service refusals', async () => {
    const wrong = [
      (deviceId: string): AdmissionOutcome => ({ kind: 'admitted', binding: bindingFor(`${deviceId}X`), capability: capabilityFor() }),
      (deviceId: string): AdmissionOutcome => ({ kind: 'admitted', binding: bindingFor(deviceId, 9), capability: capabilityFor() }),
      (): AdmissionOutcome => ({ kind: 'admitted', binding: { v: 1 } as never, capability: capabilityFor() }),
    ];
    for (const redeem of wrong) {
      const { ports, counts } = harness({ redeem });
      expect(await bootstrapAgent(INPUT, ports)).toEqual({ kind: 'blocked', code: 'admission_denied' });
      expect(counts.activate).toBe(0);
    }
    for (const code of ['binding_conflict', 'binding_revoked'] as const) {
      const { ports } = harness({ redeem: () => ({ kind: 'refused', code }) });
      expect(await bootstrapAgent(INPUT, ports)).toEqual({ kind: 'blocked', code });
    }
  });

  it('refuses a capability for another binding or generation, or already expired, before activating', async () => {
    for (const change of [{ bindingId: 'bnd_other' }, { generation: 4 }, { expiresAt: T0 }]) {
      const { ports, counts } = harness({
        redeem: deviceId => ({ kind: 'admitted', binding: bindingFor(deviceId), capability: capabilityFor(change) }),
      });
      expect(await bootstrapAgent(INPUT, ports)).toEqual({ kind: 'blocked', code: 'admission_denied' });
      expect(counts.activate).toBe(0);
    }
  });

  it('hands the device port exactly the capability for its binding', async () => {
    let received: unknown = null;
    const { ports } = harness();
    const devices = { ...ports.devices, activate: async (input: Parameters<typeof ports.devices.activate>[0]) => {
      received = input.capability;
      return ports.devices.activate(input);
    } };
    expect(await bootstrapAgent(INPUT, { ...ports, devices })).toMatchObject({ kind: 'connected' });
    expect(received).toEqual(capabilityFor());
  });

  it('does not rebind a recorded binding to a new session generation on reconnect', async () => {
    let generation = 3;
    let ready = true;
    const { ports, readyDevices } = harness({
      inspect: () => ({ kind: 'verified', session: { ...SESSION, generation }, capabilities: CAPABILITIES }),
      activate: () => (ready ? { kind: 'ready' } : { kind: 'failed', reason: 'initialization_failed' }),
    });
    await bootstrapAgent(INPUT, ports);
    readyDevices.clear();
    ready = false;
    generation = 4;
    expect(await bootstrapAgent(INPUT, ports)).toEqual({ kind: 'blocked', code: 'binding_conflict' });
  });

  it('writes nothing and admits nothing when the ledger cannot record the device first', async () => {
    const { ports, counts } = harness({ saveFails: () => true });
    expect(await bootstrapAgent(INPUT, ports)).toMatchObject({ kind: 'unavailable', retryable: true });
    expect(counts).toMatchObject({ prove: 0, redeem: 0 });
  });

  it('turns a throwing port into a retryable result without its message', async () => {
    const { ports } = harness();
    const throwing = { ...ports, sessions: { inspect: async () => { throw new Error('token=abc secret path'); } } };
    const result = await bootstrapAgent(INPUT, throwing);
    expect(result).toEqual({ kind: 'unavailable', retryable: true, operationId: INPUT.operationId });
  });

  it('never returns the grant or the adapter capability', async () => {
    const { ports } = harness();
    const text = JSON.stringify(await bootstrapAgent(INPUT, ports));
    expect(text).not.toContain('grant-secret-value');
    expect(text).not.toContain('adapter-capability-secret');
  });

  it('validates input before any port is used', async () => {
    const { ports, counts } = harness();
    for (const bad of [
      { ...INPUT, operationId: 'short' },
      { ...INPUT, session: { ...INPUT.session, harness: 'Codex!' } },
      { ...INPUT, session: { ...INPUT.session, sessionId: 'a\nb' } },
      { ...INPUT, session: { ...INPUT.session, workdir: '' } },
      { ...INPUT, chatUrl: INPUT.channelUrl } as unknown as BootstrapInput,
      { session: INPUT.session, operationId: INPUT.operationId } as unknown as BootstrapInput,
    ]) {
      expect(await bootstrapAgent(bad, ports)).toEqual({ kind: 'blocked', code: 'invalid_request' });
    }
    expect(counts.reserve).toBe(0);
  });
});

const PAIR_CODE = '7K3QX-9MZ2P';
const PAIR_INPUT: PairingBootstrapInput = {
  pairingCode: PAIR_CODE,
  session: { harness: 'codex', sessionId: 'thread-existing-b', workdir: '/work/b' },
  operationId: 'pairing-b-1',
};
const PAIR_DESCRIPTOR: PairingDescriptor = {
  v: 1, claim: `${ORIGIN}${PAIRING_CLAIM_PATH}`, result: `${ORIGIN}${PAIRING_RESULT_PATH}`, redeem: `${ORIGIN}${REDEEM_PATH}`, id: 'pairing-descriptor-1',
};
const PAIR_JKT = 'k'.repeat(43);

type ClaimInput = Parameters<PairingOwnershipPort['claim']>[0];

/** The link harness plus configured-origin discovery and a pairing port double. */
function pairingHarness(overrides: Parameters<typeof harness>[0] & {
  pairingDiscovery?: () => PairingDiscoveryResult;
  claim?: (input: ClaimInput) => PairingOutcome;
  jkt?: string;
} = {}) {
  const base = harness(overrides);
  const claims: ClaimInput[] = [];
  const saved: OperationRecord[] = [];
  const pairing: PairingOwnershipPort = {
    jkt: overrides.jkt ?? PAIR_JKT,
    async claim(input) {
      claims.push(input);
      return overrides.claim?.(input) ?? {
        kind: 'granted',
        grant: { method: 'pairing-code-v1', redeem: PAIR_DESCRIPTOR.redeem, session: input.session, deviceId: input.deviceId, expiresAt: T0 + 60_000, secret: 'pairing-grant-secret' },
      };
    },
  };
  const ports: BootstrapPorts = {
    ...base.ports,
    discovery: {
      ...base.ports.discovery,
      resolvePairing: async () => overrides.pairingDiscovery?.() ?? { kind: 'resolved', origin: ORIGIN, descriptor: PAIR_DESCRIPTOR },
    },
    pairing,
    operations: {
      load: base.ports.operations.load,
      async save(record, expected) {
        saved.push(record);
        return base.ports.operations.save(record, expected);
      },
    },
  };
  return { ...base, ports, claims, saved };
}

describe('bootstrapAgent with pairing-code-v1', () => {
  it('AE2: reserves one device, claims with the inspected session, redeems the approved grant and activates that device', async () => {
    const { ports, counts, claims, records } = pairingHarness();
    const result = await bootstrapAgent(PAIR_INPUT, ports);

    expect(result).toEqual({ kind: 'connected', binding: bindingFor('KHALADEV1'), reused: false });
    expect(counts).toMatchObject({ reserve: 1, prove: 0, redeem: 1, activate: 1 });
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      code: PAIR_CODE, descriptor: PAIR_DESCRIPTOR, session: SESSION, deviceId: 'KHALADEV1', operationId: PAIR_INPUT.operationId,
      evidenceDigest: sessionEvidenceDigest(SESSION, CAPABILITIES),
    });
    expect(records.get(PAIR_INPUT.operationId)?.record).toMatchObject({ phase: 'connected', deviceId: 'KHALADEV1' });
  });

  it('does not persist the old unsalted SHA-256 of the code in the operation fingerprint', async () => {
    const { ports, records } = pairingHarness();
    await bootstrapAgent(PAIR_INPUT, ports);
    const { fingerprint } = records.get(PAIR_INPUT.operationId)!.record;
    const unsalted = createHash('sha256').update(JSON.stringify([
      'khala.pairing.bootstrap.v1', ORIGIN, PAIR_DESCRIPTOR.id,
      createHash('sha256').update(PAIR_CODE).digest('base64url'),
      PAIR_INPUT.session.harness, PAIR_INPUT.session.sessionId, PAIR_INPUT.session.workdir,
      SESSION.generation, PAIR_JKT,
    ])).digest('base64url');
    expect(fingerprint).not.toBe(unsalted);
  });

  it('claims only after inspection and a persisted device reservation', async () => {
    let inspected = false;
    let reservedAtClaim: OperationRecord | undefined;
    const { ports, records } = pairingHarness({
      inspect: () => { inspected = true; return { kind: 'verified', session: SESSION, capabilities: CAPABILITIES }; },
      claim: input => {
        expect(inspected).toBe(true);
        reservedAtClaim = records.get(input.operationId)?.record;
        return { kind: 'refused', code: 'pairing_denied' };
      },
    });
    expect(await bootstrapAgent(PAIR_INPUT, ports)).toEqual({ kind: 'blocked', code: 'pairing_denied' });
    expect(reservedAtClaim).toMatchObject({ phase: 'reserved', deviceId: 'KHALADEV1', binding: null });
  });

  it('AE5: a forged session claim cannot override the inspected session and sends no claim', async () => {
    // The caller names another session; the harness adapter verifies what actually runs there.
    const forged: PairingBootstrapInput = { ...PAIR_INPUT, session: { ...PAIR_INPUT.session, sessionId: 'thread-forged-a' } };
    const { ports, counts, claims } = pairingHarness();
    expect(await bootstrapAgent(forged, ports)).toEqual({ kind: 'blocked', code: 'unsupported_harness' });
    expect(claims).toHaveLength(0);
    expect(counts).toMatchObject({ reserve: 0, redeem: 0 });
  });

  it('AE5: a session inspection cannot find blocks before any claim', async () => {
    const { ports, counts, claims } = pairingHarness({ inspect: () => ({ kind: 'missing' }) });
    expect(await bootstrapAgent(PAIR_INPUT, ports)).toEqual({ kind: 'blocked', code: 'harness_session_missing' });
    expect(claims).toHaveLength(0);
    expect(counts.reserve).toBe(0);
  });

  it('AE3: a lost approval resumes with the same operation, claim and device', async () => {
    let attempt = 0;
    const { ports, counts, claims } = pairingHarness({
      claim: input => (++attempt === 1
        ? { kind: 'pending', reason: 'approval_timeout' }
        : { kind: 'granted', grant: { method: 'pairing-code-v1', redeem: PAIR_DESCRIPTOR.redeem, session: input.session, deviceId: input.deviceId, expiresAt: T0 + 60_000, secret: 'pairing-grant-secret' } }),
    });
    expect(await bootstrapAgent(PAIR_INPUT, ports)).toEqual({
      kind: 'pending', reason: 'approval_timeout', retryable: true, operationId: PAIR_INPUT.operationId,
    });
    expect(await bootstrapAgent(PAIR_INPUT, ports)).toMatchObject({ kind: 'connected', reused: false });
    expect(counts.reserve).toBe(1);
    expect(claims.map(claim => claim.deviceId)).toEqual(['KHALADEV1', 'KHALADEV1']);
    expect(claims[1]).toEqual(claims[0]);
    // A third call after success reports the recorded binding without claiming again.
    expect(await bootstrapAgent(PAIR_INPUT, ports)).toMatchObject({ kind: 'connected', reused: true });
    expect(claims).toHaveLength(2);
  });

  it('AE4: reusing the operation with another generation, key, code, descriptor or origin is a conflict with no admission', async () => {
    const substitutions: { name: string; overrides: Parameters<typeof pairingHarness>[0]; input?: PairingBootstrapInput }[] = [
      { name: 'generation', overrides: { inspect: () => ({ kind: 'verified', session: { ...SESSION, generation: 4 }, capabilities: CAPABILITIES }) } },
      { name: 'key', overrides: { jkt: 'j'.repeat(43) } },
      { name: 'code', overrides: {}, input: { ...PAIR_INPUT, pairingCode: '7K3QX-9MZ2Q' } },
      { name: 'descriptor', overrides: { pairingDiscovery: () => ({ kind: 'resolved', origin: ORIGIN, descriptor: { ...PAIR_DESCRIPTOR, id: 'pairing-descriptor-2' } }) } },
      { name: 'origin', overrides: { pairingDiscovery: () => ({ kind: 'resolved', origin: 'https://preview.khala.example', descriptor: PAIR_DESCRIPTOR }) } },
      { name: 'workdir', overrides: {}, input: { ...PAIR_INPUT, session: { ...PAIR_INPUT.session, workdir: '/work/other' } } },
    ];
    for (const substitution of substitutions) {
      const first = pairingHarness({ claim: () => ({ kind: 'pending', reason: 'approval_timeout' }) });
      expect(await bootstrapAgent(PAIR_INPUT, first.ports)).toMatchObject({ kind: 'pending' });
      const changed = pairingHarness(substitution.overrides);
      const ports: BootstrapPorts = { ...changed.ports, operations: first.ports.operations };
      expect(await bootstrapAgent(substitution.input ?? PAIR_INPUT, ports), substitution.name)
        .toEqual({ kind: 'blocked', code: 'operation_conflict' });
      expect(changed.claims, substitution.name).toHaveLength(0);
      expect(changed.counts, substitution.name).toMatchObject({ reserve: 0, redeem: 0 });
    }
  });

  it('AE6: code refusals are finite and carry no channel, binding, receipt or grant fields', async () => {
    for (const code of ['pairing_refused', 'pairing_denied', 'pairing_expired', 'rate_limited', 'ownership_required'] as const) {
      const { ports, counts } = pairingHarness({ claim: () => ({ kind: 'refused', code }) });
      const result = await bootstrapAgent(PAIR_INPUT, ports);
      expect(result).toEqual({ kind: 'blocked', code });
      expect(counts.redeem).toBe(0);
    }
    const { ports } = pairingHarness({ claim: () => ({ kind: 'pending', reason: 'cancelled' }) });
    expect(await bootstrapAgent(PAIR_INPUT, ports)).toEqual({ kind: 'pending', reason: 'cancelled', retryable: true, operationId: PAIR_INPUT.operationId });
  });

  it('refuses when the connector has no pairing configuration, before any side effect', async () => {
    const { ports, counts } = pairingHarness();
    const withoutPairing: BootstrapPorts = { ...ports };
    delete (withoutPairing as { pairing?: unknown }).pairing;
    expect(await bootstrapAgent(PAIR_INPUT, withoutPairing)).toEqual({ kind: 'blocked', code: 'ownership_required' });
    const withoutDiscovery = { ...ports, discovery: { resolve: ports.discovery.resolve } };
    expect(await bootstrapAgent(PAIR_INPUT, withoutDiscovery)).toEqual({ kind: 'blocked', code: 'ownership_required' });
    expect(counts.reserve).toBe(0);
  });

  it('reports pairing discovery rejections and outages', async () => {
    let t = pairingHarness({ pairingDiscovery: () => ({ kind: 'rejected', code: 'untrusted_origin' }) });
    expect(await bootstrapAgent(PAIR_INPUT, t.ports)).toEqual({ kind: 'blocked', code: 'untrusted_origin' });
    t = pairingHarness({ pairingDiscovery: () => ({ kind: 'unavailable' }) });
    expect(await bootstrapAgent(PAIR_INPUT, t.ports)).toEqual({ kind: 'unavailable', retryable: true, operationId: PAIR_INPUT.operationId });
    expect(t.claims).toHaveLength(0);
  });

  it('validates the code and input shape before any port is used', async () => {
    const { ports, counts, claims } = pairingHarness();
    for (const bad of [
      { ...PAIR_INPUT, pairingCode: '7k3qx-9mz2p' },
      { ...PAIR_INPUT, pairingCode: '7K3QX9MZ2P' },
      { ...PAIR_INPUT, pairingCode: 'IK3QX-9MZ2P' },
      { ...PAIR_INPUT, operationId: 'short' },
      { ...PAIR_INPUT, channelUrl: INPUT.channelUrl } as unknown as PairingBootstrapInput,
    ]) {
      expect(await bootstrapAgent(bad, ports)).toEqual({ kind: 'blocked', code: 'invalid_request' });
    }
    expect(counts.reserve).toBe(0);
    expect(claims).toHaveLength(0);
  });

  it('checks the approved grant exactly as link bootstrap does', async () => {
    const grant = (input: ClaimInput) => ({
      method: 'pairing-code-v1' as const, redeem: PAIR_DESCRIPTOR.redeem, session: input.session, deviceId: input.deviceId, expiresAt: T0 + 60_000, secret: 's',
    });
    for (const tamper of [
      (input: ClaimInput) => ({ ...grant(input), deviceId: 'KHALADEV9' }),
      (input: ClaimInput) => ({ ...grant(input), method: 'loopback-browser-v1' as const }),
      (input: ClaimInput) => ({ ...grant(input), redeem: `https://preview.khala.example${REDEEM_PATH}` }),
      (input: ClaimInput) => ({ ...grant(input), session: { ...SESSION, generation: 2 } }),
      (input: ClaimInput) => ({ ...grant(input), expiresAt: T0 }),
    ]) {
      const { ports, counts } = pairingHarness({ claim: input => ({ kind: 'granted', grant: tamper(input) }) });
      expect(await bootstrapAgent(PAIR_INPUT, ports)).toEqual({ kind: 'blocked', code: 'ownership_required' });
      expect(counts.redeem).toBe(0);
    }
    const stale = pairingHarness({ redeem: deviceId => ({ kind: 'admitted', binding: bindingFor(deviceId), capability: capabilityFor({ generation: 2 }) }) });
    expect(await bootstrapAgent(PAIR_INPUT, stale.ports)).toEqual({ kind: 'blocked', code: 'admission_denied' });
  });

  it('never writes the code, receipt, grant, capability or a response body to the operation ledger', async () => {
    const { ports, saved } = pairingHarness();
    expect(await bootstrapAgent(PAIR_INPUT, ports)).toMatchObject({ kind: 'connected' });
    expect(saved.map(record => record.phase)).toEqual(['reserved', 'admitted', 'connected']);
    for (const record of saved) {
      expect(Object.keys(record).sort()).toEqual(['binding', 'deviceId', 'fingerprint', 'operationId', 'phase', 'v']);
      const text = JSON.stringify(record);
      for (const secret of [PAIR_CODE, PAIR_CODE.replace('-', ''), 'pairing-grant-secret', 'adapter-capability-secret', PAIR_JKT]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it('AE1: a link whose descriptor offers loopback and pairing still uses loopback', async () => {
    const { ports, counts, claims } = pairingHarness({
      discovery: () => ({ kind: 'resolved', origin: ORIGIN, descriptor: { ...DESCRIPTOR, methods: ['pairing-code-v1', 'loopback-browser-v1'] } }),
    });
    const both = { ...ports, ownership: { ...ports.ownership, methods: ['pairing-code-v1', 'loopback-browser-v1'] as const } };
    expect(await bootstrapAgent(INPUT, both)).toMatchObject({ kind: 'connected' });
    expect(counts.prove).toBe(1);
    expect(claims).toHaveLength(0);
    expect(operationFingerprint(INPUT)).toBe('VQzXYp6ofh66QHUcN6dN4_qDqVGpB3u8lY1iBKEayWg');
  });

  it('a link descriptor offering only pairing cannot be completed through a link', async () => {
    const { ports, counts } = pairingHarness({
      discovery: () => ({ kind: 'resolved', origin: ORIGIN, descriptor: { ...DESCRIPTOR, methods: ['pairing-code-v1'] } }),
    });
    expect(await bootstrapAgent(INPUT, ports)).toEqual({ kind: 'blocked', code: 'ownership_required' });
    expect(counts.reserve).toBe(0);
  });
});
