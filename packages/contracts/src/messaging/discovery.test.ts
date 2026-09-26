import sodium from 'libsodium-wrappers';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AuthPrincipal } from './identity';
import type { DeviceId } from './ids';
import {
  ACCESS_REQUEST_OUTCOMES,
  CHANNEL_CREATE_OUTCOMES,
  CHANNEL_DISCOVERY_SCOPES,
  CHANNEL_SEALED_BOX_ALGORITHM,
  MAX_CHANNEL_LIST_PAGE_SIZE,
  MAX_CHANNEL_TITLE_BYTES,
  type AdmissionGrantExchangePort,
  type ChannelCreateAdapterPort,
  type ChannelCreateIntent,
  type ChannelDiscoveryPort,
  type ChannelPrivateEligibilityPort,
  type DiscoveryRequester,
  type GrantExchangeBinding,
  type GrantExchangeRequest,
  type HumanAuthorizedWorkflowContext,
  type PrivateEligibilityMutation,
  type ValidatedGrantExchangeRequest,
  classifyGrantExchangeBinding,
  decodeAccessRequestStatus,
  decodeChannelAccessReadiness,
  decodeChannelAccessRequest,
  decodeChannelCreateIntent,
  decodeChannelCreateReconciliation,
  decodeChannelListQuery,
  decodeChannelListing,
  decodeChannelListingPage,
  decodeDiscoveryCredential,
  decodeGrantExchangeRequest,
  decodeSealedGrantEnvelope,
  decodeSealedGrantPayload,
  deriveOkpKeyThumbprint,
  validateDiscoveryCredential,
  validateGrantExchangeRequest,
  validateSealedGrantPayload,
} from './discovery';

const origin = 'https://khala.example';
const proofPublicKey = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo';
const proofThumbprint = 'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k';
const encryptionPublicKey = '7XdJtNmJ9pV_O_3mxWdn6YjiHJ-HhNkdYQARzVU_mwY';
const encryptionThumbprint = 'xtsuKULPh6VN9fuJMRwj66cDfQyLaxuXHkMlmAe_v6I';

const requester: DiscoveryRequester = {
  principal: 'owner_alice:agent_1' as DiscoveryRequester['principal'],
  origin,
  proofKey: {
    algorithm: 'Ed25519',
    publicKey: proofPublicKey,
    thumbprint: proofThumbprint,
  },
  sessionGeneration: 7,
};

const credential = {
  v: 1,
  credentialRef: 'discovery_credential_1',
  audience: 'khala-channel-discovery',
  requester,
  scopes: CHANNEL_DISCOVERY_SCOPES,
  expiresAt: '2030-01-01T00:00:00Z',
} as const;

const grantExchange = {
  v: 1,
  operationId: 'op_access_1',
  requester: requester.principal,
  origin,
  proofKey: requester.proofKey,
  encryptionKey: {
    algorithm: 'X25519',
    publicKey: encryptionPublicKey,
    thumbprint: encryptionThumbprint,
  },
  deviceId: 'device_agent_1',
  sessionGeneration: requester.sessionGeneration,
  expiresAt: credential.expiresAt,
} as const;

const listing = {
  v: 1,
  listingRef: 'listing_opaque_1',
  title: 'Release planning',
  visibility: 'public',
  serviceKind: 'external',
  requestState: 'not_requested',
} as const;

