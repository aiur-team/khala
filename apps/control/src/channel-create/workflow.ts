// Human-confirmed channel creation (RD9A, `channel-create-workflow`). An agent's
// create intent is only a journal row; this workflow runs after the owner
// approves it. It claims the approved row through the journal's typed create
// fulfillment port, which rechecks owner authority and requester revocation on
// every call, then creates exactly one owner-controlled channel through a
// hosted or internal adapter. The create record is written before the adapter
// is invoked, so a lost response or a restart reconciles the same channel
// instead of creating a second one.

import { createHash, randomUUID } from 'node:crypto';
import {
  type AuthorizedChannelRef,
  type CallOptions,
  type ChannelAccessFulfillmentPort,
  type ChannelCreateAdapterPort,
  type ChannelCreateAuthorization,
  type ChannelCreateReconciliation,
  type ControlStore,
  type HumanAuthorizedWorkflowContext,
  type TrustedClock,
  decodeChannelCreateReconciliation,
} from '@khala/contracts/messaging/index';
import type { ChannelAccessStore } from '../channel-access/store';

export type ChannelCreateFulfillment =
  | Readonly<{ kind: 'created'; channelRef: AuthorizedChannelRef; authorization: ChannelCreateAuthorization }>
  /** Terminal: denied by the provider, revoked, expired, or no longer this owner's to create. */
  | Readonly<{ kind: 'closed'; reason: 'expired' | 'closed' }>
  /** Not approved yet, or creation could not be proven now. Retry the same request. */
  | Readonly<{ kind: 'unavailable' }>;

export type ChannelCreateWorkflow = Readonly<{
  /** Idempotent per request handle; safe to call from approval, inbox reads, and the grant exchange. */
  fulfill(requestHandle: string, options?: CallOptions): Promise<ChannelCreateFulfillment>;
  /** A cheap read: `true` while creation for this request is not yet created or closed. */
  unsettled(requestHandle: string, options?: CallOptions): Promise<boolean>;
}>;

type CreatePhase = 'creating' | 'created' | 'closed';

type CreateRecord = Readonly<{
  v: 1;
  requestHandle: string;
  idempotencyKey: string;
  phase: CreatePhase;
  channelRef: string | null;
  /** While set and in the future, another attempt may be creating; nobody else invokes the adapter. */
  leaseUntil: string | null;
}>;

type Stored = Readonly<{ revision: string; record: CreateRecord }>;

const MAX_STEPS = 6;
/** Matches the messaging create lease: longer than any single substrate create call. */
const CREATE_LEASE_MS = 120_000;

