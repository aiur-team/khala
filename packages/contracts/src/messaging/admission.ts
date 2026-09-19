// Room sharing and admission. The authenticated principal always comes from the
// control context, never from these inputs. The admission result carries no history;
// disclosure is gated by G-ADMISSION and G-RETENTION and deliberately absent here.

import { type ContentLimits, type Decoded, decodeWith, fail, identifier, literal, nullable, object, utcTimestamp } from './decode';
import type { DeviceId, RoomId } from './ids';
import type { CallOptions, OperationResult } from './outcomes';
import { type RoomSummary, readRoomSummary } from './rooms';

export type ShareGrant = Readonly<{
  inviteRef: string;
  /** Absolute `https:` URL; `http:` only for loopback development hosts. */
  shareUrl: string;
  /** UTC RFC 3339, or `null` when the substrate imposes no expiry. */
  expiresAt: string | null;
}>;

export type InviteState =
  | 'auth_required'
  | 'eligible'
  | 'already_joined'
  | 'expired'
  | 'revoked'
  | 'identity_mismatch'
  | 'unavailable';

/**
 * A successful admission. Retrying the same admission after it applied yields
 * `already_joined` for the same room, never a second membership. Resolving
 * G-ADMISSION may add `outcome` variants (for example a pending approval); consumers
 * must handle `outcome` exhaustively so such an addition is a reviewed version bump.
 */
export type Admission = Readonly<{ outcome: 'joined' | 'already_joined'; room: RoomSummary }>;

export type AdmissionRejection = 'auth_required' | 'expired' | 'revoked' | 'identity_mismatch' | 'forbidden' | 'operation_mismatch';

/** The creator selects one immutable admission policy for each issued link. */
export type AdmissionPolicy =
  | Readonly<{ v: 1; kind: 'link'; history: 'none' }>
  | Readonly<{ v: 1; kind: 'named_email'; email: string; history: 'none' }>
  | Readonly<{ v: 1; kind: 'link'; history: 'full' }>;

export interface AdmissionPort {
  share(
    input: Readonly<{ operationId: string; roomId: RoomId; policy?: AdmissionPolicy }>,
    options?: CallOptions,
  ): Promise<OperationResult<ShareGrant, AdmissionRejection>>;
  inspect(inviteRef: string, options?: CallOptions): Promise<InviteState>;
  admit(input: Readonly<{ operationId: string; inviteRef: string; deviceId: DeviceId }>, options?: CallOptions): Promise<OperationResult<Admission, AdmissionRejection>>;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function decodeShareGrant(input: unknown): Decoded<ShareGrant> {
  return decodeWith(() => {
    const r = object(input, '', ['inviteRef', 'shareUrl', 'expiresAt']);
    const shareUrl = identifier(r.field('shareUrl'), r.at('shareUrl'));
    let url: URL | undefined;
    try {
      url = new URL(shareUrl);
    } catch {
      url = undefined;
    }
    if (!url || url.username || url.password
      || !(url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname)))) fail(r.at('shareUrl'), 'invalid_value');
    return {
      inviteRef: identifier(r.field('inviteRef'), r.at('inviteRef')),
      shareUrl,
      expiresAt: nullable(r.field('expiresAt'), value => utcTimestamp(value, r.at('expiresAt'))),
    };
  });
}

export function decodeInviteState(input: unknown): Decoded<InviteState> {
  return decodeWith(() => literal(input, '', ['auth_required', 'eligible', 'already_joined', 'expired', 'revoked', 'identity_mismatch', 'unavailable']));
}

export function decodeAdmission(input: unknown, limits: ContentLimits): Decoded<Admission> {
  return decodeWith(() => {
    const r = object(input, '', ['outcome', 'room']);
    const admission: Admission = {
      outcome: literal(r.field('outcome'), r.at('outcome'), ['joined', 'already_joined']),
      room: readRoomSummary(r.field('room'), r.at('room'), limits),
    };
    if (admission.room.membership !== 'joined') fail(r.at('room.membership'), 'mismatch');
    return admission;
  });
}
