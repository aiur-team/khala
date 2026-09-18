// Room creation with a recoverable operation identity. Intent is journaled before
// the SDK call; a lost response is reconciled by operation ID, never by creating
// another room.

import {
  type CallOptions, type OperationResult, type RoomRejection, type RoomSummary,
  ok, outcomeUnknown, rejected, unavailable,
} from '@khala/contracts/messaging/index';
import { decodeWith, displayText, nullable } from '@khala/contracts/messaging/decode';
import { type RoomContext, deviceGate, isIdentifier, isRefusal, safeEffect } from './context';
import { type CreateRecord, journalKey } from './journal';

export type CreateInput = Readonly<{ operationId: string; title: string | null }>;

export async function createRoom(ctx: RoomContext, input: CreateInput, options?: CallOptions): Promise<OperationResult<RoomSummary, RoomRejection>> {
  // A delegated agent may post intros but gains no room-creation authority here.
  if (ctx.actor.kind !== 'human' || ctx.actor.ownerId !== ctx.principal.ownerId) return rejected('forbidden');
  if (!isIdentifier(input.operationId)) return rejected('invalid_request');
  const title = decodeWith(() => nullable(input.title, value => displayText(value, 'title', ctx.limits.maxRoomTitleBytes)));
  if (!title.ok) return rejected(title.error.code === 'too_long' ? 'too_large' : 'invalid_request');
  const intent: CreateRecord = {
    type: 'create', ownerId: ctx.principal.ownerId, title: title.value === '' ? null : title.value, state: 'in_flight', room: null,
  };

  const gate = deviceGate(ctx, options);
  if (isRefusal(gate)) return gate;
  const key = journalKey.create(input.operationId);
  const claim = await ctx.journal.claim(key, intent);
  if (claim.kind === 'unavailable') return unavailable();
  if (claim.kind === 'exists') {
    const found = claim.value;
    if (found.type !== 'create' || found.ownerId !== intent.ownerId || found.title !== intent.title) return rejected('operation_mismatch');
    if (found.state === 'created' && found.room) return ok(found.room);
    if (found.state === 'in_flight') {
      const resolved = await reconcile(ctx, input.operationId, intent, options);
      if (resolved !== 'absent') return resolved;
    }
    if ((await ctx.journal.put(key, intent)).kind === 'unavailable') return unavailable();
  }

  const result = await safeEffect(() => ctx.substrate.createRoom({ operationId: input.operationId, title: intent.title }, options));
  switch (result.kind) {
    case 'done':
      // The room exists whether or not this write lands; a later retry reconciles it.
      await ctx.journal.put(key, { ...intent, state: 'created', room: result.value });
      return ok(result.value);
    case 'rejected':
    case 'unavailable':
      await ctx.journal.put(key, { ...intent, state: 'not_applied' });
      return result.kind === 'rejected' ? rejected(result.code) : unavailable();
    case 'unknown':
      return outcomeUnknown(input.operationId);
  }
}

/** Resolves an earlier attempt whose outcome was lost. `absent` means it provably created nothing. */
async function reconcile(
  ctx: RoomContext, operationId: string, intent: CreateRecord, options: CallOptions | undefined,
): Promise<OperationResult<RoomSummary, RoomRejection> | 'absent'> {
  let lookup;
  try {
    lookup = await ctx.substrate.findCreatedRoom({ operationId }, options);
  } catch {
    return outcomeUnknown(operationId);
  }
  switch (lookup.kind) {
    case 'found':
      await ctx.journal.put(journalKey.create(operationId), { ...intent, state: 'created', room: lookup.room });
      return ok(lookup.room);
    case 'absent':
      return 'absent';
    case 'unknown':
    case 'unavailable':
      return outcomeUnknown(operationId);
  }
}