export function createChannelCreateWorkflow(deps: Readonly<{
  store: ControlStore;
  journal: Pick<ChannelAccessStore, 'readContext'>;
  fulfillment: Pick<ChannelAccessFulfillmentPort, 'claimCreate' | 'updateCreate'>;
  adapter: ChannelCreateAdapterPort;
  clock: TrustedClock;
}>): ChannelCreateWorkflow {
  async function fulfill(requestHandle: string, options?: CallOptions): Promise<ChannelCreateFulfillment> {
    const located = await safe(() => deps.journal.readContext({ requestHandle }, options));
    if (located === null || located.kind === 'unavailable') return unavailable();
    if (located.kind !== 'found' || located.context.detail.kind !== 'create') return closed('closed');
    const context = located.context;
    // Nothing happens before the owner decides; this is the guard the agent cannot pass.
    if (context.outcome === 'pending_owner') return unavailable();
    if (deps.clock() >= Date.parse(context.deadline) || context.outcome === 'expired') return closed('expired');
    // Denied, revoked, or already finished: a replayed claim must not create.
    if (context.outcome !== 'approved' && context.outcome !== 'connecting') return closed('closed');
    const key = recordKey(requestHandle);
    const claimed = await safe(() => deps.fulfillment.claimCreate({
      v: 1,
      requestHandle: requestHandle as ChannelCreateAuthorization['requestHandle'],
      expectedRevision: `carev_${context.revision}`,
      operationId: `${key}#claim`,
    }, options));
    if (claimed === null || claimed.kind === 'unavailable' || claimed.kind === 'outcome_unknown') return unavailable();
    if (claimed.kind === 'rejected') {
      if (claimed.code === 'expired') return closed('expired');
      // A concurrent journal write moved the row; the caller retries with a fresh read.
      return claimed.code === 'stale_revision' ? unavailable() : closed('closed');
    }
    const authorization = claimed.value;
    if (authorization.requestHandle !== requestHandle || deps.clock() >= Date.parse(authorization.deadline)) {
      return closed('expired');
    }
    return await advance(key, authorization, options);
  }

  async function advance(
    key: string,
    authorization: ChannelCreateAuthorization,
    options?: CallOptions,
  ): Promise<ChannelCreateFulfillment> {
    const idempotencyKey = createIdempotencyKey(authorization.requestHandle);
    const workflow: HumanAuthorizedWorkflowContext = {
      v: 1,
      kind: 'human_authorized_channel_create',
      ownerId: authorization.ownerId,
      authorizationRef: authorization.authorizationRef,
      expiresAt: authorization.deadline,
    };
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const loaded = await load(key, options);
      if (loaded === 'unavailable') return unavailable();
      if (loaded === 'absent') {
        // Persist the attempt and its lease before the effect, so any resume reconciles first.
        const leased = await write(key, null, {
          v: 1,
          requestHandle: authorization.requestHandle,
          idempotencyKey,
          phase: 'creating',
          channelRef: null,
          leaseUntil: leaseFrom(deps.clock()),
        }, options);
        if (leased === 'unavailable') return unavailable();
        if (leased === 'applied') return await settle(key, authorization, await create(idempotencyKey, authorization, workflow, options), options);
        continue;
      }
      const { record } = loaded;
      if (record.requestHandle !== authorization.requestHandle || record.idempotencyKey !== idempotencyKey) {
        return unavailable();
      }
      if (record.phase === 'created') {
        return { kind: 'created', channelRef: record.channelRef as AuthorizedChannelRef, authorization };
      }
      if (record.phase === 'closed') return await closeJournal(key, authorization, options);
      const reconciled = await checked(idempotencyKey, () => deps.adapter.reconcile({ workflow, idempotencyKey }, options));
      if (reconciled === null) return unavailable();
      if (reconciled.outcome !== 'pending') return await settle(key, authorization, reconciled, options);
      // Proven not applied. Another attempt may still be in flight until its lease ends.
      if (record.leaseUntil !== null && deps.clock() < Date.parse(record.leaseUntil)) return unavailable();
      const leased = await write(key, loaded.revision, { ...record, leaseUntil: leaseFrom(deps.clock()) }, options);
      if (leased === 'unavailable') return unavailable();
      if (leased === 'applied') return await settle(key, authorization, await create(idempotencyKey, authorization, workflow, options), options);
    }
    return unavailable();
  }

  async function create(
    idempotencyKey: string,
    authorization: ChannelCreateAuthorization,
    workflow: HumanAuthorizedWorkflowContext,
    options?: CallOptions,
  ): Promise<ChannelCreateReconciliation | null> {
    return await checked(idempotencyKey, () => deps.adapter.create({
      intent: {
        v: 1,
        operationId: authorization.operationId,
        // The discovery credential is short-lived and never retained; the adapter gets the approval reference.
        credentialRef: authorization.authorizationRef,
        origin: authorization.origin,
        proposedTitle: authorization.proposedTitle,
      },
      workflow,
      idempotencyKey,
    }, options));
  }

  /** Records a proven outcome. Anything unproven keeps the record `creating` for the next reconcile. */
  async function settle(
    key: string,
    authorization: ChannelCreateAuthorization,
    outcome: ChannelCreateReconciliation | null,
    options?: CallOptions,
  ): Promise<ChannelCreateFulfillment> {
    if (outcome === null) return unavailable();
    const created = outcome.outcome === 'created' || outcome.outcome === 'already_created';
    if (!created && outcome.outcome !== 'denied') return unavailable();
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const loaded = await load(key, options);
      if (loaded === 'unavailable' || loaded === 'absent') return unavailable();
      const { record } = loaded;
      if (record.phase === 'created') {
        return { kind: 'created', channelRef: record.channelRef as AuthorizedChannelRef, authorization };
      }
      if (record.phase === 'closed') return await closeJournal(key, authorization, options);
      const next: CreateRecord = created
        ? { ...record, phase: 'created', channelRef: outcome.channelRef, leaseUntil: null }
        : { ...record, phase: 'closed', leaseUntil: null };
      const saved = await write(key, loaded.revision, next, options);
      if (saved === 'unavailable') return unavailable();
      if (saved === 'conflict') continue;
      if (created) return { kind: 'created', channelRef: outcome.channelRef!, authorization };
      return await closeJournal(key, authorization, options);
    }
    return unavailable();
  }

  /**
   * The provider refused: the journal row closes and nothing is admitted. Repeated
   * with the same operation on every later call until the journal confirms it.
   */
  async function closeJournal(
    key: string,
    authorization: ChannelCreateAuthorization,
    options?: CallOptions,
  ): Promise<ChannelCreateFulfillment> {
    const updated = await safe(() => deps.fulfillment.updateCreate({
      v: 1,
      requestHandle: authorization.requestHandle,
      expectedRevision: authorization.requestRevision,
      operationId: `${key}#closed`,
      outcome: 'revoked',
    }, options));
    return updated === null || updated.kind === 'unavailable' || updated.kind === 'outcome_unknown'
      ? unavailable()
      : closed('closed');
  }

  async function load(key: string, options?: CallOptions): Promise<Stored | 'absent' | 'unavailable'> {
    const read = await safe(() => deps.store.read(key, options));
    if (read === null || read.kind === 'unavailable') return 'unavailable';
    if (read.kind === 'absent') return 'absent';
    const record = readRecord(read.record.value);
    return record === null ? 'unavailable' : { revision: read.record.revision, record };
  }

  async function write(
    key: string,
    expectedRevision: string | null,
    next: CreateRecord,
    options?: CallOptions,
  ): Promise<'applied' | 'conflict' | 'unavailable'> {
    // Unique per attempt: two callers with identical bytes must conflict, not both see their own write applied.
    const operationId = `${key}#${next.phase}#${randomUUID()}`;
    const result = await safe(() => deps.store.compareAndSet({
      key,
      expectedRevision,
      operationId,
      next: { value: next, expiresAt: null },
    }, options));
    if (result === null || result.kind === 'unavailable' || result.kind === 'operation_mismatch') return 'unavailable';
    if (result.kind === 'applied') return 'applied';
    if (result.kind === 'conflict') return 'conflict';
    const resolved = await safe(() => deps.store.resolve({ key, operationId }, options));
    if (resolved?.kind === 'applied') return 'applied';
    // Not proven either way: a fresh read decides the next step.
    return resolved?.kind === 'not_applied' ? 'conflict' : 'unavailable';
  }

  async function unsettled(requestHandle: string, options?: CallOptions): Promise<boolean> {
    const loaded = await load(recordKey(requestHandle), options);
    return loaded === 'absent' || (loaded !== 'unavailable' && loaded.record.phase === 'creating');
  }

  return Object.freeze({ fulfill, unsettled });
}

