// Shared dependencies and guards for the room commands. Internal to rooms/.

import {
  type AuthPrincipal, type CallOptions, type ContentLimits, type DeviceId, type DevicePort, type MessageContent,
  type OperationResult, type ParticipantView, type RoomId, type RoomRejection, type RoomSummary,
  decodeMessageContent, digestMessageContent, rejected, unavailable,
} from '@khala/contracts/messaging/index';
import { decodeWith, identifier } from '@khala/contracts/messaging/decode';
import type { RoomJournal, SendAuthor, SendItem } from './journal';
import type { RoomSubstrate, SubstrateEffect, SubstrateRead } from './substrate';

export type RoomContext = Readonly<{
  principal: AuthPrincipal;
  /** The signed-in participant: the owning human, or an agent delegated by that owner. */
  actor: ParticipantView;
  device: DevicePort;
  substrate: RoomSubstrate;
  journal: RoomJournal;
  limits: ContentLimits;
  newId: () => string;
  stopped: () => boolean;
  /** Reports a local send state change to room observers. */
  echo: (roomId: RoomId, item: SendItem) => void;
}>;

export type Refusal = OperationResult<never, RoomRejection>;

/** Effects run only on a ready device of this service's lifecycle. */
export function deviceGate(ctx: RoomContext, options: CallOptions | undefined): Readonly<{ deviceId: DeviceId }> | Refusal {
  if (ctx.stopped() || options?.signal?.aborted) return unavailable();
  const view = ctx.device.current();
  if (view.state === 'revoked' || view.state === 'lost') return rejected('forbidden');
  if (view.state !== 'ready' || view.deviceId === null) return unavailable();
  return { deviceId: view.deviceId };
}

export function isRefusal(value: object): value is Refusal {
  return 'kind' in value;
}

export function authorOf(ctx: RoomContext, deviceId: DeviceId): SendAuthor {
  return { ownerId: ctx.actor.ownerId, participantId: ctx.actor.participantId, deviceId };
}

export function sameAuthor(a: SendAuthor, b: SendAuthor): boolean {
  return a.ownerId === b.ownerId && a.participantId === b.participantId && a.deviceId === b.deviceId;
}

export function isIdentifier(value: unknown): value is string {
  return decodeWith(() => identifier(value, '')).ok;
}

/** Validates content against the substrate limits and digests its exact bytes. */
export async function digestContent(ctx: RoomContext, content: unknown): Promise<Readonly<{ content: MessageContent; digest: string }> | Refusal> {
  const decoded = decodeMessageContent(content, ctx.limits);
  if (!decoded.ok) return rejected(decoded.error.code === 'too_long' ? 'too_large' : 'invalid_request');
  const digest = await digestMessageContent(decoded.value);
  if (!digest.ok) return digest.reason === 'crypto_unavailable' ? unavailable() : rejected('invalid_request');
  return { content: decoded.value, digest: digest.digest };
}

/** Refuses sends into a room this participant cannot post to, before any effect. */
export async function membershipGate(ctx: RoomContext, roomId: RoomId, options: CallOptions | undefined): Promise<RoomSummary | Refusal> {
  const room = await safeRead(() => ctx.substrate.room(roomId, options));
  if (room.kind === 'unavailable') return unavailable();
  if (room.kind === 'rejected') return rejected(room.code);
  if (room.value.membership === 'revoked') return rejected('forbidden');
  if (room.value.membership !== 'joined') return rejected('not_joined');
  return room.value;
}

/** A thrown effect may have landed, so it is `unknown`, never a failure. */
export async function safeEffect<T>(run: () => Promise<SubstrateEffect<T>>): Promise<SubstrateEffect<T>> {
  try {
    return await run();
  } catch {
    return { kind: 'unknown' };
  }
}

export async function safeRead<T>(run: () => Promise<SubstrateRead<T>>): Promise<SubstrateRead<T>> {
  try {
    return await run();
  } catch {
    return { kind: 'unavailable' };
  }
}
