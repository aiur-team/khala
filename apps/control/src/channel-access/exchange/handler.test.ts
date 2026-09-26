import type {
  ChannelAccessReadiness,
  GrantExchangeRequest,
  OperationResult,
  SealedGrantEnvelope,
  GrantExchangeRejection,
  ValidatedGrantExchangeRequest,
} from '@khala/contracts/messaging/index';
import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_CHANNEL_ACCESS_EXCHANGE_PATH,
  CONNECTOR_CHANNEL_ACCESS_READY_PATH,
  type ConnectorGrantExchangePort,
  type ConnectorExchangeAuthentication,
  type VerifiedExchangeConnector,
  createGrantExchangeHandler,
  createGrantReadinessHandler,
} from './handler';
import { DEVICE, DIGEST, T0, connectorRequest, requester } from '@khala/messaging/channel-access/exchange/journal-harness.test';

const ENVELOPE: SealedGrantEnvelope = {
  v: 1,
  algorithm: 'crypto_box_seal_x25519_xsalsa20poly1305',
  recipientKeyThumbprint: 'A'.repeat(43),
  ciphertext: 'Q'.repeat(96),
};

async function setup(result: OperationResult<SealedGrantEnvelope, GrantExchangeRejection> | (() => never) = { kind: 'ok', value: ENVELOPE }) {
  const body = await connectorRequest();
  const connector: VerifiedExchangeConnector = {
    requester: requester.principal,
    origin: requester.origin,
    sessionGeneration: 3,
    sessionFingerprint: DIGEST,
    deviceId: DEVICE,
    proofKeyThumbprint: body.proofKey.thumbprint,
  };
  const calls: { connector: unknown; input: ValidatedGrantExchangeRequest }[] = [];
  const state: { auth: ConnectorExchangeAuthentication } = { auth: { kind: 'authenticated', connector } };
  const route = createGrantExchangeHandler({
    authenticateConnector: async () => state.auth,
    exchangeFor(value): ConnectorGrantExchangePort {
      return {
        async exchange(input) {
          calls.push({ connector: value, input });
          return typeof result === 'function' ? result() : result;
        },
        async acknowledge() {
          throw new Error('not used by the exchange route');
        },
      };
    },
    clock: () => T0,
  });
  const post = (payload: unknown, query = '?operation=op_access_1', contentType = 'application/json') => route.handle(new Request(
    `${requester.origin}${CONNECTOR_CHANNEL_ACCESS_EXCHANGE_PATH}${query}`,
    { method: 'POST', headers: { 'content-type': contentType }, body: JSON.stringify(payload) },
  ));
  return { route, body, connector, calls, state, post };
}

async function read(response: Response) {
  return { status: response.status, cache: response.headers.get('cache-control'), body: await response.json() as unknown };
}

describe('connector grant-exchange route', () => {
  it('registers one exact POST route and returns only the envelope, uncached', async () => {
    const h = await setup();
    expect(h.route.path).toBe('/api/agent/channel-access/exchange');
    expect(h.route.methods).toEqual(['POST']);
    expect(await read(await h.post(h.body))).toEqual({ status: 200, cache: 'no-store', body: ENVELOPE });
    // The session fingerprint comes only from authentication, never from the body.
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.connector).toEqual({ sessionFingerprint: DIGEST });
  });

  it('requires connector authentication before reading the body', async () => {
    const h = await setup();
    h.state.auth = { kind: 'rejected', code: 'auth_required' };
    expect(await read(await h.post(h.body))).toMatchObject({ status: 401, body: { code: 'auth_required' } });
    h.state.auth = { kind: 'rejected', code: 'forbidden' };
    expect(await read(await h.post(h.body))).toMatchObject({ status: 403, body: { code: 'forbidden' } });
    h.state.auth = { kind: 'unavailable' };
    expect((await h.post(h.body)).status).toBe(503);
    expect(h.calls).toHaveLength(0);
  });

  it('rejects malformed input, stray fields, and a missing or repeated operation', async () => {
    const h = await setup();
    for (const [payload, query] of [
      [{ ...h.body, grant: 'x' }, '?operation=op_access_1'],
      [{ ...h.body, v: 2 }, '?operation=op_access_1'],
      [h.body, ''],
      [h.body, '?operation=op_access_1&operation=op_access_1'],
      [h.body, '?operation=op_access_1&debug=1'],
    ] as const) {
      expect(await read(await h.post(payload, query))).toMatchObject({ status: 400, body: { code: 'invalid_request' } });
    }
    expect((await h.post(h.body, '?operation=op_access_1', 'text/plain')).status).toBe(400);
    expect(h.calls).toHaveLength(0);
  });

  it('refuses caller assertions that differ from the authenticated connector', async () => {
    const h = await setup();
    const other = await connectorRequest();
    const cases: [Partial<GrantExchangeRequest>, string, string?][] = [
      [{ operationId: 'op_access_2' }, 'operation_mismatch'],
      [{ requester: 'principal_2' as GrantExchangeRequest['requester'] }, 'wrong_requester'],
      [{ origin: 'https://other.example' }, 'wrong_origin'],
      [{ sessionGeneration: 4 }, 'wrong_generation'],
      [{ deviceId: 'device_agent_2' as GrantExchangeRequest['deviceId'] }, 'wrong_device'],
      [{ proofKey: other.proofKey }, 'proof_mismatch'],
      [{ encryptionKey: { ...h.body.encryptionKey, thumbprint: other.encryptionKey.thumbprint } }, 'encryption_key_mismatch'],
    ];
    for (const [change, code] of cases) {
      expect(await read(await h.post({ ...h.body, ...change }))).toMatchObject({ status: 409, body: { code } });
    }
    expect(await read(await h.post({ ...h.body, expiresAt: new Date(T0).toISOString() })))
      .toMatchObject({ status: 410, body: { code: 'expired' } });
    expect(h.calls).toHaveLength(0);
  });

  it('maps exchange outcomes to finite codes', async () => {
    for (const [result, status, code] of [
      [{ kind: 'rejected', code: 'closed' }, 410, 'closed'],
      [{ kind: 'rejected', code: 'expired' }, 410, 'expired'],
      [{ kind: 'rejected', code: 'key_reuse' }, 409, 'key_reuse'],
      [{ kind: 'rejected', code: 'encryption_key_mismatch' }, 409, 'encryption_key_mismatch'],
      [{ kind: 'rejected', code: 'crypto_unavailable' }, 503, undefined],
      [{ kind: 'unavailable', retryable: true }, 503, undefined],
      [{ kind: 'outcome_unknown', operationId: 'x' }, 503, undefined],
    ] as const) {
      const h = await setup(result);
      const response = await read(await h.post(h.body));
      expect(response.status).toBe(status);
      expect(response.cache).toBe('no-store');
      if (code) expect(response.body).toEqual({ v: 1, kind: 'rejected', code });
      else expect(response.body).toEqual({ v: 1, kind: 'unavailable' });
    }
  });

  it('never returns an envelope that fails the strict decoder, and hides port failures', async () => {
    const leaky = await setup({ kind: 'ok', value: { ...ENVELOPE, grant: 'cagrant_secret' } as SealedGrantEnvelope });
    const response = await read(await leaky.post(leaky.body));
    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).not.toContain('cagrant_secret');
    const throwing = await setup(() => { throw new Error('secret provider detail'); });
    const failed = await throwing.post(throwing.body);
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('secret');
  });
});

