// `ChannelCreateAdapterPort` over a channel substrate. The hosted Matrix substrate
// and the internal local-transport substrate both tag a created room with its
// operation ID and never promise that `createRoom` is idempotent, so the workflow
// calls `reconcile` before any repeat and only `pending` (proof that no room
// carries the key) allows another `create`. Nothing here writes a discovery
// catalog entry: a channel with no catalog record is `secret`.

import type {
  AuthorizedChannelRef,
  CallOptions,
  ChannelCreateAdapterPort,
  ChannelCreateReconciliation,
  ChannelSummary,
  RoomId,
  TrustedClock,
} from '@khala/contracts/messaging/index';

/**
 * The two `ChannelSubstrate` methods creation needs, declared structurally so a
 * composition root can pass the messaging substrate without this module
 * importing it. `unknown` means the room may exist; `absent` proves it does not.
 */
export type ChannelCreateSubstrate = Readonly<{
  createRoom(input: Readonly<{ operationId: string; title: string | null }>, options?: CallOptions): Promise<
    | Readonly<{ kind: 'done'; value: ChannelSummary }>
    | Readonly<{ kind: 'rejected'; code: string }>
    | Readonly<{ kind: 'unavailable' }>
    | Readonly<{ kind: 'unknown' }>
  >;
  findCreatedRoom(input: Readonly<{ operationId: string }>, options?: CallOptions): Promise<
    | Readonly<{ kind: 'found'; room: ChannelSummary }>
    | Readonly<{ kind: 'absent' }>
    | Readonly<{ kind: 'unknown' }>
    | Readonly<{ kind: 'unavailable' }>
  >;
}>;

export function createSubstrateChannelCreateAdapter(deps: Readonly<{
  /** The owner's own substrate; the room it creates belongs to that owner. */
  substrate: ChannelCreateSubstrate;
  /** Opaque server-only reference for a created room; never the room ID itself. */
  channelRef(roomId: RoomId): AuthorizedChannelRef;
  clock: TrustedClock;
}>): ChannelCreateAdapterPort {
  async function create(
    input: Parameters<ChannelCreateAdapterPort['create']>[0],
    options?: CallOptions,
  ): Promise<ChannelCreateReconciliation> {
    const key = input.idempotencyKey;
    if (!current(input.workflow, deps.clock)) return result(key, 'unavailable');
    let effect;
    try {
      effect = await deps.substrate.createRoom({ operationId: key, title: input.intent.proposedTitle }, options);
    } catch {
      // A thrown effect may still have landed.
      return result(key, 'outcome_unknown');
    }
    if (effect.kind === 'done') return result(key, 'created', deps.channelRef(effect.value.roomId));
    if (effect.kind === 'rejected') return result(key, 'denied');
    return result(key, effect.kind === 'unknown' ? 'outcome_unknown' : 'unavailable');
  }

  async function reconcile(
    input: Parameters<ChannelCreateAdapterPort['reconcile']>[0],
    options?: CallOptions,
  ): Promise<ChannelCreateReconciliation> {
    const key = input.idempotencyKey;
    let lookup;
    try {
      lookup = await deps.substrate.findCreatedRoom({ operationId: key }, options);
    } catch {
      return result(key, 'unavailable');
    }
    if (lookup.kind === 'found') return result(key, 'already_created', deps.channelRef(lookup.room.roomId));
    // `absent` is the substrate's proof that no room carries this key.
    if (lookup.kind === 'absent') return result(key, 'pending');
    return result(key, lookup.kind === 'unknown' ? 'outcome_unknown' : 'unavailable');
  }

  return Object.freeze({ create, reconcile });
}

function current(workflow: Parameters<ChannelCreateAdapterPort['create']>[0]['workflow'], clock: TrustedClock): boolean {
  return workflow.v === 1
    && workflow.kind === 'human_authorized_channel_create'
    && clock() < Date.parse(workflow.expiresAt);
}

function result(
  idempotencyKey: string,
  outcome: ChannelCreateReconciliation['outcome'],
  channelRef: AuthorizedChannelRef | null = null,
): ChannelCreateReconciliation {
  return { v: 1, idempotencyKey, outcome, channelRef };
}
