// Durable channel-access journal. Every invariant that spans requesters, owners,
// cooldowns, mutes and notification reservations is committed in one aggregate
// CAS. Raw submitted locators never cross this boundary.

import type {
  CallOptions,
  ControlRecord,
  ControlStore,
  JsonValue,
  TrustedClock,
  WriteResult,
} from '@khala/contracts/messaging/index';
import {
  CHANNEL_ACCESS_COOLDOWN_MS,
  CHANNEL_ACCESS_DEADLINE_MS,
  CHANNEL_ACCESS_PURGE_MS,
  type ChannelAccessDerivationInput,
  type ChannelAccessPolicy,
} from './policy';

const JOURNAL_KEY = 'channel-access.journal.v1';
const NOTIFICATION_WINDOW_MS = 60_000;
const INDIVIDUAL_NOTIFICATION_LIMIT = 9;

export type ChannelAccessOutcome =
  | 'pending_owner'
  | 'approved'
  | 'connecting'
  | 'connected'
  | 'repair_required'
  | 'denied'
  | 'expired'
  | 'revoked';

export type ChannelAccessDetail =
  | Readonly<{ kind: 'access'; authorizedChannelRef: string; targetRevision: string; title: string }>
  | Readonly<{ kind: 'create'; proposalDigest: string; proposedTitle: string; ownerRevision: string }>;

export type ChannelAccessCreateInput = Readonly<{
  requester: string;
  sessionFingerprint: string;
  sessionGeneration: number;
  origin: string;
  operationId: string;
  ownerId: string;
  targetFingerprint: string;
  detail: ChannelAccessDetail;
  harness: string;
  requesterLabel: string | null;
  workspaceLabel: string | null;
}>;

export type ChannelAccessBindingInput = ChannelAccessDerivationInput;

export type ChannelAccessRequesterLookup = Readonly<{
  requester: string;
  sessionFingerprint: string;
  sessionGeneration: number;
  origin: string;
  kind: 'access' | 'create';
  operationId: string;
}>;

export type ChannelAccessStatus = Readonly<{
  outcome: ChannelAccessOutcome;
  revision?: number;
  deadline?: string;
}>;

export type ChannelAccessOwnerProjection = Readonly<{
  requestHandle: string;
  kind: 'access' | 'create';
  outcome: ChannelAccessOutcome;
  revision: number;
  createdAt: string;
  deadline: string;
  sessionFingerprint: string;
  harness: string;
  requesterLabel: string | null;
  workspaceLabel: string | null;
  title: string | null;
  proposedTitle: string | null;
  ownerDecision: 'pending' | 'approved' | 'denied';
  decidedAt: string | null;
  muted: boolean;
  muteRevision: number | null;
}>;

export type ChannelAccessStoredContext = Readonly<{
  requestHandle: string;
  operationId: string;
  ownerId: string;
  revision: number;
  requester: string;
  sessionFingerprint: string;
  sessionGeneration: number;
  origin: string;
  harness: string;
  requesterLabel: string | null;
  workspaceLabel: string | null;
  targetFingerprint: string;
  deadline: string;
  outcome: ChannelAccessOutcome;
  detail: ChannelAccessDetail;
}>;

export type ChannelAccessAuthorization =
  | Readonly<{
    v: 1;
    kind: 'access';
    requestHandle: string;
    ownerId: string;
    requester: string;
    sessionFingerprint: string;
    sessionGeneration: number;
    origin: string;
    operationId: string;
    authorizedChannelRef: string;
    approvedAt: string;
    deadline: string;
  }>
  | Readonly<{
    v: 1;
    kind: 'create';
    requestHandle: string;
    ownerId: string;
    requester: string;
    sessionFingerprint: string;
    sessionGeneration: number;
    origin: string;
    operationId: string;
    proposalDigest: string;
    proposedTitle: string;
    approvedAt: string;
    deadline: string;
  }>;

export type ChannelAccessNotification = Readonly<{
  id: string;
  kind: 'request' | 'batch';
  requestHandle: string | null;
  revision: number;
  count: number;
  createdAt: string;
}>;