async function readySetup(result: OperationResult<null, GrantExchangeRejection> = { kind: 'ok', value: null }) {
  const body = await connectorRequest();
  const connector: VerifiedExchangeConnector = {
    requester: requester.principal,
    origin: requester.origin,
    sessionGeneration: 3,
    sessionFingerprint: DIGEST,
    deviceId: DEVICE,
    proofKeyThumbprint: body.proofKey.thumbprint,
  };
  const calls: { connector: unknown; input: ChannelAccessReadiness }[] = [];
  const state: { auth: ConnectorExchangeAuthentication } = { auth: { kind: 'authenticated', connector } };
  const route = createGrantReadinessHandler({
    authenticateConnector: async () => state.auth,
    exchangeFor(value): ConnectorGrantExchangePort {
      return {
        async exchange() {
          throw new Error('not used by the readiness route');
        },
        async acknowledge(input) {
          calls.push({ connector: value, input });
          return result;
        },
      };
    },
    clock: () => T0,
  });
  const readiness: ChannelAccessReadiness = {
    v: 1,
    operationId: 'op_access_1',
    requester: requester.principal,
    origin: requester.origin,
    sessionGeneration: 3,
    deviceId: DEVICE,
    proofKeyThumbprint: body.proofKey.thumbprint,
    recipientKeyThumbprint: body.encryptionKey.thumbprint,
  };
  const post = (payload: unknown, query = '?operation=op_access_1') => route.handle(new Request(
    `${requester.origin}${CONNECTOR_CHANNEL_ACCESS_READY_PATH}${query}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) },
  ));
  return { route, readiness, calls, state, post };
}

describe('connector readiness route', () => {
  it('registers one exact POST route and acknowledges for the authenticated connector', async () => {
    const h = await readySetup();
    expect(h.route.path).toBe('/api/agent/channel-access/ready');
    expect(h.route.methods).toEqual(['POST']);
    expect(await read(await h.post(h.readiness)))
      .toEqual({ status: 200, cache: 'no-store', body: { v: 1, kind: 'acknowledged' } });
    expect(h.calls).toEqual([{ connector: { sessionFingerprint: DIGEST }, input: h.readiness }]);
  });

  it('requires authentication and a strict body, and refuses assertions that differ from it', async () => {
    const h = await readySetup();
    h.state.auth = { kind: 'rejected', code: 'auth_required' };
    expect((await h.post(h.readiness)).status).toBe(401);
    h.state.auth = { kind: 'authenticated', connector: {
      requester: requester.principal, origin: requester.origin, sessionGeneration: 3, sessionFingerprint: DIGEST,
      deviceId: DEVICE, proofKeyThumbprint: h.readiness.proofKeyThumbprint,
    } };
    expect((await h.post({ ...h.readiness, grant: 'cagrant_x' })).status).toBe(400);
    expect((await h.post(h.readiness, '')).status).toBe(400);
    for (const [change, code] of [
      [{ operationId: 'op_access_2' }, 'operation_mismatch'],
      [{ requester: 'principal_2' }, 'wrong_requester'],
      [{ origin: 'https://other.example' }, 'wrong_origin'],
      [{ sessionGeneration: 4 }, 'wrong_generation'],
      [{ deviceId: 'device_agent_2' }, 'wrong_device'],
      [{ proofKeyThumbprint: 'A'.repeat(43) }, 'proof_mismatch'],
    ] as const) {
      expect(await read(await h.post({ ...h.readiness, ...change }))).toMatchObject({ status: 409, body: { code } });
    }
    expect(h.calls).toHaveLength(0);
  });

  it('maps acknowledgement outcomes to finite codes', async () => {
    for (const [result, status] of [
      [{ kind: 'rejected', code: 'closed' }, 410],
      [{ kind: 'rejected', code: 'encryption_key_mismatch' }, 409],
      [{ kind: 'unavailable', retryable: true }, 503],
    ] as const) {
      const h = await readySetup(result);
      expect((await h.post(h.readiness)).status).toBe(status);
    }
  });
});