export function channelCreateRecordKey(requestHandle: string): string {
  return recordKey(requestHandle);
}

function recordKey(requestHandle: string): string {
  return `channel-create/${digest('khala.channel-create.record.v1', requestHandle)}`;
}

function createIdempotencyKey(requestHandle: string): string {
  return `chcreate_${Buffer.from(createHash('sha256')
    .update('khala.channel-create.idempotency.v1\0')
    .update(requestHandle)
    .digest()).toString('base64url')}`;
}

function digest(purpose: string, value: string): string {
  return createHash('sha256').update(`${purpose}\0`).update(value).digest('hex');
}

/** Adapter output is decoded and bound to this key before it can move the record. */
async function checked(
  idempotencyKey: string,
  call: () => Promise<ChannelCreateReconciliation>,
): Promise<ChannelCreateReconciliation | null> {
  const raw = await safe(call);
  if (raw === null) return null;
  const decoded = decodeChannelCreateReconciliation(raw);
  if (!decoded.ok || decoded.value.idempotencyKey !== idempotencyKey) return null;
  return decoded.value;
}

function readRecord(value: unknown): CreateRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1
    || typeof record.requestHandle !== 'string'
    || typeof record.idempotencyKey !== 'string'
    || (record.leaseUntil !== null && typeof record.leaseUntil !== 'string')
    || (record.phase !== 'creating' && record.phase !== 'created' && record.phase !== 'closed')) return null;
  if (record.phase === 'created' ? typeof record.channelRef !== 'string' : record.channelRef !== null) return null;
  return record as unknown as CreateRecord;
}

function leaseFrom(nowMs: number): string {
  return new Date(nowMs + CREATE_LEASE_MS).toISOString();
}

function closed(reason: 'expired' | 'closed'): ChannelCreateFulfillment {
  return { kind: 'closed', reason };
}

function unavailable(): ChannelCreateFulfillment {
  return { kind: 'unavailable' };
}

async function safe<T>(operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation();
  } catch {
    return null;
  }
}
