// Intro batches: an ordered, immutable selection of messages with per-item
// acceptance. There is no multi-event transaction, so a retry sends only the
// unresolved items, in order, under their original transaction IDs and bytes.

import {
  type CallOptions, type IntroBatch, type OperationResult, type RoomRejection, type SendState,
  ok, rejected, unavailable,
} from '@khala/contracts/messaging/index';
import { type RoomContext, authorOf, deviceGate, digestContent, isIdentifier, isRefusal, membershipGate, sameAuthor } from './context';
import { type IntroRecord, type SendItem, journalKey } from './journal';
import { toSendState, transmit } from './send';

type IntroResult = OperationResult<readonly SendState[], RoomRejection>;

export async function prepareIntro(ctx: RoomContext, input: IntroBatch, options?: CallOptions): Promise<IntroResult> {
  if (!isIdentifier(input.batchId) || !isIdentifier(input.roomId) || !Array.isArray(input.messages) || input.messages.length === 0) {
    return rejected('invalid_request');
  }
  const items: SendItem[] = [];
  for (const message of input.messages) {
    const content = await digestContent(ctx, message);
    if (isRefusal(content)) return content;
    items.push({ clientTxnId: ctx.newId(), content: content.content, contentDigest: content.digest, state: 'pending', eventRef: null });
  }
  const gate = deviceGate(ctx, options);
  if (isRefusal(gate)) return gate;
  // Transport dedupe would collapse two items that share a transaction ID.
  if (new Set(items.map(item => item.clientTxnId)).size !== items.length || !items.every(item => isIdentifier(item.clientTxnId))) {
    return unavailable();
  }

  const intent: IntroRecord = { type: 'intro', roomId: input.roomId, author: authorOf(ctx, gate.deviceId), items };
  const claim = await ctx.journal.claim(journalKey.intro(input.batchId), intent);
  if (claim.kind === 'unavailable') return unavailable();
  if (claim.kind === 'claimed') return run(ctx, input.batchId, intent, claim.revision, options);
  // Preparing the same batch again is a resume only when the selection is identical;
  // a changed, reordered or extended selection is another batch.
  const found = claim.value;
  if (found.type !== 'intro' || found.roomId !== intent.roomId || found.items.length !== items.length
    || found.items.some((item, index) => item.contentDigest !== items[index]?.contentDigest)) {
    return rejected('operation_mismatch');
  }
  return resumeRecord(ctx, input.batchId, found, claim.revision, options);
}

export async function resumeIntro(ctx: RoomContext, batchId: string, options?: CallOptions): Promise<IntroResult> {
  if (!isIdentifier(batchId)) return rejected('invalid_request');
  const read = await ctx.journal.read(journalKey.intro(batchId));
  if (read.kind === 'unavailable') return unavailable();
  if (read.kind === 'absent' || read.value.type !== 'intro') return rejected('not_found');
  return resumeRecord(ctx, batchId, read.value, read.revision, options);
}

async function resumeRecord(
  ctx: RoomContext, batchId: string, record: IntroRecord, revision: string, options: CallOptions | undefined,
): Promise<IntroResult> {
  if (record.items.every(item => item.state === 'accepted')) return ok(record.items.map(toSendState));
  const gate = deviceGate(ctx, options);
  if (isRefusal(gate)) return gate;
  // The batch stays bound to the author and device that prepared it; a changed
  // account or device must not retarget it or resend outside transport dedupe.
  if (!sameAuthor(record.author, authorOf(ctx, gate.deviceId))) return rejected('forbidden');
  return run(ctx, batchId, record, revision, options);
}

async function run(
  ctx: RoomContext, batchId: string, record: IntroRecord, revision: string, options: CallOptions | undefined,
): Promise<IntroResult> {
  const room = await membershipGate(ctx, record.roomId, options);
  if (isRefusal(room)) return room;
  const items = [...record.items];
  let current = revision;
  for (const [index, item] of items.entries()) {
    if (item.state === 'accepted') continue;
    const sent = await transmit(ctx, record.roomId, item, options);
    items[index] = sent.item;
    const stored = await ctx.journal.replace(journalKey.intro(batchId), current, { ...record, items });
    if (sent.rejection) return rejected(sent.rejection);
    // Later items wait so the intro never lands out of order. A conflict means a
    // concurrent run owns the batch, and this run never overwrites its progress.
    if (sent.item.state !== 'accepted' || stored.kind !== 'stored') break;
    current = stored.revision;
  }
  return ok(items.map(toSendState));
}
