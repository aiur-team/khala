// Channel creation with a recoverable operation identity. Intent is journaled before
// the SDK call; a lost response is reconciled by operation ID, never by creating
// another channel. A lease keeps concurrent callers (another click, another tab) from
// reconciling or creating while an attempt is still outstanding.

import {
  type CallOptions, type OperationResult, type ChannelRejection, type ChannelSummary,
  ok, outcomeUnknown, rejected, unavailable,
} from '@khala/contracts/messaging/index';
import { decodeWith, displayText, nullable } from '@khala/contracts/messaging/decode';
import { type ChannelContext, deviceGate, isIdentifier, isRefusal, safeEffect } from './context';
import { type CreateRecord, journalKey } from './journal';

export type CreateInput = Readonly<{ operationId: string; title: string | null }>;

/** How long an outstanding create excludes other callers; past it, the attempt is presumed lost. */
export const CREATE_LEASE_MS = 120_000;

type CreateResult = OperationResult<ChannelSummary, ChannelRejection>;

export async function createChannel(ctx: ChannelContext, input: CreateInput, options?: CallOptions): Promise<CreateResult> {
  // A delegated agent may post intros but gains no channel-creation authority here.
  if (ctx.actor.kind !== 'human' || ctx.actor.ownerId !== ctx.principal.ownerId) return rejected('forbidden');
  if (!isIdentifier(input.operationId)) return rejected('invalid_request');
  const title = decodeWith(() => nullable(input.title, value => displayText(value, 'title', ctx.limits.maxRoomTitleBytes)));
  if (!title.ok) return rejected(title.error.code === 'too_long' ? 'too_large' : 'invalid_request');
  const base = { type: 'create', ownerId: ctx.principal.ownerId, title: title.value === '' ? null : title.value } as const;
  const attempt = (): CreateRecord => ({ ...base, state: 'attempting', leaseUntilMs: ctx.clock() + CREATE_LEASE_MS, room: null });

  const gate = deviceGate(ctx, options);
  if (isRefusal(gate)) return gate;
  const key = journalKey.create(input.operationId);
  const claim = await ctx.journal.claim(key, attempt());
  if (claim.kind === 'unavailable') return unavailable();
  let revision = claim.revision;
  if (claim.kind === 'exists') {
    const found = claim.value;
    if (found.type !== 'create' || found.ownerId !== base.ownerId || found.title !== base.title) return rejected('operation_mismatch');
    if (found.state === 'created' && found.room) return ok(found.room);
    // Another caller's attempt is still outstanding; its result will resolve this operation.
    if (found.state === 'attempting' && found.leaseUntilMs !== null && ctx.clock() < found.leaseUntilMs) return outcomeUnknown(input.operationId);
    if (found.state !== 'not_applied') {
      const resolved = await reconcile(ctx, input.operationId, found, claim.revision, options);
      if (resolved !== 'absent') return resolved;
    }
    // Taking the lease is a compare-and-set, so two retries can never both create.
    const taken = await ctx.journal.replace(key, claim.revision, attempt());
    if (taken.kind === 'unavailable') return unavailable();
    if (taken.kind === 'conflict') return outcomeUnknown(input.operationId);
    revision = taken.revision;
  }

  const result = await safeEffect(() => ctx.substrate.createRoom({ operationId: input.operationId, title: base.title }, options));
  // A lost final write leaves the lease to expire, after which a retry reconciles.
  switch (result.kind) {
    case 'done':
      await ctx.journal.replace(key, revision, { ...base, state: 'created', leaseUntilMs: null, room: result.value });
      return ok(result.value);
    case 'rejected':
    case 'unavailable':
      await ctx.journal.replace(key, revision, { ...base, state: 'not_applied', leaseUntilMs: null, room: null });
      return result.kind === 'rejected' ? rejected(result.code) : unavailable();
    case 'unknown':
      await ctx.journal.replace(key, revision, { ...base, state: 'unknown', leaseUntilMs: null, room: null });
      return outcomeUnknown(input.operationId);
  }
}

/** @deprecated Use `createChannel`. Kept through the first tagged release containing #163. */
export const createRoom = createChannel;

/** Resolves an earlier attempt whose outcome was lost. `absent` means it provably created nothing. */
async function reconcile(
  ctx: ChannelContext, operationId: string, found: CreateRecord, revision: string, options: CallOptions | undefined,
): Promise<CreateResult | 'absent'> {
  let lookup;
  try {
    lookup = await ctx.substrate.findCreatedRoom({ operationId }, options);
  } catch {
    return outcomeUnknown(operationId);
  }
  switch (lookup.kind) {
    case 'found':
      await ctx.journal.replace(journalKey.create(operationId), revision, { ...found, state: 'created', leaseUntilMs: null, room: lookup.room });
      return ok(lookup.room);
    case 'absent':
      return 'absent';
    case 'unknown':
    case 'unavailable':
      return outcomeUnknown(operationId);
  }
}
