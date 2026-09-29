// Versioned, grant-free results shared by the browser and native CLI.
import { type Decoded, decodeWith, fail, identifier, literal, nullable, object, utcTimestamp, version } from './decode';
import type { AccessRequestOutcome } from './discovery';

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
