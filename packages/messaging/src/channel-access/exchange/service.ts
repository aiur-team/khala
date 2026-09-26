// Connector-only exchange of an owner-approved channel-access operation for one
// sealed grant result. The state machine is durable: the first bound tuple and
// the provider operation are persisted before any effect, admission ambiguity is
// reconciled rather than retried blindly, and once an envelope is stored every
// retry returns exactly those bytes. Nothing here activates the connector or
// reports `connected`; that belongs to `channel-access-activation`.

import {
  type AdmissionGrantExchangePort,
  type CallOptions,
  type ChannelAccessAuthorization,
  type ControlStore,
  type GrantExchangeRejection,
  type OperationResult,
  type SealedGrantEnvelope,
  type TrustedClock,
  type ValidatedGrantExchangeRequest,
  classifyGrantExchangeBinding,
} from '@khala/contracts/messaging/index';
import { type ExchangeRecord, type StoredExchange, exchangeJournal, sha256Hex } from './journal';
import type {
  ChannelAdmissionProviderPort,
  ChannelAdmissionRequest,
  GrantExchangeAuthorityPort,
  GrantExchangeConnector,
  GrantIssuerPort,
} from './ports';
import { sealGrantPayload } from './seal';

/** Lifetime of the one-time grant inside the envelope. */
export const CHANNEL_ACCESS_GRANT_LIFETIME_MS = 15 * 60_000;
/** Hard recovery expiry of a stored envelope, counted from sealing. */
export const CHANNEL_ACCESS_ENVELOPE_RECOVERY_MS = 7 * 24 * 60 * 60_000;
// Sealing always happens before the request deadline, which is at most seven days after
// the record is created, so two windows cover every use of an encryption key.
const KEY_INDEX_LIFETIME_MS = 2 * CHANNEL_ACCESS_ENVELOPE_RECOVERY_MS;
const MAX_STEPS = 8;

type ExchangeResult = OperationResult<SealedGrantEnvelope, GrantExchangeRejection>;
type Step = Readonly<{ kind: 'continue' }> | Readonly<{ kind: 'done'; result: ExchangeResult }>;

export type GrantExchangeService = Readonly<{
  /** Request-scoped port for one authenticated connector. */
  forConnector(connector: GrantExchangeConnector): AdmissionGrantExchangePort;
}>;