export interface ChannelAccessStore {
  create(input: ChannelAccessCreateInput, options?: CallOptions): Promise<
    | Readonly<{ kind: 'accepted'; requestHandle: string; revision: number; deadline: string; outcome: ChannelAccessOutcome }>
    | Readonly<{ kind: 'unavailable' }>
  >;
  inspect(input: ChannelAccessBindingInput | ChannelAccessCreateInput, options?: CallOptions): Promise<
    | Readonly<{ kind: 'found'; status: ChannelAccessStatus }>
    | Readonly<{ kind: 'unavailable' }>
  >;
  inspectRequester(input: ChannelAccessRequesterLookup, options?: CallOptions): Promise<
    | Readonly<{ kind: 'found'; status: ChannelAccessStatus; context: ChannelAccessStoredContext }>
    | Readonly<{ kind: 'unavailable' }>
  >;
  listOwner(input: Readonly<{ ownerId: string }>, options?: CallOptions): Promise<
    | Readonly<{ kind: 'found'; requests: readonly ChannelAccessOwnerProjection[] }>
    | Readonly<{ kind: 'unavailable' }>
  >;
  readOwner(input: Readonly<{ ownerId: string; requestHandle: string }>, options?: CallOptions): Promise<
    | Readonly<{ kind: 'found'; request: ChannelAccessOwnerProjection }>
    | Readonly<{ kind: 'not_found' }>
    | Readonly<{ kind: 'unavailable' }>
  >;
  readContext(input: Readonly<{ requestHandle: string }>, options?: CallOptions): Promise<
    | Readonly<{ kind: 'found'; context: ChannelAccessStoredContext }>
    | Readonly<{ kind: 'not_found' | 'unavailable' }>
  >;
  decide(input: Readonly<{
    ownerId: string;
    requestHandle: string;
    expectedRevision: number;
    decision: 'approve' | 'deny';
    operationId: string;
  }>, options?: CallOptions): Promise<
    | Readonly<{ kind: 'decided'; outcome: 'approved' | 'denied'; revision: number }>
    | Readonly<{ kind: 'stale' | 'conflict' | 'expired' | 'not_found' | 'unavailable' }>
  >;
  setMute(input: Readonly<{
    ownerId: string;
    requester: string;
    kind: 'access' | 'create';
    targetFingerprint: string;
    action: 'mute' | 'unmute';
    expectedRevision: number | null;
    operationId: string;
  }>, options?: CallOptions): Promise<
    | Readonly<{ kind: 'updated'; enabled: boolean; revision: number }>
    | Readonly<{ kind: 'stale' | 'conflict' | 'unavailable' }>
  >;
  setMuteForRequest(input: Readonly<{
    ownerId: string;
    requestHandle: string;
    action: 'mute' | 'unmute';
    expectedRevision: number | null;
    operationId: string;
  }>, options?: CallOptions): ReturnType<ChannelAccessStore['setMute']>;
  claimAccess(input: FulfillmentClaimInput, options?: CallOptions): Promise<ClaimResult<'access'>>;
  claimCreate(input: FulfillmentClaimInput, options?: CallOptions): Promise<ClaimResult<'create'>>;
  updateLifecycle(input: Readonly<{
    requestHandle: string;
    expectedRevision: number;
    consumerId: string;
    outcome: 'connected' | 'repair_required' | 'revoked';
    operationId: string;
  }>, options?: CallOptions): Promise<
    | Readonly<{ kind: 'updated'; outcome: 'connected' | 'repair_required' | 'revoked'; revision: number }>
    | Readonly<{ kind: 'stale' | 'conflict' | 'not_found' | 'unavailable' }>
  >;
  revoke(input: Readonly<{
    binding: ChannelAccessBindingInput | ChannelAccessCreateInput;
    expectedRevision: number;
    operationId: string;
  }>, options?: CallOptions): Promise<
    | Readonly<{ kind: 'updated'; outcome: 'revoked'; revision: number }>
    | Readonly<{ kind: 'stale' | 'not_found' | 'unavailable' }>
  >;
  listNotifications(input: Readonly<{ ownerId: string; limit?: number }>, options?: CallOptions): Promise<
    | Readonly<{ kind: 'found'; notifications: readonly ChannelAccessNotification[] }>
    | Readonly<{ kind: 'unavailable' }>
  >;
  ackNotification(input: Readonly<{
    ownerId: string;
    notificationId: string;
    revision: number;
    operationId: string;
  }>, options?: CallOptions): Promise<Readonly<{ kind: 'acknowledged' | 'stale' | 'not_found' | 'unavailable' }>>;
}

export type FulfillmentClaimInput = Readonly<{
  binding: ChannelAccessBindingInput | ChannelAccessCreateInput;
  expectedRevision: number;
  consumerId: string;
  operationId: string;
}>;

export type ClaimResult<K extends 'access' | 'create'> =
  | Readonly<{
    kind: 'claimed';
    authorization: Extract<ChannelAccessAuthorization, { kind: K }>;
    revision: number;
  }>
  | Readonly<{ kind: 'stale' | 'conflict' | 'expired' | 'unavailable' }>;

type StoredDecision = Readonly<{
  operationId: string;
  decision: 'approve' | 'deny';
  decidedAt: string;
}>;

type StoredClaim = Readonly<{
  operationId: string;
  consumerId: string;
  claimedAt: string;
  revision: number;
}>;

type StoredLifecycle = Readonly<{
  operationId: string;
  outcome: 'connected' | 'repair_required' | 'revoked';
}>;

type StoredRequest = Readonly<{
  operationKey: string;
  bindingDigest: string;
  requestHandle: string;
  requesterKey: string;
  operationId: string;
  requester: string;
  sessionFingerprint: string;
  sessionGeneration: number;
  origin: string;
  ownerId: string;
  targetFingerprint: string;
  cooldownKey: string;
  muteKey: string;
  notificationId: string;
  detail: ChannelAccessDetail;
  harness: string;
  requesterLabel: string | null;
  workspaceLabel: string | null;
  createdAt: string;
  deadline: string;
  outcome: ChannelAccessOutcome;
  revision: number;
  approvedAt: string | null;
  terminalAt: string | null;
  decision: StoredDecision | null;
  claim: StoredClaim | null;
  lifecycle: StoredLifecycle | null;
}>;

type StoredMute = Readonly<{
  ownerId: string;
  kind: 'access' | 'create';
  targetFingerprint: string | null;
  enabled: boolean;
  revision: number;
  operationId: string;
  updatedAt: string;
}>;

type StoredNotification = Readonly<{
  id: string;
  ownerId: string;
  operationKeys: readonly string[];
  requestHandle: string | null;
  kind: 'request' | 'batch';
  window: number;
  revision: number;
  count: number;
  deliveredRevision: number;
  ackOperationId: string | null;
  createdAt: string;
}>;

type StoredTombstone = Readonly<{
  outcome: 'connected' | 'repair_required' | 'denied' | 'expired' | 'revoked';
}>;

type JournalAggregate = Readonly<{
  v: 1;
  recordType: 'channel_access_journal';
  requests: Readonly<Record<string, StoredRequest>>;
  mutes: Readonly<Record<string, StoredMute>>;
  notifications: Readonly<Record<string, StoredNotification>>;
  tombstones: Readonly<Record<string, StoredTombstone>>;
}>;

type Loaded = Readonly<{ revision: string | null; value: JournalAggregate }>;
type Settled =
  | Readonly<{ kind: 'applied'; record: ControlRecord<JournalAggregate> }>
  | Readonly<{ kind: 'conflict'; current: ControlRecord<JournalAggregate> | null }>
  | Readonly<{ kind: 'operation_mismatch' | 'unavailable' }>;
type Mutation<R> = Readonly<{ result: R; value: JournalAggregate | null }>;

const STORE_UNAVAILABLE = Symbol('store_unavailable');