describe('channel discovery projections', () => {
  it.each(['public', 'private', 'secret'] as const)('round-trips %s visibility', visibility => {
    const input = { ...listing, visibility };
    expect(decodeChannelListing(input)).toEqual({ ok: true, value: input });
  });

  it('normalizes terminal controls in untrusted titles without interpreting them', () => {
    const decoded = decodeChannelListing({ ...listing, title: 'Deploy\u001b[31m\nnow' });
    expect(decoded).toEqual({
      ok: true,
      value: { ...listing, title: 'Deploy\ufffd[31m\ufffdnow' },
    });
  });

  it('bounds titles, page size, and opaque cursors', () => {
    expect(decodeChannelListing({ ...listing, title: 'a'.repeat(MAX_CHANNEL_TITLE_BYTES + 1) }))
      .toEqual({ ok: false, error: { path: 'title', code: 'too_long' } });
    expect(decodeChannelListingPage({ v: 1, items: Array(MAX_CHANNEL_LIST_PAGE_SIZE + 1).fill(listing), nextCursor: null }))
      .toEqual({ ok: false, error: { path: 'items', code: 'too_long' } });
    expect(decodeChannelListingPage({ v: 1, items: [], nextCursor: 'c'.repeat(513) }))
      .toEqual({ ok: false, error: { path: 'nextCursor', code: 'too_long' } });
  });

  it('bounds list-query limits at both ends', () => {
    expect(decodeChannelListQuery({ v: 1, cursor: null, limit: 1 }).ok).toBe(true);
    expect(decodeChannelListQuery({ v: 1, cursor: null, limit: MAX_CHANNEL_LIST_PAGE_SIZE }).ok).toBe(true);
    expect(decodeChannelListQuery({ v: 1, cursor: null, limit: 0 }))
      .toEqual({ ok: false, error: { path: 'limit', code: 'invalid_value' } });
    expect(decodeChannelListQuery({ v: 1, cursor: null, limit: MAX_CHANNEL_LIST_PAGE_SIZE + 1 }))
      .toEqual({ ok: false, error: { path: 'limit', code: 'invalid_value' } });
    expect(decodeChannelListQuery({ v: 1, cursor: null, limit: 1.5 }))
      .toEqual({ ok: false, error: { path: 'limit', code: 'unsafe_integer' } });
  });

  it.each(['roomId', 'participants', 'participantCount', 'lastActivity', 'content', 'grant', 'create', 'admit'])
  ('rejects forbidden listing field %s', field => {
    const decoded = decodeChannelListing({ ...listing, [field]: field === 'participants' ? [] : 'forbidden' });
    expect(decoded).toEqual({ ok: false, error: { path: field, code: 'unknown_field' } });
  });

  it('rejects the wrong implementation that leaks Matrix room IDs or participant counts', () => {
    expect(decodeChannelListing({ ...listing, roomId: '!secret:matrix.example' }).ok).toBe(false);
    expect(decodeChannelListing({ ...listing, participantCount: 4 }).ok).toBe(false);
  });
});

