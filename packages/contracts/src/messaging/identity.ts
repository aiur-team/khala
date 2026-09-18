// Human principals, messaging participants and agent session bindings are
// separate identities. None of them is derived from another's display data.

import {
  type ContentLimits, type Decoded, array, decodeWith, elementPath, fail, identifier, label, literal,
  object, safeInteger, utcTimestamp, utf8Length, version,
} from './decode';
import type { CallOptions, OperationResult } from './outcomes';

/**
 * An authenticated human owner. Identity is the provider issuer plus subject;
 * `verifiedEmail` is contact/display data only, so an email change never merges
 * or splits owners. `ownerId` is Khala's opaque owner key, never the email.
 */
export type AuthPrincipal = Readonly<{
  v: 1;
  ownerId: string;
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
  participantId: string;
  kind: 'human' | 'agent';
  ownerId: string;
  displayName: string;
  deviceIds: readonly string[];
}>;

/**
 * Immutable binding of an agent participant to one existing harness session on one
 * device. Targeting another session requires another binding; a revoked or
 * re-armed binding advances `generation`.
 */
export type SessionBinding = Readonly<{
  bindingId: string;
  ownerId: string;
  agentParticipantId: string;
  deviceId: string;
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
      ownerId: identifier(r.field('ownerId'), r.at('ownerId')),
      providerIssuer: identifier(r.field('providerIssuer'), r.at('providerIssuer')),
      providerSubject: identifier(r.field('providerSubject'), r.at('providerSubject')),
      verifiedEmail: identifier(r.field('verifiedEmail'), r.at('verifiedEmail')),
      sessionExpiresAt: utcTimestamp(r.field('sessionExpiresAt'), r.at('sessionExpiresAt')),
    };
    if (!EMAIL.test(principal.verifiedEmail)) fail(r.at('verifiedEmail'), 'invalid_value');
    // An email standing in as the owner key would let an address change re-key an owner.
    if (principal.ownerId.toLowerCase() === principal.verifiedEmail.toLowerCase()) fail(r.at('ownerId'), 'mismatch');
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
    .map((value, index) => identifier(value, elementPath(r.at('deviceIds'), index)));
  deviceIds.forEach((id, index) => {
    if (deviceIds.indexOf(id) !== index) fail(elementPath(r.at('deviceIds'), index), 'duplicate');
  });
  return {
    participantId: identifier(r.field('participantId'), r.at('participantId')),
    kind: literal(r.field('kind'), r.at('kind'), ['human', 'agent']),
    ownerId: identifier(r.field('ownerId'), r.at('ownerId')),
    displayName: label(r.field('displayName'), r.at('displayName'), limits.maxDisplayNameBytes),
    deviceIds,
  };
}

export function decodeSessionBinding(input: unknown): Decoded<SessionBinding> {
  return decodeWith(() => readSessionBinding(input, ''));
}

export function readSessionBinding(input: unknown, path: string): SessionBinding {
  const r = object(input, path, ['bindingId', 'ownerId', 'agentParticipantId', 'deviceId', 'harness', 'sessionId', 'generation']);
  return {
    bindingId: identifier(r.field('bindingId'), r.at('bindingId')),
    ownerId: identifier(r.field('ownerId'), r.at('ownerId')),
    agentParticipantId: identifier(r.field('agentParticipantId'), r.at('agentParticipantId')),
    deviceId: identifier(r.field('deviceId'), r.at('deviceId')),
    harness: identifier(r.field('harness'), r.at('harness')),
    sessionId: identifier(r.field('sessionId'), r.at('sessionId')),
    generation: safeInteger(r.field('generation'), r.at('generation')),
  };
}

/** Exact equality of every binding field, including generation. */
export function sameSessionBinding(a: SessionBinding, b: SessionBinding): boolean {
  return a.bindingId === b.bindingId && a.ownerId === b.ownerId && a.agentParticipantId === b.agentParticipantId
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

const UNSAFE_PATH = /[\\\u0000-\u001f\u007f]/;

/**
 * True for an absolute path on the current origin. Rejects scheme-relative
 * (`//host`), backslash and control-character forms that browsers may resolve
 * to another origin.
 */
export function isSameOriginReturnPath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && !UNSAFE_PATH.test(path) && utf8Length(path) <= 2048;
}