export function createChannelAccessStore(deps: Readonly<{
  store: ControlStore;
  policy: ChannelAccessPolicy;
  clock: TrustedClock;
}>): ChannelAccessStore {
  const { policy } = deps;

  async function readAggregate(options?: CallOptions): Promise<Loaded | typeof STORE_UNAVAILABLE> {
    let result;
    try {
      result = await deps.store.read<JournalAggregate>(JOURNAL_KEY, options);
    } catch {
      return STORE_UNAVAILABLE;
    }
    if (result.kind === 'unavailable') return STORE_UNAVAILABLE;
    if (result.kind === 'absent') return { revision: null, value: emptyAggregate() };
    const value = decodeAggregate(result.record.value);
    return value ? { revision: result.record.revision, value } : STORE_UNAVAILABLE;
  }

  async function settle(input: Readonly<{
    expectedRevision: string | null;
    operationId: string;
    value: JournalAggregate;
  }>, options?: CallOptions): Promise<Settled> {
    const write = {
      key: JOURNAL_KEY,
      expectedRevision: input.expectedRevision,
      operationId: input.operationId,
      next: { value: input.value, expiresAt: null },
    } as const;
    let first: WriteResult<JournalAggregate>;
    try {
      first = await deps.store.compareAndSet(write, options);
    } catch {
      return { kind: 'unavailable' };
    }
    if (first.kind !== 'outcome_unknown') return first;
    let resolved;
    try {
      resolved = await deps.store.resolve<JournalAggregate>({ key: JOURNAL_KEY, operationId: input.operationId }, options);
    } catch {
      return { kind: 'unavailable' };
    }
    if (resolved.kind === 'applied') return resolved;
    if (resolved.kind !== 'not_applied') return { kind: 'unavailable' };
    try {
      const retried = await deps.store.compareAndSet(write, options);
      return retried.kind === 'outcome_unknown' ? { kind: 'unavailable' } : retried;
    } catch {
      return { kind: 'unavailable' };
    }
  }

  async function mutate<R>(
    action: string,
    clientOperationId: string,
    apply: (aggregate: JournalAggregate, now: number) => Mutation<R>,
    options?: CallOptions,
  ): Promise<R | typeof STORE_UNAVAILABLE> {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const loaded = await readAggregate(options);
      if (loaded === STORE_UNAVAILABLE) return STORE_UNAVAILABLE;
      const now = deps.clock();
      const maintained = maintain(loaded.value, now);
      const mutation = apply(maintained.value, now);
      if (!maintained.changed && mutation.value === null) return mutation.result;
      const operationId = policy.digest('operation', [
        ['action', action],
        ['clientOperationId', clientOperationId],
        ['aggregateRevision', loaded.revision ?? 'absent'],
        ['now', now],
      ]);
      const settled = await settle({
        expectedRevision: loaded.revision,
        operationId,
        value: mutation.value ?? maintained.value,
      }, options);
      if (settled.kind === 'applied') return mutation.result;
      if (settled.kind === 'unavailable' || settled.kind === 'operation_mismatch') return STORE_UNAVAILABLE;
    }
    return STORE_UNAVAILABLE;
  }

  function changed<R>(value: JournalAggregate, result: R): Mutation<R> {
    return { result, value };
  }
  function unchanged<R>(result: R): Mutation<R> {
    return { result, value: null };
  }

  async function create(input: ChannelAccessCreateInput, options?: CallOptions): ReturnType<ChannelAccessStore['create']> {
    let artifacts;
    try {
      artifacts = policy.derive(derivation(input));
    } catch {
      return { kind: 'unavailable' };
    }
    const result = await mutate('create', artifacts.operationKey, (aggregate, now) => {
      const tombstone = aggregate.tombstones[artifacts.operationKey];
      if (tombstone) return unchanged({ kind: 'unavailable' as const });
      const existing = aggregate.requests[artifacts.operationKey];
      if (existing) {
        return unchanged(existing.bindingDigest === artifacts.bindingDigest
          ? acceptedResponse(existing)
          : { kind: 'unavailable' as const });
      }
      const muteKey = scopeKey(policy, 'mute', input);
      if (aggregate.mutes[muteKey]?.enabled) return unchanged({ kind: 'unavailable' as const });
      const requesterKey = artifacts.requesterKey;
      const active = Object.values(aggregate.requests).filter(request => activeForCapacity(request.outcome));
      if (active.filter(request => request.requesterKey === requesterKey).length >= policy.limits.requesterMax
        || active.filter(request => request.ownerId === input.ownerId).length >= policy.limits.ownerMax) {
        return unchanged({ kind: 'unavailable' as const });
      }
      const cooldownKey = scopeKey(policy, 'cooldown', input);
      if (Object.values(aggregate.requests).some(request => request.cooldownKey === cooldownKey
        && now < Date.parse(request.createdAt) + CHANNEL_ACCESS_COOLDOWN_MS)) {
        return unchanged({ kind: 'unavailable' as const });
      }
      const value = cloneAggregate(aggregate);
      const row: StoredRequest = {
        operationKey: artifacts.operationKey,
        bindingDigest: artifacts.bindingDigest,
        requestHandle: artifacts.requestHandle,
        requesterKey,
        operationId: input.operationId,
        requester: input.requester,
        sessionFingerprint: input.sessionFingerprint,
        sessionGeneration: input.sessionGeneration,
        origin: input.origin,
        ownerId: input.ownerId,
        targetFingerprint: input.targetFingerprint,
        cooldownKey,
        muteKey,
        notificationId: artifacts.notificationId,
        detail: input.detail,
        harness: input.harness,
        requesterLabel: input.requesterLabel,
        workspaceLabel: input.workspaceLabel,
        createdAt: iso(now),
        deadline: iso(now + CHANNEL_ACCESS_DEADLINE_MS),
        outcome: 'pending_owner',
        revision: 1,
        approvedAt: null,
        terminalAt: null,
        decision: null,
        claim: null,
        lifecycle: null,
      };
      value.requests[artifacts.operationKey] = row;
      reserveNotification(value, row, policy, now);
      return changed(value, acceptedResponse(row));
    }, options);
    return result === STORE_UNAVAILABLE ? { kind: 'unavailable' } : result;
  }

  async function inspect(input: ChannelAccessBindingInput | ChannelAccessCreateInput, options?: CallOptions): ReturnType<ChannelAccessStore['inspect']> {
    let artifacts;
    try {
      artifacts = policy.derive(derivation(input));
    } catch {
      return { kind: 'unavailable' };
    }
    const result = await mutate('inspect', artifacts.operationKey, aggregate => {
      const row = aggregate.requests[artifacts.operationKey];
      if (row) {
        return unchanged(row.bindingDigest === artifacts.bindingDigest
          ? { kind: 'found' as const, status: status(row) }
          : { kind: 'unavailable' as const });
      }
      return unchanged({ kind: 'unavailable' as const });
    }, options);
    return result === STORE_UNAVAILABLE ? { kind: 'unavailable' } : result;
  }

  async function inspectRequester(input: ChannelAccessRequesterLookup, options?: CallOptions): ReturnType<ChannelAccessStore['inspectRequester']> {
    const operationKey = policy.digest('operation', [
      ['requester', input.requester],
      ['operationId', input.operationId],
    ]);
    const result = await mutate('requester-inspect', operationKey, aggregate => {
      const row = aggregate.requests[operationKey];
      const matches = row
        && row.requester === input.requester
        && row.sessionFingerprint === input.sessionFingerprint
        && row.sessionGeneration === input.sessionGeneration
        && row.origin === input.origin
        && row.detail.kind === input.kind;
      return unchanged(matches
        ? { kind: 'found' as const, status: status(row), context: storedContext(row) }
        : { kind: 'unavailable' as const });
    }, options);
    return result === STORE_UNAVAILABLE ? { kind: 'unavailable' } : result;
  }

  async function listOwner(input: Readonly<{ ownerId: string }>, options?: CallOptions): ReturnType<ChannelAccessStore['listOwner']> {
    const result = await mutate('owner-list', input.ownerId, aggregate => unchanged({
      kind: 'found' as const,
      requests: Object.values(aggregate.requests)
        .filter(request => request.ownerId === input.ownerId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(request => ownerProjection(request, aggregate.mutes[request.muteKey])),
    }), options);
    return result === STORE_UNAVAILABLE ? { kind: 'unavailable' } : result;
  }

  async function readOwner(input: Readonly<{ ownerId: string; requestHandle: string }>, options?: CallOptions): ReturnType<ChannelAccessStore['readOwner']> {
    const result = await mutate('owner-read', input.requestHandle, aggregate => {
      const row = findHandle(aggregate, input.requestHandle);
      return unchanged(row?.ownerId === input.ownerId
        ? { kind: 'found' as const, request: ownerProjection(row, aggregate.mutes[row.muteKey]) }
        : { kind: 'not_found' as const });
    }, options);
    return result === STORE_UNAVAILABLE ? { kind: 'unavailable' } : result;
  }

  async function readContext(input: Readonly<{ requestHandle: string }>, options?: CallOptions): ReturnType<ChannelAccessStore['readContext']> {
    const result = await mutate('context-read', input.requestHandle, aggregate => {
      const row = findHandle(aggregate, input.requestHandle);
      return unchanged(row
        ? { kind: 'found' as const, context: storedContext(row) }
        : { kind: 'not_found' as const });
    }, options);
    return result === STORE_UNAVAILABLE ? { kind: 'unavailable' } : result;
  }

  async function decide(input: Parameters<ChannelAccessStore['decide']>[0], options?: CallOptions): ReturnType<ChannelAccessStore['decide']> {
    const result = await mutate<Awaited<ReturnType<ChannelAccessStore['decide']>>>('decision', input.operationId, (aggregate, now) => {
      const row = findHandle(aggregate, input.requestHandle);
      if (!row || row.ownerId !== input.ownerId) return unchanged({ kind: 'not_found' as const });
      if (row.decision?.operationId === input.operationId) {
        return unchanged(row.decision.decision === input.decision
          ? { kind: 'decided' as const, outcome: row.outcome as 'approved' | 'denied', revision: row.revision }
          : { kind: 'conflict' as const });
      }
      if (row.outcome === 'expired') return unchanged({ kind: 'expired' as const });
      if (row.revision !== input.expectedRevision) return unchanged({ kind: 'stale' as const });
      if (row.outcome !== 'pending_owner') return unchanged({ kind: 'conflict' as const });
      const value = cloneAggregate(aggregate);
      const outcome = input.decision === 'approve' ? 'approved' : 'denied';
      const next: StoredRequest = {
        ...row,
        outcome,
        revision: row.revision + 1,
        approvedAt: outcome === 'approved' ? iso(now) : null,
        terminalAt: outcome === 'denied' ? iso(now) : null,
        decision: { operationId: input.operationId, decision: input.decision, decidedAt: iso(now) },
      };
      value.requests[row.operationKey] = next;
      if (outcome === 'denied') suppressNotification(value, row.operationKey);
      return changed(value, { kind: 'decided' as const, outcome, revision: next.revision });
    }, options);
    return result === STORE_UNAVAILABLE ? { kind: 'unavailable' } : result;
  }

  async function setMute(input: Parameters<ChannelAccessStore['setMute']>[0], options?: CallOptions): ReturnType<ChannelAccessStore['setMute']> {
    const muteKey = scopeKey(policy, 'mute', input);
    const result = await mutate<Awaited<ReturnType<ChannelAccessStore['setMute']>>>('mute', input.operationId, (aggregate, now) => {
      const current = aggregate.mutes[muteKey];
      const enabled = input.action === 'mute';
      if (current?.operationId === input.operationId) {
        return unchanged(current.enabled === enabled
          ? { kind: 'updated' as const, enabled, revision: current.revision }
          : { kind: 'conflict' as const });
      }
      if ((current?.revision ?? null) !== input.expectedRevision) return unchanged({ kind: 'stale' as const });
      const value = cloneAggregate(aggregate);
      const revision = (current?.revision ?? 0) + 1;
      value.mutes[muteKey] = {
        ownerId: input.ownerId,
        kind: input.kind,
        targetFingerprint: input.kind === 'access' ? input.targetFingerprint : null,
        enabled,
        revision,
        operationId: input.operationId,
        updatedAt: iso(now),
      };
      return changed(value, { kind: 'updated' as const, enabled, revision });
    }, options);
    return result === STORE_UNAVAILABLE ? { kind: 'unavailable' } : result;
  }

  async function setMuteForRequest(
    input: Parameters<ChannelAccessStore['setMuteForRequest']>[0],
    options?: CallOptions,
  ): ReturnType<ChannelAccessStore['setMuteForRequest']> {
    const located = await readContext({ requestHandle: input.requestHandle }, options);
    if (located.kind !== 'found' || located.context.ownerId !== input.ownerId) {
      return located.kind === 'unavailable' ? { kind: 'unavailable' } : { kind: 'conflict' };
    }
    return setMute({
      ownerId: input.ownerId,
      requester: located.context.requester,
      kind: located.context.detail.kind,
      targetFingerprint: located.context.targetFingerprint,
      action: input.action,
      expectedRevision: input.expectedRevision,
      operationId: input.operationId,
    }, options);
  }

  async function claim<K extends 'access' | 'create'>(kind: K, input: FulfillmentClaimInput, options?: CallOptions): Promise<ClaimResult<K>> {
    let artifacts;
    try {
      artifacts = policy.derive(derivation(input.binding));
    } catch {
      return { kind: 'unavailable' };
    }
    const result = await mutate<ClaimResult<K>>(`claim-${kind}`, input.operationId, (aggregate, now) => {
      const row = aggregate.requests[artifacts.operationKey];
      if (!row || row.bindingDigest !== artifacts.bindingDigest || row.detail.kind !== kind) {
        return unchanged({ kind: 'unavailable' as const });
      }
      if (row.claim?.operationId === input.operationId) {
        return unchanged(row.claim.consumerId === input.consumerId
          ? { kind: 'claimed' as const, authorization: authorization(row) as Extract<ChannelAccessAuthorization, { kind: K }>, revision: row.claim.revision }
          : { kind: 'conflict' as const });
      }
      if (row.outcome === 'expired') return unchanged({ kind: 'expired' as const });
      if (row.revision !== input.expectedRevision) return unchanged({ kind: 'stale' as const });
      if (row.outcome !== 'approved') return unchanged({ kind: 'conflict' as const });
      const value = cloneAggregate(aggregate);
      const next: StoredRequest = {
        ...row,
        outcome: 'connecting',
        revision: row.revision + 1,
        claim: { operationId: input.operationId, consumerId: input.consumerId, claimedAt: iso(now), revision: row.revision + 1 },
      };
      value.requests[row.operationKey] = next;
      return changed(value, {
        kind: 'claimed' as const,
        authorization: authorization(next) as Extract<ChannelAccessAuthorization, { kind: K }>,
        revision: next.revision,
      });
    }, options);
    return result === STORE_UNAVAILABLE ? { kind: 'unavailable' } : result;
  }

  async function updateLifecycle(input: Parameters<ChannelAccessStore['updateLifecycle']>[0], options?: CallOptions): ReturnType<ChannelAccessStore['updateLifecycle']> {
    const result = await mutate<Awaited<ReturnType<ChannelAccessStore['updateLifecycle']>>>('lifecycle', input.operationId, (aggregate, now) => {
      const row = findHandle(aggregate, input.requestHandle);
      if (!row) return unchanged({ kind: 'not_found' as const });
      if (!row.claim || row.claim.consumerId !== input.consumerId) return unchanged({ kind: 'conflict' as const });
      if (row.lifecycle?.operationId === input.operationId) {
        return unchanged(row.lifecycle.outcome === input.outcome
          ? { kind: 'updated' as const, outcome: input.outcome, revision: row.revision }
          : { kind: 'conflict' as const });
      }
      if (row.revision !== input.expectedRevision) return unchanged({ kind: 'stale' as const });
      if (row.outcome !== 'connecting') return unchanged({ kind: 'conflict' as const });
      const value = cloneAggregate(aggregate);
      const next: StoredRequest = {
        ...row,
        outcome: input.outcome,
        revision: row.revision + 1,
        terminalAt: iso(now),
        lifecycle: { operationId: input.operationId, outcome: input.outcome },
      };
      value.requests[row.operationKey] = next;
      suppressNotification(value, row.operationKey);
      return changed(value, { kind: 'updated' as const, outcome: input.outcome, revision: next.revision });
    }, options);
    return result === STORE_UNAVAILABLE ? { kind: 'unavailable' } : result;
  }

  async function revoke(input: Parameters<ChannelAccessStore['revoke']>[0], options?: CallOptions): ReturnType<ChannelAccessStore['revoke']> {
    let artifacts;
    try {
      artifacts = policy.derive(derivation(input.binding));
    } catch {
      return { kind: 'unavailable' };
    }
    const result = await mutate<Awaited<ReturnType<ChannelAccessStore['revoke']>>>('revoke', input.operationId, (aggregate, now) => {
      const row = aggregate.requests[artifacts.operationKey];
      if (!row || row.bindingDigest !== artifacts.bindingDigest) return unchanged({ kind: 'not_found' as const });
      if (row.lifecycle?.operationId === input.operationId && row.outcome === 'revoked') {
        return unchanged({ kind: 'updated' as const, outcome: 'revoked' as const, revision: row.revision });
      }
      if (row.revision !== input.expectedRevision) return unchanged({ kind: 'stale' as const });
      if (terminal(row.outcome)) return unchanged({ kind: 'stale' as const });
      const value = cloneAggregate(aggregate);
      const next: StoredRequest = {
        ...row,
        outcome: 'revoked',
        revision: row.revision + 1,
        terminalAt: iso(now),
        lifecycle: { operationId: input.operationId, outcome: 'revoked' },
      };
      value.requests[row.operationKey] = next;
      suppressNotification(value, row.operationKey);
      return changed(value, { kind: 'updated' as const, outcome: 'revoked' as const, revision: next.revision });
    }, options);
    return result === STORE_UNAVAILABLE ? { kind: 'unavailable' } : result;
  }

  async function listNotifications(input: Parameters<ChannelAccessStore['listNotifications']>[0], options?: CallOptions): ReturnType<ChannelAccessStore['listNotifications']> {
    const limit = Number.isSafeInteger(input.limit) && input.limit! > 0 ? input.limit! : 10;
    const result = await mutate('notification-list', input.ownerId, aggregate => unchanged({
      kind: 'found' as const,
      notifications: Object.values(aggregate.notifications)
        .filter(item => item.ownerId === input.ownerId && item.revision > item.deliveredRevision)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, limit)
        .map(notificationProjection),
    }), options);
    return result === STORE_UNAVAILABLE ? { kind: 'unavailable' } : result;
  }

  async function ackNotification(input: Parameters<ChannelAccessStore['ackNotification']>[0], options?: CallOptions): ReturnType<ChannelAccessStore['ackNotification']> {
    const result = await mutate<Awaited<ReturnType<ChannelAccessStore['ackNotification']>>>('notification-ack', input.operationId, aggregate => {
      const item = aggregate.notifications[input.notificationId];
      if (!item || item.ownerId !== input.ownerId) return unchanged({ kind: 'not_found' as const });
      if (item.ackOperationId === input.operationId && item.deliveredRevision === input.revision) {
        return unchanged({ kind: 'acknowledged' as const });
      }
      if (item.revision !== input.revision) return unchanged({ kind: 'stale' as const });
      const value = cloneAggregate(aggregate);
      value.notifications[item.id] = { ...item, deliveredRevision: input.revision, ackOperationId: input.operationId };
      return changed(value, { kind: 'acknowledged' as const });
    }, options);
    return result === STORE_UNAVAILABLE ? { kind: 'unavailable' } : result;
  }

  return {
    create,
    inspect,
    inspectRequester,
    listOwner,
    readOwner,
    readContext,
    decide,
    setMute,
    setMuteForRequest,
    claimAccess: (input, options) => claim('access', input, options),
    claimCreate: (input, options) => claim('create', input, options),
    updateLifecycle,
    revoke,
    listNotifications,
    ackNotification,
  };
}