describe('access and create requests', () => {
  it.each(ACCESS_REQUEST_OUTCOMES)('round-trips finite request outcome %s without a grant', outcome => {
    const status = { v: 1, operationId: 'op_access_1', outcome } as const;
    expect(decodeAccessRequestStatus(status)).toEqual({ ok: true, value: status });
  });

  it.each(['grant', 'envelope', 'ciphertext'])('keeps %s out of status', field => {
    const decoded = decodeAccessRequestStatus({
      v: 1,
      operationId: 'op_access_1',
      outcome: 'approved',
      [field]: 'secret',
    });
    expect(decoded).toEqual({ ok: false, error: { path: field, code: 'unknown_field' } });
  });

  it('strictly decodes listing-reference and canonical-URL requests', () => {
    const byListing = {
      v: 1,
      kind: 'listing_ref',
      operationId: 'op_access_1',
      credentialRef: credential.credentialRef,
      listingRef: listing.listingRef,
    } as const;
    const byUrl = {
      v: 1,
      kind: 'channel_url',
      operationId: 'op_access_2',
      credentialRef: credential.credentialRef,
      channelUrl: `${origin}/channels/channel_1`,
    } as const;
    expect(decodeChannelAccessRequest(byListing, origin)).toEqual({ ok: true, value: byListing });
    expect(decodeChannelAccessRequest(byUrl, origin)).toEqual({ ok: true, value: byUrl });
    expect(decodeChannelAccessRequest({ ...byUrl, channelUrl: 'https://evil.example/channels/channel_1' }, origin))
      .toEqual({ ok: false, error: { path: 'channelUrl', code: 'mismatch' } });
    expect(decodeChannelAccessRequest({ ...byUrl, channelUrl: 'not a URL' }, origin))
      .toEqual({ ok: false, error: { path: 'channelUrl', code: 'invalid_value' } });
    expect(decodeChannelAccessRequest({ ...byUrl, channelUrl: `${origin}/channels/channel_1#secret` }, origin))
      .toEqual({ ok: false, error: { path: 'channelUrl', code: 'invalid_value' } });
  });

  it('keeps private and secret URL requests request-only while enumeration stays ineligible', async () => {
    const port: ChannelDiscoveryPort = {
      list: async () => ({ kind: 'ok', value: { v: 1, items: [], nextCursor: null } }),
      requestAccess: async input => ({
        v: 1,
        operationId: input.operationId,
        outcome: input.kind === 'channel_url' ? 'pending_owner' : 'unavailable',
      }),
      requestChannelCreate: async input => ({ v: 1, operationId: input.operationId, outcome: 'pending_owner' }),
      inspectRequest: async operationId => ({ v: 1, operationId, outcome: 'pending_owner' }),
    };
    const page = await port.list({ v: 1, cursor: null, limit: 25 }, requester);
    const status = await port.requestAccess({
      v: 1,
      kind: 'channel_url',
      operationId: 'op_secret_url',
      credentialRef: credential.credentialRef,
      channelUrl: `${origin}/channels/non_enumerable`,
    }, requester);
    expect(page).toEqual({ kind: 'ok', value: { v: 1, items: [], nextCursor: null } });
    expect(status).toEqual({ v: 1, operationId: 'op_secret_url', outcome: 'pending_owner' });
    expect(status).not.toHaveProperty('roomId');
  });

  it('makes invalid and ineligible URL outcomes indistinguishable on the wire', () => {
    const unavailable = { v: 1, operationId: 'op_hidden', outcome: 'unavailable' } as const;
    expect(decodeAccessRequestStatus(unavailable)).toEqual({ ok: true, value: unavailable });
    for (const hiddenReason of ['invalid', 'ineligible']) {
      expect(decodeAccessRequestStatus({ ...unavailable, hiddenReason })).toEqual({
        ok: false,
        error: { path: 'hiddenReason', code: 'unknown_field' },
      });
    }
  });

  it('bounds create proposals and gives them no create authority', () => {
    const intent = {
      v: 1,
      operationId: 'op_create_1',
      credentialRef: credential.credentialRef,
      origin,
      proposedTitle: 'Incident response',
    } as const;
    expect(decodeChannelCreateIntent(intent)).toEqual({ ok: true, value: intent });
    expect(decodeChannelCreateIntent({ ...intent, proposedTitle: 'x'.repeat(MAX_CHANNEL_TITLE_BYTES + 1) }).ok).toBe(false);
    expect(decodeChannelCreateIntent({ ...intent, create: true }))
      .toEqual({ ok: false, error: { path: 'create', code: 'unknown_field' } });
  });

  it.each(CHANNEL_CREATE_OUTCOMES)('round-trips finite create reconciliation outcome %s', outcome => {
    const channelRef = outcome === 'created' || outcome === 'already_created' ? 'channel_opaque_1' : null;
    const reconciliation = { v: 1, idempotencyKey: 'create_once', outcome, channelRef } as const;
    expect(decodeChannelCreateReconciliation(reconciliation)).toEqual({ ok: true, value: reconciliation });
  });

  it('requires a channel reference only after creation is proven', () => {
    expect(decodeChannelCreateReconciliation({
      v: 1,
      idempotencyKey: 'create_once',
      outcome: 'created',
      channelRef: null,
    })).toEqual({ ok: false, error: { path: 'channelRef', code: 'invalid_value' } });
    expect(decodeChannelCreateReconciliation({
      v: 1,
      idempotencyKey: 'create_once',
      outcome: 'outcome_unknown',
      channelRef: 'channel_opaque_1',
    })).toEqual({ ok: false, error: { path: 'channelRef', code: 'invalid_value' } });
  });
});

