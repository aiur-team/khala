// Single-message sends. A client transaction freezes its bytes on first use, so a
// failed or unknown send is retried with the same transaction and content.

import {
  type CallOptions, type MessageContent, type OperationResult, type RoomId, type RoomRejection, type SendState,
  ok, outcomeUnknown, rejected, unavailable,
} from '@khala/contracts/messaging/index';
import { type RoomContext, authorOf, deviceGate, digestContent, isIdentifier, isRefusal, membershipGate, safeEffect, sameAuthor } from './context';
import { type SendItem, type SendRecord, journalKey } from './journal';

export type SendInput = Readonly<{ roomId: RoomId; clientTxnId: string; content: MessageContent }>;

export function toSendState(item: SendItem): SendState {
  return { clientTxnId: item.clientTxnId, state: item.state, eventRef: item.eventRef };
}

/**
 * Sends one frozen item under its original transaction ID and reports the new
 * item state. `rejection` is set only when the transport refused the event.
 */
export async function transmit(
  ctx: RoomContext, roomId: RoomId, item: SendItem, options: CallOptions | undefined,
): Promise<Readonly<{ item: SendItem; rejection: RoomRejection | null }>> {
  ctx.echo(roomId, { ...item, state: 'pending', eventRef: null });
  const result = await safeEffect(() => ctx.substrate.sendEvent({ roomId, clientTxnId: item.clientTxnId, content: item.content }, options));
  let next: SendItem;
  let rejection: RoomRejection | null = null;
  switch (result.kind) {
    case 'done':
      next = {
        ...item,
        state: 'accepted',
        eventRef: {
          v: 1, roomId, eventId: result.value.eventId, authorParticipantId: ctx.actor.participantId,
          authorDeviceId: result.value.authorDeviceId, contentDigest: item.contentDigest,
        },
      };
      break;
    case 'rejected':
      rejection = result.code;
      next = { ...item, state: 'failed', eventRef: null };
      break;
    case 'unavailable':
      next = { ...item, state: 'failed', eventRef: null };
      break;
    case 'unknown':
      next = { ...item, state: 'outcome_unknown', eventRef: null };
      break;
  }
  ctx.echo(roomId, next);
  return { item: next, rejection };
}

export async function send(ctx: RoomContext, input: SendInput, options?: CallOptions): Promise<OperationResult<SendState, RoomRejection>> {
  if (!isIdentifier(input.clientTxnId) || !isIdentifier(input.roomId)) return rejected('invalid_request');
  const content = await digestContent(ctx, input.content);
  if (isRefusal(content)) return content;
  const gate = deviceGate(ctx, options);
  if (isRefusal(gate)) return gate;

  const key = journalKey.send(input.clientTxnId);
  const intent: SendRecord = {
    type: 'send',
    roomId: input.roomId,
    author: authorOf(ctx, gate.deviceId),
    item: { clientTxnId: input.clientTxnId, content: content.content, contentDigest: content.digest, state: 'pending', eventRef: null },
  };
  const claim = await ctx.journal.claim(key, intent);
  if (claim.kind === 'unavailable') return unavailable();
  let record = intent;
  if (claim.kind === 'exists') {
    const found = claim.value;
    if (found.type !== 'send' || found.roomId !== input.roomId || found.item.contentDigest !== content.digest
      || found.author.participantId !== intent.author.participantId || found.author.ownerId !== intent.author.ownerId) {
      return rejected('operation_mismatch');
    }
    if (found.item.state === 'accepted') return ok(toSendState(found.item));
    // The transport deduplicates per device; another device would send a second copy.
    if (!sameAuthor(found.author, intent.author)) return rejected('forbidden');
    record = found;
  }

  const room = await membershipGate(ctx, input.roomId, options);
  if (isRefusal(room)) return room;
  const sent = await transmit(ctx, input.roomId, record.item, options);
  await ctx.journal.put(key, { ...record, item: sent.item });
  if (sent.rejection) return rejected(sent.rejection);
  switch (sent.item.state) {
    case 'accepted':
      return ok(toSendState(sent.item));
    case 'outcome_unknown':
      return outcomeUnknown(input.clientTxnId);
    default:
      return unavailable();
  }
}
