// Human principals, messaging participants and agent session bindings are
// separate identities. None of them is derived from another's display data.

import {
  type ContentLimits, type Decoded, array, decodeWith, displayText, elementPath, fail, identifier, literal,
  object, safeInteger, utcTimestamp, utf8Length, version,
} from './decode';
import { type BindingId, type DeviceId, type OwnerId, type ParticipantId, readId } from './ids';
import type { CallOptions, OperationResult } from './outcomes';

/**
 * An authenticated human owner. Identity is the provider issuer plus subject;
 * `verifiedEmail` is contact/display data only, so an email change never merges
 * or splits owners. `ownerId` is Khala's opaque owner key, never an email.
 */
export type AuthPrincipal = Readonly<{
  v: 1;
  ownerId: OwnerId;
  providerIssuer: string;
  providerSubject: string;
  verifiedEmail: string;
  /** UTC RFC 3339. */
  sessionExpiresAt: string;
}>;

/**
 * A room participant. `kind` and `ownerId` come from the authenticated mapping,
 * never from a display label.
 */
export type ParticipantView = Readonly<{
  participantId: ParticipantId;
  kind: 'human' | 'agent';
  ownerId: OwnerId;
  /** Nonempty; no control, bidi or invisible zero-width characters. */
  displayName: string;
  deviceIds: readonly DeviceId[];
}>;

/**
 * Immutable binding of an agent participant to one existing harness session on one
 * device. Targeting another session requires another binding; a revoked or
 * re-armed binding advances `generation`. Mirrored by the delivery domain, so it
 * carries its own envelope version.
 */
export type SessionBinding = Readonly<{
  v: 1;
  bindingId: BindingId;
  ownerId: OwnerId;
  agentParticipantId: ParticipantId;
  deviceId: DeviceId;
  harness: string;
  sessionId: string;
  generation: number;
}>;

const EMAIL = /^[^\s@]+@[^\s@]+$/;

export function decodeAuthPrincipal(input: unknown): Decoded<AuthPrincipal> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'ownerId', 'providerIssuer', 'providerSubject', 'verifiedEmail', 'sessionExpiresAt']);
    const principal: AuthPrincipal = {
      v: version(r.field('v'), r.at('v')),
      ownerId: readId<'OwnerId'>(r.field('ownerId'), r.at('ownerId')),
      providerIssuer: identifier(r.field('providerIssuer'), r.at('providerIssuer')),
      providerSubject: identifier(r.field('providerSubject'), r.at('providerSubject')),
      verifiedEmail: identifier(r.field('verifiedEmail'), r.at('verifiedEmail')),
      sessionExpiresAt: utcTimestamp(r.field('sessionExpiresAt'), r.at('sessionExpiresAt')),
    };
    if (!EMAIL.test(principal.verifiedEmail)) fail(r.at('verifiedEmail'), 'invalid_value');
    // An email standing in as the owner key would let an address change re-key an owner,
    // so any email-shaped owner key is refused, not only this principal's address.
    if (EMAIL.test(principal.ownerId)) fail(r.at('ownerId'), 'mismatch');
    return principal;
  });
}

/** Two principals are the same human only when issuer and subject both match exactly. */
export function sameProviderIdentity(a: AuthPrincipal, b: AuthPrincipal): boolean {
  return a.providerIssuer === b.providerIssuer && a.providerSubject === b.providerSubject;
}

export function decodeParticipantView(input: unknown, limits: ContentLimits): Decoded<ParticipantView> {
  return decodeWith(() => readParticipantView(input, '', limits));
}

export function readParticipantView(input: unknown, path: string, limits: ContentLimits): ParticipantView {
  const r = object(input, path, ['participantId', 'kind', 'ownerId', 'displayName', 'deviceIds']);
  const deviceIds = array(r.field('deviceIds'), r.at('deviceIds'))
    .map((value, index) => readId<'DeviceId'>(value, elementPath(r.at('deviceIds'), index)));
  deviceIds.forEach((id, index) => {
    if (deviceIds.indexOf(id) !== index) fail(elementPath(r.at('deviceIds'), index), 'duplicate');
  });
  const view: ParticipantView = {
    participantId: readId<'ParticipantId'>(r.field('participantId'), r.at('participantId')),
    kind: literal(r.field('kind'), r.at('kind'), ['human', 'agent']),
    ownerId: readId<'OwnerId'>(r.field('ownerId'), r.at('ownerId')),
    displayName: displayText(r.field('displayName'), r.at('displayName'), limits.maxDisplayNameBytes),
    deviceIds,
  };
  if (view.displayName.length === 0) fail(r.at('displayName'), 'empty');
  return view;
}

export function decodeSessionBinding(input: unknown): Decoded<SessionBinding> {
  return decodeWith(() => readSessionBinding(input, ''));
}

export function readSessionBinding(input: unknown, path: string): SessionBinding {
  const r = object(input, path, ['v', 'bindingId', 'ownerId', 'agentParticipantId', 'deviceId', 'harness', 'sessionId', 'generation']);
  return {
    v: version(r.field('v'), r.at('v')),
    bindingId: readId<'BindingId'>(r.field('bindingId'), r.at('bindingId')),
    ownerId: readId<'OwnerId'>(r.field('ownerId'), r.at('ownerId')),
    agentParticipantId: readId<'ParticipantId'>(r.field('agentParticipantId'), r.at('agentParticipantId')),
    deviceId: readId<'DeviceId'>(r.field('deviceId'), r.at('deviceId')),
    harness: identifier(r.field('harness'), r.at('harness')),
    sessionId: identifier(r.field('sessionId'), r.at('sessionId')),
    generation: safeInteger(r.field('generation'), r.at('generation')),
  };
}

/** Exact equality of every binding field, including version and generation. */
export function sameSessionBinding(a: SessionBinding, b: SessionBinding): boolean {
  return a.v === b.v && a.bindingId === b.bindingId && a.ownerId === b.ownerId && a.agentParticipantId === b.agentParticipantId
    && a.deviceId === b.deviceId && a.harness === b.harness && a.sessionId === b.sessionId && a.generation === b.generation;
}

/** `unavailable` means identity could not be determined; it is never a sign-out. */
export type IdentityState =
  | Readonly<{ kind: 'signed_in'; principal: AuthPrincipal }>
  | Readonly<{ kind: 'signed_out' }>
  | Readonly<{ kind: 'unavailable'; retryable: true }>;

/** Navigation the host performs to start sign-in; the adapter never navigates itself. */
export type SignInIntent = Readonly<{ kind: 'navigate'; url: string }>;

export interface IdentityPort {
  current(options?: CallOptions): Promise<IdentityState>;
  /** `returnPath` must satisfy `isSameOriginReturnPath`; otherwise `invalid_return_path`. */
  beginSignIn(returnPath: string, options?: CallOptions): Promise<OperationResult<SignInIntent, 'invalid_return_path'>>;
  signOut(operationId: string, options?: CallOptions): Promise<OperationResult<null, never>>;
}

/** Longest accepted sign-in return path, in UTF-8 bytes. */
export const MAX_RETURN_PATH_BYTES = 2048;

const UNSAFE_PATH = /[\\\u0000-\u001f\u007f]/;

/**
 * True for an absolute path on the current origin. Rejects scheme-relative
 * (`//host`), backslash and control-character forms that browsers may resolve
 * to another origin.
 */
export function isSameOriginReturnPath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && !UNSAFE_PATH.test(path) && utf8Length(path) <= MAX_RETURN_PATH_BYTES;
}