describe('discovery credentials and grant exchange', () => {
  it('requires exactly the discovery scopes and separate proof/encryption key algorithms', () => {
    expect(decodeDiscoveryCredential(credential)).toEqual({ ok: true, value: credential });
    expect(decodeDiscoveryCredential({ ...credential, scopes: [...credential.scopes, 'admit'] }).ok).toBe(false);

    expect(decodeGrantExchangeRequest(grantExchange)).toEqual({ ok: true, value: grantExchange });
    expect(decodeGrantExchangeRequest({
      ...grantExchange,
      encryptionKey: { ...grantExchange.encryptionKey, publicKey: proofPublicKey },
    })).toEqual({ ok: false, error: { path: 'encryptionKey.publicKey', code: 'mismatch' } });
    expect(decodeGrantExchangeRequest({
      ...grantExchange,
      encryptionKey: { ...grantExchange.encryptionKey, thumbprint: proofThumbprint },
    })).toEqual({ ok: false, error: { path: 'encryptionKey.thumbprint', code: 'mismatch' } });
  });

  it('rejects expired, cross-origin, wrong-requester, stale-generation, and wrong-proof credentials', async () => {
    const decoded = decodeDiscoveryCredential(credential);
    if (!decoded.ok) throw new Error('fixture credential must decode');
    expect(await validateDiscoveryCredential(decoded.value, {
      requester: requester.principal,
      origin,
      proofKeyThumbprint: proofThumbprint,
      sessionGeneration: 7,
      nowMs: Date.parse('2029-12-31T23:59:59Z'),
    })).toBe('valid');
    expect(await validateDiscoveryCredential(decoded.value, {
      requester: requester.principal,
      origin,
      proofKeyThumbprint: proofThumbprint,
      sessionGeneration: 7,
      nowMs: Date.parse(credential.expiresAt),
    })).toBe('expired');
    expect(await validateDiscoveryCredential(decoded.value, {
      requester: requester.principal,
      origin: 'https://other.example',
      proofKeyThumbprint: proofThumbprint,
      sessionGeneration: 7,
      nowMs: 0,
    })).toBe('wrong_origin');
    expect(await validateDiscoveryCredential(decoded.value, {
      requester: 'owner_alice:agent_2' as DiscoveryRequester['principal'],
      origin,
      proofKeyThumbprint: proofThumbprint,
      sessionGeneration: 7,
      nowMs: 0,
    })).toBe('wrong_requester');
    expect(await validateDiscoveryCredential(decoded.value, {
      requester: requester.principal,
      origin,
      proofKeyThumbprint: proofThumbprint,
      sessionGeneration: 8,
      nowMs: 0,
    })).toBe('wrong_generation');
    expect(await validateDiscoveryCredential(decoded.value, {
      requester: requester.principal,
      origin,
      proofKeyThumbprint: encryptionThumbprint,
      sessionGeneration: 7,
      nowMs: 0,
    })).toBe('proof_mismatch');
  });

  it('validates grant exchange against authenticated connector context', async () => {
    const decoded = decodeGrantExchangeRequest(grantExchange);
    if (!decoded.ok) throw new Error('fixture grant exchange must decode');
    const current = {
      operationId: grantExchange.operationId,
      requester: requester.principal,
      origin,
      sessionGeneration: requester.sessionGeneration,
      deviceId: grantExchange.deviceId as DeviceId,
      proofKeyThumbprint: proofThumbprint,
      nowMs: Date.parse('2029-12-31T23:59:59Z'),
    } as const;
    expect(await deriveOkpKeyThumbprint(decoded.value.proofKey))
      .toEqual({ ok: true, thumbprint: proofThumbprint });
    expect(await deriveOkpKeyThumbprint(decoded.value.encryptionKey))
      .toEqual({ ok: true, thumbprint: encryptionThumbprint });
    const validated = await validateGrantExchangeRequest(decoded.value, current);
    expect(validated).toEqual({ ok: true, request: decoded.value });
    expect(await validateGrantExchangeRequest(decoded.value, { ...current, nowMs: Date.parse(grantExchange.expiresAt) }))
      .toEqual({ ok: false, reason: 'expired' });
    expect(await validateGrantExchangeRequest(decoded.value, { ...current, operationId: 'op_access_2' }))
      .toEqual({ ok: false, reason: 'operation_mismatch' });
    expect(await validateGrantExchangeRequest(decoded.value, {
      ...current,
      requester: 'owner_alice:agent_2' as DiscoveryRequester['principal'],
    })).toEqual({ ok: false, reason: 'wrong_requester' });
    expect(await validateGrantExchangeRequest(decoded.value, { ...current, origin: 'https://other.example' }))
      .toEqual({ ok: false, reason: 'wrong_origin' });
    expect(await validateGrantExchangeRequest(decoded.value, { ...current, sessionGeneration: 8 }))
      .toEqual({ ok: false, reason: 'wrong_generation' });
    expect(await validateGrantExchangeRequest(decoded.value, { ...current, deviceId: 'device_agent_2' as DeviceId }))
      .toEqual({ ok: false, reason: 'wrong_device' });
    expect(await validateGrantExchangeRequest(decoded.value, { ...current, proofKeyThumbprint: encryptionThumbprint }))
      .toEqual({ ok: false, reason: 'proof_mismatch' });
    expect(await validateGrantExchangeRequest({
      ...decoded.value,
      proofKey: {
        ...decoded.value.proofKey,
        thumbprint: 'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU',
      },
    }, { ...current, proofKeyThumbprint: 'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU' }))
      .toEqual({ ok: false, reason: 'proof_mismatch' });
    expect(await validateGrantExchangeRequest({
      ...decoded.value,
      encryptionKey: {
        ...decoded.value.encryptionKey,
        thumbprint: 'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU',
      },
    }, current))
      .toEqual({ ok: false, reason: 'encryption_key_mismatch' });
  });

  it('rejects encryption-key reuse with another proof thumbprint or operation/device tuple', () => {
    const binding: GrantExchangeBinding = {
      encryptionKeyPublicKey: encryptionPublicKey,
      encryptionKeyThumbprint: encryptionThumbprint,
      proofKeyThumbprint: proofThumbprint,
      operationId: 'op_access_1',
      deviceId: 'device_agent_1' as DeviceId,
      requester: requester.principal,
      origin,
      sessionGeneration: 7,
    };
    expect(classifyGrantExchangeBinding(binding, { ...binding })).toBe('match');
    expect(classifyGrantExchangeBinding(binding, { ...binding, proofKeyThumbprint: 'REREREREREREREREREREREREREREREREREREREREREQ' }))
      .toBe('key_reuse');
    expect(classifyGrantExchangeBinding(binding, { ...binding, operationId: 'op_access_2' })).toBe('key_reuse');
    expect(classifyGrantExchangeBinding(binding, { ...binding, deviceId: 'device_agent_2' as DeviceId })).toBe('key_reuse');
    expect(classifyGrantExchangeBinding(binding, {
      ...binding,
      encryptionKeyThumbprint: 'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU',
    })).toBe('key_reuse');
    expect(classifyGrantExchangeBinding(binding, {
      ...binding,
      encryptionKeyPublicKey: proofPublicKey,
    })).toBe('key_reuse');
    expect(classifyGrantExchangeBinding(binding, {
      ...binding,
      encryptionKeyPublicKey: proofPublicKey,
      encryptionKeyThumbprint: 'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU',
    })).toBe('unbound');
  });

  it('strictly decodes and validates the sealed grant plaintext binding', () => {
    const payload = {
      v: 1,
      operationId: grantExchange.operationId,
      requester: requester.principal,
      origin,
      sessionGeneration: requester.sessionGeneration,
      deviceId: grantExchange.deviceId,
      proofKeyThumbprint: proofThumbprint,
      recipientKeyThumbprint: encryptionThumbprint,
      expiresAt: grantExchange.expiresAt,
      grant: 'grant_once_1',
    } as const;
    const decoded = decodeSealedGrantPayload(payload);
    expect(decoded).toEqual({ ok: true, value: payload });
    if (!decoded.ok) throw new Error('fixture sealed payload must decode');
    const expected = {
      ...payload,
      deviceId: payload.deviceId as DeviceId,
      nowMs: Date.parse('2029-12-31T23:59:59Z'),
    };
    expect(validateSealedGrantPayload(decoded.value, expected)).toBe('valid');
    expect(validateSealedGrantPayload(decoded.value, { ...expected, nowMs: Date.parse(payload.expiresAt) })).toBe('expired');
    expect(validateSealedGrantPayload(decoded.value, { ...expected, operationId: 'op_access_2' }))
      .toBe('operation_mismatch');
    expect(validateSealedGrantPayload(decoded.value, { ...expected, proofKeyThumbprint: encryptionThumbprint }))
      .toBe('proof_mismatch');
    expect(validateSealedGrantPayload(decoded.value, { ...expected, recipientKeyThumbprint: proofThumbprint }))
      .toBe('encryption_key_mismatch');
    expect(decodeSealedGrantPayload({ ...payload, roomId: '!secret:matrix.example' }))
      .toEqual({ ok: false, error: { path: 'roomId', code: 'unknown_field' } });
  });

  it('matches libsodium known-answer key bytes and rejects tampered sealed boxes', async () => {
    await sodium.ready;
    const seed = sodium.from_hex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
    const keys = sodium.crypto_box_seed_keypair(seed);
    expect(sodium.to_hex(keys.publicKey)).toBe('ed7749b4d989f6957f3bfde6c56767e988e21c9f8784d91d610011cd553f9b06');
    expect(sodium.to_hex(keys.privateKey)).toBe('accd44eb8e93319c0570bc11005c0e0189d34ff02f6c17773411ad191293c98f');

    const sealedPayload = {
      v: 1,
      operationId: grantExchange.operationId,
      requester: requester.principal,
      origin,
      sessionGeneration: requester.sessionGeneration,
      deviceId: grantExchange.deviceId,
      proofKeyThumbprint: proofThumbprint,
      recipientKeyThumbprint: encryptionThumbprint,
      expiresAt: grantExchange.expiresAt,
      grant: 'grant_once_1',
    } as const;
    const plaintext = sodium.from_string(JSON.stringify(sealedPayload));
    const ciphertext = sodium.crypto_box_seal(plaintext, keys.publicKey);
    const encoded = sodium.to_base64(ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING);
    const envelope = {
      v: 1,
      algorithm: CHANNEL_SEALED_BOX_ALGORITHM,
      recipientKeyThumbprint: encryptionThumbprint,
      ciphertext: encoded,
    } as const;
    expect(decodeSealedGrantEnvelope(envelope)).toEqual({ ok: true, value: envelope });
    const opened = sodium.to_string(sodium.crypto_box_seal_open(ciphertext, keys.publicKey, keys.privateKey));
    expect(decodeSealedGrantPayload(JSON.parse(opened) as unknown)).toEqual({ ok: true, value: sealedPayload });

    const refuses = (candidate: Uint8Array, publicKey = keys.publicKey, privateKey = keys.privateKey) => {
      try {
        return sodium.crypto_box_seal_open(candidate, publicKey, privateKey);
      } catch {
        return null;
      }
    };
    const tampered = new Uint8Array(ciphertext);
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 1;
    expect(refuses(tampered)).toBeNull();
    expect(refuses(ciphertext.subarray(0, ciphertext.length - 1))).toBeNull();
    const other = sodium.crypto_box_keypair();
    expect(refuses(ciphertext, other.publicKey, other.privateKey)).toBeNull();
  });

  it('decodes a grant-free readiness acknowledgement and nothing more', () => {
    const readiness = {
      v: 1, operationId: 'op_access_1', requester: 'principal_1', origin: 'https://khala.example', sessionGeneration: 3,
      deviceId: 'device_1', proofKeyThumbprint: 'A'.repeat(43), recipientKeyThumbprint: 'Q'.repeat(42) + 'A',
    };
    expect(decodeChannelAccessReadiness(readiness)).toEqual({ ok: true, value: readiness });
    for (const bad of [
      { ...readiness, grant: 'cagrant_x' },
      { ...readiness, connected: true },
      { ...readiness, v: 2 },
      { ...readiness, origin: 'https://khala.example/path' },
      { ...readiness, recipientKeyThumbprint: readiness.proofKeyThumbprint },
      { ...readiness, recipientKeyThumbprint: 'short' },
    ]) {
      expect(decodeChannelAccessReadiness(bad).ok).toBe(false);
    }
  });
});