export function createGrantExchangeService(deps: Readonly<{
  store: ControlStore;
  authority: GrantExchangeAuthorityPort;
  provider: ChannelAdmissionProviderPort;
  issuer: GrantIssuerPort;
  clock: TrustedClock;
}>): GrantExchangeService {
  const journal = exchangeJournal(deps.store);

  async function exchange(
    input: ValidatedGrantExchangeRequest,
    connector: GrantExchangeConnector,
    options?: CallOptions,
  ): Promise<ExchangeResult> {
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const loaded = await journal.load(input, options);
      if (loaded.kind === 'unavailable') return unavailable();
      if (loaded.kind === 'absent') {
        const bound = await bind(loaded.key, input, connector, options);
        if (bound.kind === 'done') return bound.result;
        continue;
      }
      const stored = loaded.stored;
      const record = stored.record;
      const drift = bindingDrift(record, input, connector);
      if (drift !== null) return rejected(drift);
      const key = classifyGrantExchangeBinding(bindingOf(record), bindingOf({
        ...record,
        encryptionPublicKey: input.encryptionKey.publicKey,
        encryptionKeyThumbprint: input.encryptionKey.thumbprint,
      }));
      if (key === 'key_reuse') return rejected('key_reuse');
      if (record.phase === 'sealed') {
        // Recovery never rotates the key, calls the provider, mints, or seals again.
        if (key !== 'match') return rejected('encryption_key_mismatch');
        return deps.clock() < Date.parse(record.expiresAt) ? ok(record.envelope!) : rejected('expired');
      }
      if (record.phase === 'closed') return rejected(record.closed!);
      const next = key === 'match'
        ? await advance(stored, options)
        : await rotate(stored, input, options);
      if (next.kind === 'done') return next.result;
    }
    return unavailable();
  }

  /** First matching exchange: persist the bound tuple and provider operation before any effect. */
  async function bind(
    recordKey: string,
    input: ValidatedGrantExchangeRequest,
    connector: GrantExchangeConnector,
    options?: CallOptions,
  ): Promise<Step> {
    const now = deps.clock();
    const claimed = await journal.claimKey({
      recordKey,
      publicKey: input.encryptionKey.publicKey,
      expiresAt: iso(now + KEY_INDEX_LIFETIME_MS),
    }, options);
    if (claimed !== 'claimed') return done(claimed === 'key_reuse' ? rejected('key_reuse') : unavailable());
    const providerDigest = await sha256Hex(['provider-operation', recordKey]);
    if (providerDigest === null) return done(unavailable());
    const created = await journal.create(recordKey, {
      v: 1,
      seq: 1,
      operationId: input.operationId,
      requester: input.requester,
      origin: input.origin,
      sessionGeneration: input.sessionGeneration,
      sessionFingerprint: connector.sessionFingerprint,
      deviceId: input.deviceId,
      proofKeyThumbprint: input.proofKey.thumbprint,
      encryptionPublicKey: input.encryptionKey.publicKey,
      encryptionKeyThumbprint: input.encryptionKey.thumbprint,
      providerOperationId: `caadmit_${providerDigest}`,
      createdAt: iso(now),
      expiresAt: iso(now + CHANNEL_ACCESS_ENVELOPE_RECOVERY_MS),
      phase: 'bound',
      membership: null,
      envelope: null,
      closed: null,
    }, options);
    return created.kind === 'unavailable' ? done(unavailable()) : { kind: 'continue' };
  }

  /** Before sealing, a new recovery key supersedes the prior one for the same tuple. */
  async function rotate(stored: StoredExchange, input: ValidatedGrantExchangeRequest, options?: CallOptions): Promise<Step> {
    const claimed = await journal.claimKey({
      recordKey: stored.key,
      publicKey: input.encryptionKey.publicKey,
      expiresAt: iso(Date.parse(stored.record.createdAt) + KEY_INDEX_LIFETIME_MS),
    }, options);
    if (claimed !== 'claimed') return done(claimed === 'key_reuse' ? rejected('key_reuse') : unavailable());
    const saved = await journal.save(stored, {
      ...stored.record,
      encryptionPublicKey: input.encryptionKey.publicKey,
      encryptionKeyThumbprint: input.encryptionKey.thumbprint,
    }, options);
    return saved.kind === 'unavailable' ? done(unavailable()) : { kind: 'continue' };
  }

  /** Rechecks authority, then performs exactly one effect for the current phase. */
  async function advance(stored: StoredExchange, options?: CallOptions): Promise<Step> {
    const record = stored.record;
    const authority = await safe(() => deps.authority.authorize({
      operationId: record.operationId,
      requester: record.requester,
      origin: record.origin,
      sessionGeneration: record.sessionGeneration,
      sessionFingerprint: record.sessionFingerprint,
      claimOperationId: `${stored.key}#claim`,
    }, options));
    if (authority === null || authority.kind === 'unavailable') return done(unavailable());
    if (authority.kind === 'closed') return close(stored, authority.reason, options);
    const authorization = authority.authorization;
    if (!sameRequester(authorization, record)) return close(stored, 'closed', options);
    if (deps.clock() >= Date.parse(authorization.deadline)) return close(stored, 'expired', options);
    if (record.phase === 'bound') {
      const saved = await journal.save(stored, { ...record, phase: 'admitting' }, options);
      if (saved.kind !== 'saved') return saved.kind === 'conflict' ? { kind: 'continue' } : done(unavailable());
      return admit(saved.stored, authorization, false, options);
    }
    if (record.phase === 'admitting') return admit(stored, authorization, true, options);
    return seal(stored, authorization, options);
  }

  async function admit(
    stored: StoredExchange,
    authorization: ChannelAccessAuthorization,
    reconcileFirst: boolean,
    options?: CallOptions,
  ): Promise<Step> {
    const record = stored.record;
    const request: ChannelAdmissionRequest = {
      providerOperationId: record.providerOperationId,
      ownerId: authorization.ownerId,
      channelRef: authorization.channelRef,
      requester: record.requester,
      sessionGeneration: record.sessionGeneration,
      deviceId: record.deviceId,
      history: 'none',
    };
    // A resumed `admitting` record may already have committed; only proof of
    // non-application allows the same provider operation to be invoked.
    let result = reconcileFirst
      ? await safe(() => deps.provider.reconcile(request, options))
      : { kind: 'not_applied' as const };
    if (result?.kind === 'not_applied') result = await safe(() => deps.provider.admit(request, options));
    if (result === null || result.kind !== 'admitted') {
      if (result?.kind !== 'rejected') return done(unavailable());
      // Stay resumable until the journal request is closed too; the next retry reconciles
      // the same rejection and repeats the same idempotent close.
      const closed = await safe(() => deps.authority.close({ authorization, operationId: `${stored.key}#close` }, options));
      if (closed !== 'closed') return done(unavailable());
      return close(stored, 'closed', options);
    }
    const saved = await journal.save(stored, { ...record, phase: 'admitted', membership: result.membership }, options);
    return saved.kind === 'unavailable' ? done(unavailable()) : { kind: 'continue' };
  }

  async function seal(stored: StoredExchange, authorization: ChannelAccessAuthorization, options?: CallOptions): Promise<Step> {
    const record = stored.record;
    const now = deps.clock();
    const expiresAt = iso(now + CHANNEL_ACCESS_GRANT_LIFETIME_MS);
    const minted = await safe(() => deps.issuer.mint({
      binding: {
        operationId: record.operationId,
        requester: record.requester,
        origin: record.origin,
        sessionGeneration: record.sessionGeneration,
        deviceId: record.deviceId,
        proofKeyThumbprint: record.proofKeyThumbprint,
        ownerId: authorization.ownerId,
        channelRef: authorization.channelRef,
      },
      expiresAt,
    }, options));
    if (minted === null || minted.kind !== 'minted') return done(unavailable());
    const envelope = await sealGrantPayload({
      v: 1,
      operationId: record.operationId,
      requester: record.requester,
      origin: record.origin,
      sessionGeneration: record.sessionGeneration,
      deviceId: record.deviceId,
      proofKeyThumbprint: record.proofKeyThumbprint,
      recipientKeyThumbprint: record.encryptionKeyThumbprint,
      expiresAt,
      grant: minted.grant,
    }, record.encryptionPublicKey);
    if (envelope === null) return done(unavailable());
    const saved = await journal.save(stored, {
      ...record,
      phase: 'sealed',
      envelope,
      expiresAt: iso(now + CHANNEL_ACCESS_ENVELOPE_RECOVERY_MS),
    }, options);
    if (saved.kind === 'saved') return done(ok(envelope));
    // A racing exchange stored its envelope first; the next load returns those bytes.
    return saved.kind === 'conflict' ? { kind: 'continue' } : done(unavailable());
  }

  async function close(stored: StoredExchange, reason: 'expired' | 'closed', options?: CallOptions): Promise<Step> {
    await journal.save(stored, { ...stored.record, phase: 'closed', closed: reason }, options);
    return done(rejected(reason));
  }

  return Object.freeze({
    forConnector(connector: GrantExchangeConnector): AdmissionGrantExchangePort {
      return Object.freeze({
        exchange: (input: ValidatedGrantExchangeRequest, options?: CallOptions) => exchange(input, connector, options),
      });
    },
  });
}

