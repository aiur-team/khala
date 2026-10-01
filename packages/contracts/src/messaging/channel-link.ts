// Versioned, grant-free results shared by the browser and native CLI.
import { type Decoded, decodeWith, fail, identifier, literal, nullable, object, utcTimestamp, version } from './decode';
import type { AccessRequestOutcome } from './discovery';
import { decodeChannelAccessRequest, MAX_CHANNEL_URL_BYTES, type ChannelAccessRequest } from './discovery';
import { decodeRoomId, type RoomId } from './ids';

export type HumanChannelLinkResolveRequest = Readonly<{ v: 1; channelUrl: string }>;
export type PersonalChannelLinkRequest = Readonly<{ v: 1; roomId: RoomId }>;
export type AgentChannelLinkRequest = Extract<ChannelAccessRequest, { kind: 'channel_url' }>;

/** A channel link is one exact-origin share URL, without a query or fragment. */
export function decodeHumanChannelLinkResolveRequest(input: unknown, origin: string): Decoded<HumanChannelLinkResolveRequest> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'channelUrl']);
    const channelUrl = r.field('channelUrl');
    if (typeof channelUrl !== 'string') fail(r.at('channelUrl'), 'wrong_type');
    let url: URL;
    try { url = new URL(channelUrl); } catch { fail(r.at('channelUrl'), 'invalid_value'); }
    if (channelUrl.length > MAX_CHANNEL_URL_BYTES || url.href !== channelUrl || url.origin !== origin
      || url.username || url.password || url.search || url.hash
      || !/^\/join\/[A-Za-z0-9_-]{8,256}$/u.test(url.pathname)) fail(r.at('channelUrl'), 'invalid_value');
    return { v: version(r.field('v'), r.at('v')), channelUrl };
  });
}

export function decodePersonalChannelLinkRequest(input: unknown): Decoded<PersonalChannelLinkRequest> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'roomId']);
    const room = decodeRoomId(r.field('roomId'));
    if (!room.ok) fail(r.at('roomId'), 'invalid_value');
    return { v: version(r.field('v'), r.at('v')), roomId: room.value };
  });
}

export function decodeAgentChannelLinkRequest(input: unknown, origin: string): Decoded<AgentChannelLinkRequest> {
  return decodeWith(() => {
    const request = decodeChannelAccessRequest(input, origin);
    if (!request.ok || request.value.kind !== 'channel_url') fail('', 'invalid_value');
    if (!decodeHumanChannelLinkResolveRequest({ v: 1, channelUrl: request.value.channelUrl }, origin).ok) {
      fail('/channelUrl', 'invalid_value');
    }
    return request.value;
  });
}

export type HumanChannelLinkResult = Readonly<{ v: 1; kind: 'join_required' | 'joined' | 'expired' | 'revoked' | 'forbidden' | 'auth_required' | 'invalid_link' | 'unavailable' }>;
export type PersonalChannelLinkResult =
  | Readonly<{ v: 1; kind: 'personal_link'; shareUrl: string; expiresAt: string | null }>
  | Readonly<{ v: 1; kind: 'auth_required' | 'forbidden' | 'invalid_link' | 'expired' | 'revoked' | 'unavailable' }>;
export type AgentChannelLinkResult =
  | Readonly<{ v: 1; kind: 'request'; operationId: string; outcome: AccessRequestOutcome }>
  | Readonly<{ v: 1; kind: 'use_your_link'; action: 'join_in_browser_then_copy_your_link' }>
  | Readonly<{ v: 1; kind: 'auth_required' | 'forbidden' | 'invalid_link' | 'expired' | 'revoked' | 'unavailable' }>;

export function decodeHumanChannelLinkResult(input: unknown): Decoded<HumanChannelLinkResult> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'kind']);
    return { v: version(r.field('v'), r.at('v')),
      kind: literal(r.field('kind'), r.at('kind'), ['join_required', 'joined', 'expired', 'revoked', 'forbidden', 'auth_required', 'invalid_link', 'unavailable']) };
  });
}

export function decodePersonalChannelLinkResult(input: unknown): Decoded<PersonalChannelLinkResult> {
  return decodeWith(() => {
    const kind = typeof input === 'object' && input !== null ? (input as { kind?: unknown }).kind : undefined;
    const r = object(input, '', kind === 'personal_link' ? ['v', 'kind', 'shareUrl', 'expiresAt'] : ['v', 'kind']);
    const v = version(r.field('v'), r.at('v'));
    if (kind !== 'personal_link') return { v, kind: literal(r.field('kind'), r.at('kind'),
      ['auth_required', 'forbidden', 'invalid_link', 'expired', 'revoked', 'unavailable']) };
    const shareUrl = r.field('shareUrl');
    if (typeof shareUrl !== 'string') fail(r.at('shareUrl'), 'wrong_type');
    let url: URL;
    try { url = new URL(shareUrl); } catch { fail(r.at('shareUrl'), 'invalid_value'); }
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (!(url.protocol === 'https:' || url.protocol === 'http:' && loopback)
      || url.username || url.password || url.search || url.hash || !url.pathname.startsWith('/join/')) {
      fail(r.at('shareUrl'), 'invalid_value');
    }
    return { v, kind, shareUrl, expiresAt: nullable(r.field('expiresAt'),
      value => utcTimestamp(value, r.at('expiresAt'))) };
  });
}

export function decodeAgentChannelLinkResult(input: unknown): Decoded<AgentChannelLinkResult> {
  return decodeWith(() => {
    const kind = typeof input === 'object' && input !== null ? (input as { kind?: unknown }).kind : undefined;
    const r = object(input, '', kind === 'request' ? ['v', 'kind', 'operationId', 'outcome']
      : kind === 'use_your_link' ? ['v', 'kind', 'action'] : ['v', 'kind']);
    const v = version(r.field('v'), r.at('v'));
    if (kind === 'request') return { v, kind,
      operationId: identifier(r.field('operationId'), r.at('operationId')),
      outcome: literal(r.field('outcome'), r.at('outcome'), [
        'pending_owner', 'approved', 'connecting', 'connected', 'repair_required', 'denied', 'expired', 'revoked', 'unavailable',
      ]) };
    if (kind === 'use_your_link') return { v, kind,
      action: literal(r.field('action'), r.at('action'), ['join_in_browser_then_copy_your_link']) };
    return { v, kind: literal(r.field('kind'), r.at('kind'),
      ['auth_required', 'forbidden', 'invalid_link', 'expired', 'revoked', 'unavailable']) };
  });
}
