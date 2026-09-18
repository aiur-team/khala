// Port-level tests for the bootstrap choreography. Doubles prove module
// behaviour only; real ownership, storage and harness proof belongs to KHA-133/139.

import { describe, expect, it } from 'vitest';
import type { SessionBinding } from '@khala/contracts/messaging/index';
import type { HarnessCapabilities } from '@khala/contracts/delivery/index';
import { type BootstrapInput, bootstrapAgent } from './orchestrator';
import type {
  AdmissionOutcome, BootstrapPorts, DeviceActivation, OperationRecord, OwnershipOutcome, SessionInspection,
} from './ports';
import type { DiscoveryResult } from './discovery';
import { AUTHORIZE_PATH, REDEEM_PATH, TOKEN_PATH } from './descriptor';

const ORIGIN = 'https://khala.example';
const T0 = Date.parse('2026-09-18T12:00:00Z');
const INPUT: BootstrapInput = {
  chatUrl: `${ORIGIN}/i/room-invite`,
  session: { harness: 'codex', sessionId: 'thread-existing-b', workdir: '/work/b' },
  operationId: 'bootstrap-b-1',
};
const DESCRIPTOR = {
  v: 1 as const, invite: 'room-invite', methods: ['loopback-browser-v1' as const],
  authorize: `${ORIGIN}${AUTHORIZE_PATH}`, token: `${ORIGIN}${TOKEN_PATH}`, redeem: `${ORIGIN}${REDEEM_PATH}`,
};
const SESSION = { harness: 'codex', sessionId: 'thread-existing-b', generation: 3 };
const CAPABILITIES: HarnessCapabilities = {
  v: 1, harness: 'codex', version: '1.0.0', adapterVersion: '1', support: 'experimental', existingSession: 'khala_hosted_resume',
  immediateNotification: 'khala_hosted_idle', busy: 'queue', receiptEvidence: [], reconcileByReleaseId: 'unknown',
  limits: { maxPayloadBytes: 1024, maxBatchItems: 1 } as never, evidenceRef: null,
};

function bindingFor(deviceId: string, generation = 3): SessionBinding {
  return {
    v: 1, bindingId: 'bnd_1' as never, ownerId: 'owner_b' as never, agentParticipantId: 'agent_b' as never,
    deviceId: deviceId as never, harness: 'codex', sessionId: 'thread-existing-b', generation,
  };
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
          kind: 'admitted', binding: bindingFor(grant.deviceId), credential: { secret: 'device-login-secret', expiresAt: T0 + 60_000 },
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
  it('connects the existing session through its own device after ownership and admission', async () => {
    const { ports, counts, records } = harness();
    const result = await bootstrapAgent(INPUT, ports);
    expect(result).toEqual({ kind: 'connected', binding: bindingFor('KHALADEV1'), reused: false });
    expect(records.get(INPUT.operationId)?.record.phase).toBe('connected');
    expect(counts).toMatchObject({ reserve: 1, prove: 1, redeem: 1, activate: 1 });
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
        return { kind: 'admitted', binding: bindingFor(deviceId), credential: { secret: 's', expiresAt: T0 + 1 } };
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
    expect(await bootstrapAgent({ ...INPUT, chatUrl: `${ORIGIN}/i/other` }, ports)).toEqual({ kind: 'blocked', code: 'operation_conflict' });
  });

  it('reports an unsupported or missing harness before any owner-facing step', async () => {
    for (const [inspection, code] of [
      [{ kind: 'unsupported' }, 'unsupported_harness'],
      [{ kind: 'missing' }, 'harness_session_missing'],
      [{ kind: 'verified', session: SESSION, capabilities: { ...CAPABILITIES, existingSession: 'unknown' } }, 'unsupported_harness'],
      [{ kind: 'verified', session: SESSION, capabilities: { ...CAPABILITIES, support: 'unsupported' } }, 'unsupported_harness'],
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
      (deviceId: string): AdmissionOutcome => ({ kind: 'admitted', binding: bindingFor(`${deviceId}X`), credential: { secret: 's', expiresAt: 1 } }),
      (deviceId: string): AdmissionOutcome => ({ kind: 'admitted', binding: bindingFor(deviceId, 9), credential: { secret: 's', expiresAt: 1 } }),
      (): AdmissionOutcome => ({ kind: 'admitted', binding: { v: 1 } as never, credential: { secret: 's', expiresAt: 1 } }),
    ];
    for (const redeem of wrong) {
      const { ports, counts } = harness({ redeem });
      expect(await bootstrapAgent(INPUT, ports)).toEqual({ kind: 'blocked', code: 'admission_denied' });
      expect(counts.activate).toBe(0);
    }
    const { ports } = harness({ redeem: () => ({ kind: 'refused', code: 'binding_conflict' }) });
    expect(await bootstrapAgent(INPUT, ports)).toEqual({ kind: 'blocked', code: 'binding_conflict' });
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

  it('never returns grant or device secrets', async () => {
    const { ports } = harness();
    const text = JSON.stringify(await bootstrapAgent(INPUT, ports));
    expect(text).not.toContain('grant-secret-value');
    expect(text).not.toContain('device-login-secret');
  });

  it('validates input before any port is used', async () => {
    const { ports, counts } = harness();
    for (const bad of [
      { ...INPUT, operationId: 'short' },
      { ...INPUT, session: { ...INPUT.session, harness: 'Codex!' } },
      { ...INPUT, session: { ...INPUT.session, sessionId: 'a\nb' } },
      { ...INPUT, session: { ...INPUT.session, workdir: '' } },
    ]) {
      expect(await bootstrapAgent(bad, ports)).toEqual({ kind: 'blocked', code: 'invalid_request' });
    }
    expect(counts.reserve).toBe(0);
  });
});