function derivation(input: ChannelAccessBindingInput | ChannelAccessCreateInput): ChannelAccessDerivationInput {
  return {
    requester: input.requester,
    sessionFingerprint: input.sessionFingerprint,
    sessionGeneration: input.sessionGeneration,
    origin: input.origin,
    kind: 'detail' in input ? input.detail.kind : input.kind,
    operationId: input.operationId,
    ownerId: input.ownerId,
    targetFingerprint: input.targetFingerprint,
  };
}

function scopeKey(
  policy: ChannelAccessPolicy,
  purpose: 'cooldown' | 'mute',
  input: Readonly<{ requester: string; ownerId: string; kind: 'access' | 'create'; targetFingerprint: string }>
    | ChannelAccessCreateInput,
): string {
  const kind = 'detail' in input ? input.detail.kind : input.kind;
  const fields: [string, string][] = [['requester', input.requester], ['kind', kind]];
  if (purpose === 'mute' || kind === 'create') fields.push(['ownerId', input.ownerId]);
  if (kind === 'access') fields.push(['targetFingerprint', input.targetFingerprint]);
  return policy.digest(purpose, fields);
}

function emptyAggregate(): JournalAggregate {
  return {
    v: 1,
    recordType: 'channel_access_journal',
    requests: {},
    mutes: {},
    notifications: {},
    tombstones: {},
  };
}