function bindingDrift(
  record: ExchangeRecord,
  input: ValidatedGrantExchangeRequest,
  connector: GrantExchangeConnector,
): GrantExchangeRejection | null {
  if (record.sessionGeneration !== input.sessionGeneration) return 'wrong_generation';
  if (record.deviceId !== input.deviceId) return 'wrong_device';
  if (record.proofKeyThumbprint !== input.proofKey.thumbprint) return 'proof_mismatch';
  if (record.sessionFingerprint !== connector.sessionFingerprint) return 'operation_mismatch';
  return null;
}

function bindingOf(record: ExchangeRecord) {
  return {
    encryptionKeyPublicKey: record.encryptionPublicKey,
    encryptionKeyThumbprint: record.encryptionKeyThumbprint,
    proofKeyThumbprint: record.proofKeyThumbprint,
    operationId: record.operationId,
    deviceId: record.deviceId,
    requester: record.requester,
    origin: record.origin,
    sessionGeneration: record.sessionGeneration,
  };
}

function sameRequester(authorization: ChannelAccessAuthorization, record: ExchangeRecord): boolean {
  return authorization.kind === 'access'
    && authorization.operationId === record.operationId
    && authorization.requester === record.requester
    && authorization.origin === record.origin
    && authorization.sessionGeneration === record.sessionGeneration
    && authorization.sessionFingerprint === record.sessionFingerprint;
}

function done(result: ExchangeResult): Step {
  return { kind: 'done', result };
}

function ok(value: SealedGrantEnvelope): ExchangeResult {
  return { kind: 'ok', value };
}

function rejected(code: GrantExchangeRejection): ExchangeResult {
  return { kind: 'rejected', code };
}

function unavailable(): ExchangeResult {
  return { kind: 'unavailable', retryable: true };
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

async function safe<T>(operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation();
  } catch {
    return null;
  }
}