describe('authority boundaries', () => {
  it('exposes no create or admit member on the agent-facing discovery port', () => {
    type HasCreate = 'create' extends keyof ChannelDiscoveryPort ? true : false;
    type HasAdmit = 'admit' extends keyof ChannelDiscoveryPort ? true : false;
    const hasCreate: HasCreate = false;
    const hasAdmit: HasAdmit = false;
    expect(hasCreate).toBe(false);
    expect(hasAdmit).toBe(false);
  });

  it('requires human workflow context and an idempotency key on the create adapter', () => {
    type CreateInput = Parameters<ChannelCreateAdapterPort['create']>[0];
    expectTypeOf<CreateInput>().toMatchTypeOf<{
      intent: ChannelCreateIntent;
      workflow: HumanAuthorizedWorkflowContext;
      idempotencyKey: string;
    }>();

    const compileOnly = (adapter: ChannelCreateAdapterPort, intent: ChannelCreateIntent, workflow: HumanAuthorizedWorkflowContext) => {
      void adapter.create({ intent, workflow, idempotencyKey: 'create_once' });
      // @ts-expect-error human workflow context is mandatory
      void adapter.create({ intent, idempotencyKey: 'create_once' });
      // @ts-expect-error idempotency key is mandatory
      void adapter.create({ intent, workflow });
    };
    expect(compileOnly).toBeTypeOf('function');
  });

  it('requires validated connector context before grant exchange', () => {
    type ExchangeInput = Parameters<AdmissionGrantExchangePort['exchange']>[0];
    expectTypeOf<ExchangeInput>().toEqualTypeOf<ValidatedGrantExchangeRequest>();

    const compileOnly = (
      port: AdmissionGrantExchangePort,
      raw: GrantExchangeRequest,
      validated: ValidatedGrantExchangeRequest,
    ) => {
      void port.exchange(validated);
      // @ts-expect-error decoded caller assertions are not authenticated exchange authority
      void port.exchange(raw);
    };
    expect(compileOnly).toBeTypeOf('function');
  });

  it('keys owner-only private eligibility by stable principal and current generation', () => {
    type AllowInput = Parameters<ChannelPrivateEligibilityPort['allow']>[0];
    type AllowOwner = Parameters<ChannelPrivateEligibilityPort['allow']>[1];
    expectTypeOf<AllowInput>().toEqualTypeOf<PrivateEligibilityMutation>();
    expectTypeOf<AllowOwner>().toEqualTypeOf<AuthPrincipal>();

    const compileOnly = (
      port: ChannelPrivateEligibilityPort,
      mutation: PrivateEligibilityMutation,
      owner: AuthPrincipal,
    ) => {
      void port.allow(mutation, owner);
      void port.revoke(mutation, owner);
      // @ts-expect-error authenticated owner context is mandatory
      void port.allow(mutation);
      // @ts-expect-error current session generation is mandatory
      void port.allow({ ...mutation, expectedSessionGeneration: undefined }, owner);
    };
    expect(compileOnly).toBeTypeOf('function');
  });
});