function cloneAggregate(value: JournalAggregate): {
  v: 1;
  recordType: 'channel_access_journal';
  requests: Record<string, StoredRequest>;
  mutes: Record<string, StoredMute>;
  notifications: Record<string, StoredNotification>;
  tombstones: Record<string, StoredTombstone>;
} {
  return structuredClone(value);
}

function maintain(aggregate: JournalAggregate, now: number): Readonly<{ value: JournalAggregate; changed: boolean }> {
  let value: ReturnType<typeof cloneAggregate> | null = null;
  const mutable = () => (value ??= cloneAggregate(aggregate));
  for (const row of Object.values(aggregate.requests)) {
    let current = row;
    if (now >= Date.parse(row.deadline)) {
      if (row.outcome === 'pending_owner' || row.outcome === 'approved') {
        current = { ...row, outcome: 'expired', revision: row.revision + 1, terminalAt: row.deadline };
        mutable().requests[row.operationKey] = current;
        suppressNotification(mutable(), row.operationKey);
      } else if (row.outcome === 'connecting') {
        current = { ...row, outcome: 'repair_required', revision: row.revision + 1, terminalAt: row.deadline };
        mutable().requests[row.operationKey] = current;
        suppressNotification(mutable(), row.operationKey);
      }
    }
    if (current.terminalAt !== null && now >= Date.parse(current.terminalAt) + CHANNEL_ACCESS_PURGE_MS) {
      const outcome = tombstoneOutcome(current.outcome);
      if (outcome) {
        delete mutable().requests[row.operationKey];
        mutable().tombstones[row.operationKey] = { outcome };
        suppressNotification(mutable(), row.operationKey, true);
      }
    }
  }
  for (const notification of Object.values(aggregate.notifications)) {
    if (now >= Date.parse(notification.createdAt) + CHANNEL_ACCESS_PURGE_MS) {
      delete mutable().notifications[notification.id];
    }
  }
  return { value: value ?? aggregate, changed: value !== null };
}

function reserveNotification(
  aggregate: ReturnType<typeof cloneAggregate>,
  row: StoredRequest,
  policy: ChannelAccessPolicy,
  now: number,
): void {
  const window = Math.floor(now / NOTIFICATION_WINDOW_MS);
  const inWindow = Object.values(aggregate.notifications)
    .filter(item => item.ownerId === row.ownerId && item.window === window);
  const individuals = inWindow.filter(item => item.kind === 'request');
  if (individuals.length < INDIVIDUAL_NOTIFICATION_LIMIT) {
    aggregate.notifications[row.notificationId] = {
      id: row.notificationId,
      ownerId: row.ownerId,
      operationKeys: [row.operationKey],
      requestHandle: row.requestHandle,
      kind: 'request',
      window,
      revision: 1,
      count: 1,
      deliveredRevision: 0,
      ackOperationId: null,
      createdAt: iso(now),
    };
    return;
  }
  const id = policy.digest('notification', [['ownerId', row.ownerId], ['window', window]]);
  const existing = aggregate.notifications[id];
  aggregate.notifications[id] = existing
    ? {
      ...existing,
      operationKeys: [...existing.operationKeys, row.operationKey],
      revision: existing.revision + 1,
      count: existing.count + 1,
      ackOperationId: null,
    }
    : {
      id,
      ownerId: row.ownerId,
      operationKeys: [row.operationKey],
      requestHandle: null,
      kind: 'batch',
      window,
      revision: 1,
      count: 1,
      deliveredRevision: 0,
      ackOperationId: null,
      createdAt: iso(now),
    };
}

function suppressNotification(
  aggregate: ReturnType<typeof cloneAggregate>,
  operationKey: string,
  forgetDelivered = false,
): void {
  for (const notification of Object.values(aggregate.notifications)) {
    if ((!forgetDelivered && notification.revision <= notification.deliveredRevision)
      || !notification.operationKeys.includes(operationKey)) continue;
    const operationKeys = notification.operationKeys.filter(key => key !== operationKey);
    if (operationKeys.length === 0) {
      delete aggregate.notifications[notification.id];
      continue;
    }
    const revision = forgetDelivered && notification.revision <= notification.deliveredRevision
      ? notification.revision
      : notification.revision + 1;
    aggregate.notifications[notification.id] = {
      ...notification,
      operationKeys,
      count: operationKeys.length,
      revision,
      deliveredRevision: forgetDelivered && notification.revision <= notification.deliveredRevision
        ? revision
        : notification.deliveredRevision,
      ackOperationId: forgetDelivered && notification.revision <= notification.deliveredRevision
        ? notification.ackOperationId
        : null,
    };
  }
}

function acceptedResponse(row: StoredRequest) {
  return {
    kind: 'accepted' as const,
    requestHandle: row.requestHandle,
    revision: row.revision,
    deadline: row.deadline,
    outcome: row.outcome,
  };
}

function status(row: StoredRequest): ChannelAccessStatus {
  return { outcome: row.outcome, revision: row.revision, deadline: row.deadline };
}

function ownerProjection(row: StoredRequest, mute?: StoredMute): ChannelAccessOwnerProjection {
  return {
    requestHandle: row.requestHandle,
    kind: row.detail.kind,
    outcome: row.outcome,
    revision: row.revision,
    createdAt: row.createdAt,
    deadline: row.deadline,
    sessionFingerprint: row.sessionFingerprint,
    harness: row.harness,
    requesterLabel: row.requesterLabel,
    workspaceLabel: row.workspaceLabel,
    title: row.detail.kind === 'access' ? row.detail.title : null,
    proposedTitle: row.detail.kind === 'create' ? row.detail.proposedTitle : null,
    ownerDecision: row.decision?.decision === 'approve'
      ? 'approved'
      : row.decision?.decision === 'deny' ? 'denied' : 'pending',
    decidedAt: row.decision?.decidedAt ?? null,
    muted: mute?.enabled ?? false,
    muteRevision: mute?.revision ?? null,
  };
}

function storedContext(row: StoredRequest): ChannelAccessStoredContext {
  return {
    requestHandle: row.requestHandle,
    operationId: row.operationId,
    ownerId: row.ownerId,
    revision: row.revision,
    requester: row.requester,
    sessionFingerprint: row.sessionFingerprint,
    sessionGeneration: row.sessionGeneration,
    origin: row.origin,
    harness: row.harness,
    requesterLabel: row.requesterLabel,
    workspaceLabel: row.workspaceLabel,
    targetFingerprint: row.targetFingerprint,
    deadline: row.deadline,
    outcome: row.outcome,
    detail: row.detail,
  };
}

function authorization(row: StoredRequest): ChannelAccessAuthorization {
  const common = {
    v: 1 as const,
    requestHandle: row.requestHandle,
    ownerId: row.ownerId,
    requester: row.requester,
    sessionFingerprint: row.sessionFingerprint,
    sessionGeneration: row.sessionGeneration,
    origin: row.origin,
    operationId: row.operationId,
    approvedAt: row.approvedAt ?? row.createdAt,
    deadline: row.deadline,
  };
  return row.detail.kind === 'access'
    ? { ...common, kind: 'access', authorizedChannelRef: row.detail.authorizedChannelRef }
    : {
      ...common,
      kind: 'create',
      proposalDigest: row.detail.proposalDigest,
      proposedTitle: row.detail.proposedTitle,
    };
}

function notificationProjection(item: StoredNotification): ChannelAccessNotification {
  return {
    id: item.id,
    kind: item.kind,
    requestHandle: item.requestHandle,
    revision: item.revision,
    count: item.count,
    createdAt: item.createdAt,
  };
}

function findHandle(aggregate: JournalAggregate, handle: string): StoredRequest | undefined {
  return Object.values(aggregate.requests).find(request => request.requestHandle === handle);
}

function activeForCapacity(outcome: ChannelAccessOutcome): boolean {
  return outcome === 'pending_owner' || outcome === 'approved';
}

function terminal(outcome: ChannelAccessOutcome): boolean {
  return outcome === 'connected' || outcome === 'repair_required' || outcome === 'denied'
    || outcome === 'expired' || outcome === 'revoked';
}

function tombstoneOutcome(outcome: ChannelAccessOutcome): StoredTombstone['outcome'] | null {
  return terminal(outcome) ? outcome as StoredTombstone['outcome'] : null;
}

function decodeAggregate(value: JsonValue): JournalAggregate | null {
  if (!object(value) || value.v !== 1 || value.recordType !== 'channel_access_journal'
    || !object(value.requests) || !object(value.mutes) || !object(value.notifications) || !object(value.tombstones)) {
    return null;
  }
  if (!exactKeys(value, ['v', 'recordType', 'requests', 'mutes', 'notifications', 'tombstones'])) return null;
  if (!Object.entries(value.requests).every(([key, row]) => validRequest(key, row))) return null;
  if (!Object.entries(value.mutes).every(([key, mute]) => nonempty(key) && validMute(mute))) return null;
  if (!Object.entries(value.notifications).every(([key, item]) => nonempty(key) && validNotification(item))) return null;
  if (!Object.entries(value.tombstones).every(([key, tombstone]) => nonempty(key) && validTombstone(tombstone))) return null;
  return value as JournalAggregate;
}

function validRequest(key: string, value: JsonValue): boolean {
  if (!nonempty(key) || !object(value) || !exactKeys(value, [
    'operationKey', 'bindingDigest', 'requestHandle', 'requesterKey', 'operationId', 'requester', 'sessionFingerprint',
    'sessionGeneration', 'origin', 'ownerId', 'targetFingerprint', 'cooldownKey', 'muteKey', 'notificationId',
    'detail', 'harness', 'requesterLabel', 'workspaceLabel', 'createdAt', 'deadline', 'outcome', 'revision',
    'approvedAt', 'terminalAt', 'decision', 'claim', 'lifecycle',
  ])) return false;
  if (value.operationKey !== key || !strings(value, [
    'bindingDigest', 'requestHandle', 'requesterKey', 'operationId', 'requester', 'sessionFingerprint', 'origin',
    'ownerId', 'targetFingerprint', 'cooldownKey', 'muteKey', 'notificationId', 'harness', 'createdAt', 'deadline',
  ])) return false;
  if (!Number.isSafeInteger(value.sessionGeneration) || (value.sessionGeneration as number) < 0
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1) return false;
  if (!nullableString(value.requesterLabel) || !nullableString(value.workspaceLabel)
    || !nullableString(value.approvedAt) || !nullableString(value.terminalAt)) return false;
  if (!isOutcome(value.outcome) || !validDetail(value.detail)
    || !validDecision(value.decision) || !validClaim(value.claim) || !validLifecycle(value.lifecycle)) return false;
  return validTimestamp(value.createdAt) && validTimestamp(value.deadline)
    && (value.approvedAt === null || validTimestamp(value.approvedAt))
    && (value.terminalAt === null || validTimestamp(value.terminalAt));
}

function validDetail(value: JsonValue | undefined): boolean {
  if (!object(value)) return false;
  if (value.kind === 'access') {
    return exactKeys(value, ['kind', 'authorizedChannelRef', 'targetRevision', 'title'])
      && strings(value, ['authorizedChannelRef', 'targetRevision', 'title']);
  }
  return value.kind === 'create'
    && exactKeys(value, ['kind', 'proposalDigest', 'proposedTitle', 'ownerRevision'])
    && strings(value, ['proposalDigest', 'proposedTitle', 'ownerRevision']);
}

function validDecision(value: JsonValue | undefined): boolean {
  return value === null || (object(value)
    && exactKeys(value, ['operationId', 'decision', 'decidedAt'])
    && nonempty(value.operationId)
    && (value.decision === 'approve' || value.decision === 'deny')
    && validTimestamp(value.decidedAt));
}

function validClaim(value: JsonValue | undefined): boolean {
  return value === null || (object(value)
    && exactKeys(value, ['operationId', 'consumerId', 'claimedAt', 'revision'])
    && strings(value, ['operationId', 'consumerId'])
    && Number.isSafeInteger(value.revision) && (value.revision as number) >= 1
    && validTimestamp(value.claimedAt));
}

function validLifecycle(value: JsonValue | undefined): boolean {
  return value === null || (object(value)
    && exactKeys(value, ['operationId', 'outcome'])
    && nonempty(value.operationId)
    && (value.outcome === 'connected' || value.outcome === 'repair_required' || value.outcome === 'revoked'));
}

function validMute(value: JsonValue): boolean {
  return object(value)
    && exactKeys(value, ['ownerId', 'kind', 'targetFingerprint', 'enabled', 'revision', 'operationId', 'updatedAt'])
    && strings(value, ['ownerId', 'operationId'])
    && (value.kind === 'access' || value.kind === 'create')
    && nullableString(value.targetFingerprint)
    && typeof value.enabled === 'boolean'
    && Number.isSafeInteger(value.revision) && (value.revision as number) >= 1
    && validTimestamp(value.updatedAt);
}

function validNotification(value: JsonValue): boolean {
  if (!object(value) || !exactKeys(value, [
    'id', 'ownerId', 'operationKeys', 'requestHandle', 'kind', 'window', 'revision', 'count', 'deliveredRevision',
    'ackOperationId', 'createdAt',
  ])) return false;
  return strings(value, ['id', 'ownerId'])
    && Array.isArray(value.operationKeys) && value.operationKeys.length === value.count
    && value.operationKeys.every(nonempty) && new Set(value.operationKeys).size === value.operationKeys.length
    && nullableString(value.requestHandle)
    && (value.kind === 'request' || value.kind === 'batch')
    && Number.isSafeInteger(value.window)
    && Number.isSafeInteger(value.revision) && (value.revision as number) >= 1
    && Number.isSafeInteger(value.count) && (value.count as number) >= 1
    && Number.isSafeInteger(value.deliveredRevision) && (value.deliveredRevision as number) >= 0
    && nullableString(value.ackOperationId)
    && validTimestamp(value.createdAt);
}

function validTombstone(value: JsonValue): boolean {
  return object(value) && exactKeys(value, ['outcome'])
    && (value.outcome === 'connected' || value.outcome === 'repair_required' || value.outcome === 'denied'
      || value.outcome === 'expired' || value.outcome === 'revoked');
}

function exactKeys(value: { readonly [key: string]: JsonValue }, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function strings(value: { readonly [key: string]: JsonValue }, keys: readonly string[]): boolean {
  return keys.every(key => nonempty(value[key]));
}

function nullableString(value: JsonValue | undefined): boolean {
  return value === null || nonempty(value);
}

function nonempty(value: JsonValue | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validTimestamp(value: JsonValue | undefined): value is string {
  return nonempty(value) && Number.isFinite(Date.parse(value));
}

function isOutcome(value: JsonValue | undefined): value is ChannelAccessOutcome {
  return value === 'pending_owner' || value === 'approved' || value === 'connecting' || value === 'connected'
    || value === 'repair_required' || value === 'denied' || value === 'expired' || value === 'revoked';
}

function object(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function iso(value: number): string {
  return new Date(value).toISOString();
}
