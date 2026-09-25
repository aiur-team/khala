// Transport-neutral channel-access journal contracts. Discovery requests can
// create owner-decision records only; approval becomes authority only through
// the operation-specific, trusted in-process fulfillment boundary below.

import {
  type Decoded,
  decodeWith,
  displayText,
  fail,
  identifier,
  literal,
  nullable,
  object,
  safeInteger,
  utcTimestamp,
  version,
} from './decode';
import type {
  AccessRequestStatus,
  AuthorizedChannelRef,
  ChannelAccessRequest,
  ChannelCreateIntent,
  DiscoveryRequester,
  StableAgentPrincipal,
} from './discovery';
import type { AuthPrincipal } from './identity';
import { type OwnerId, readId } from './ids';
import type { CallOptions, OperationResult } from './outcomes';
import { readCanonicalOrigin } from './pairing';

export const MAX_CHANNEL_ACCESS_REQUESTER_PENDING = 5;
export const MAX_CHANNEL_ACCESS_OWNER_PENDING = 50;
export const MAX_CHANNEL_ACCESS_NOTIFICATIONS_PER_MINUTE = 10;
export const MAX_CHANNEL_ACCESS_LABEL_BYTES = 256;
export const CHANNEL_ACCESS_REQUEST_LIFETIME_MS = 7 * 24 * 60 * 60_000;
export const CHANNEL_ACCESS_COOLDOWN_MS = 5 * 60_000;
export const CHANNEL_ACCESS_SENSITIVE_RETENTION_MS = 30 * 24 * 60 * 60_000;

export const CHANNEL_ACCESS_OWNER_OUTCOMES = [
  'pending_owner',
  'approved',
  'connecting',
  'connected',
  'repair_required',
  'denied',
  'expired',
  'revoked',
] as const;

export type ChannelAccessOperationKind = 'access' | 'create';
export type ChannelAccessOwnerOutcome = (typeof CHANNEL_ACCESS_OWNER_OUTCOMES)[number];
export type ChannelAccessRequestHandle = string & { readonly __khala: 'ChannelAccessRequestHandle' };

/** Verified session facts plus bounded labels that remain explicitly untrusted. */
export type ChannelAccessRequesterContext = Readonly<{
  v: 1;
  principal: StableAgentPrincipal;
  origin: string;
  sessionGeneration: number;
  sessionFingerprint: string;
  harness: string;
  displayLabel: string | null;
  workspaceLabel: string | null;
}>;

export type ChannelAccessRequesterProjection = Readonly<{
  sessionFingerprint: string;
  harness: string;
  displayLabel: string | null;
  workspaceLabel: string | null;
}>;

export type ChannelAccessOwnerProjection = Readonly<{
  v: 1;
  requestHandle: ChannelAccessRequestHandle;
  outcome: ChannelAccessOwnerOutcome;
  revision: string;
  requester: ChannelAccessRequesterProjection;
  createdAt: string;
  deadline: string;
  ownerDecision: 'pending' | 'approved' | 'denied';
  decidedAt: string | null;
  muted: boolean;
  muteRevision: string | null;
}> & (
  | Readonly<{
    operationKind: 'access';
    detail: Readonly<{ kind: 'access'; title: string; history: 'none' }>;
  }>
  | Readonly<{
    operationKind: 'create';
    detail: Readonly<{ kind: 'create'; proposedTitle: string }>;
  }>
);

export type ChannelAccessStatusQuery = Readonly<{
  v: 1;
  operationId: string;
  operationKind: ChannelAccessOperationKind;
}>;

export type ChannelAccessDecisionCommand = Readonly<{
  v: 1;
  requestHandle: ChannelAccessRequestHandle;
  expectedRevision: string;
  decision: 'approve' | 'deny';
  operationId: string;
}>;

export type ChannelAccessMuteCommand = Readonly<{
  v: 1;
  requestHandle: ChannelAccessRequestHandle;
  /** `null` creates the first mute revision; every later update names the current revision. */
  expectedRevision: string | null;
  action: 'mute' | 'unmute';
  operationId: string;
}>;

export type ChannelAccessMuteResult = Readonly<{
  v: 1;
  operationKind: ChannelAccessOperationKind;
  muted: boolean;
  revision: string;
}>;

export type ChannelAccessNotification = Readonly<{
  v: 1;
  notificationId: string;
  /** A higher revision is an idempotent upsert of the same logical notification. */
  revision: string;
  ownerId: OwnerId;
  count: number;
}> & (
  | Readonly<{ kind: 'request'; requestHandle: ChannelAccessRequestHandle }>
  | Readonly<{ kind: 'batch'; requestHandle: null }>
);

export type ChannelAccessResolvedTarget = Readonly<{
  kind: 'resolved';
  ownerId: OwnerId;
  channelRef: AuthorizedChannelRef;
  targetRevision: string;
  /** Bounded owner-controlled display data, not authority. */
  title: string;
}>;

export type ChannelCreateResolvedTarget = Readonly<{
  kind: 'resolved';
  ownerId: OwnerId;
  ownerRevision: string;
}>;

export type ChannelAccessResolutionResult = ChannelAccessResolvedTarget | Readonly<{ kind: 'unavailable' }>;
export type ChannelCreateResolutionResult = ChannelCreateResolvedTarget | Readonly<{ kind: 'unavailable' }>;

export type ChannelAccessRevalidationResult =
  | Readonly<{ kind: 'current'; ownerId: OwnerId; targetRevision: string; title: string }>
  | Readonly<{ kind: 'revoked' }>
  | Readonly<{ kind: 'unavailable' }>;

export type ChannelCreateRevalidationResult =
  | Readonly<{ kind: 'current'; ownerId: OwnerId; ownerRevision: string }>
  | Readonly<{ kind: 'revoked' }>
  | Readonly<{ kind: 'unavailable' }>;

export type ChannelAccessOwnershipResult =
  | Readonly<{ kind: 'owned'; ownerId: OwnerId; targetRevision: string }>
  | Readonly<{ kind: 'forbidden' }>
  | Readonly<{ kind: 'unavailable' }>;

export type ChannelAccessRequesterCheck =
  | Readonly<{ kind: 'current' }>
  | Readonly<{ kind: 'revoked' }>
  | Readonly<{ kind: 'unavailable' }>;

/**
 * Trusted discovery-side adapter. Every method is an inspection or policy
 * check; this boundary has no create, admission, grant, or provider effect.
 */
export interface ChannelAccessResolutionPort {
  resolveAccess(
    input: ChannelAccessRequest,
    requester: DiscoveryRequester,
    options?: CallOptions,
  ): Promise<ChannelAccessResolutionResult>;
  resolveCreate(
    input: ChannelCreateIntent,
    requester: DiscoveryRequester,
    options?: CallOptions,
  ): Promise<ChannelCreateResolutionResult>;
  revalidateAccess(input: Readonly<{
    ownerId: OwnerId;
    channelRef: AuthorizedChannelRef;
    targetRevision: string;
    requester: DiscoveryRequester;
  }>, options?: CallOptions): Promise<ChannelAccessRevalidationResult>;
  revalidateCreate(input: Readonly<{
    ownerId: OwnerId;
    ownerRevision: string;
    requester: DiscoveryRequester;
  }>, options?: CallOptions): Promise<ChannelCreateRevalidationResult>;
  currentAccessOwner(
    channelRef: AuthorizedChannelRef,
    owner: AuthPrincipal,
    options?: CallOptions,
  ): Promise<ChannelAccessOwnershipResult>;
  checkRequester(requester: DiscoveryRequester, options?: CallOptions): Promise<ChannelAccessRequesterCheck>;
}

/** Agent request journal; the additional context comes from trusted composition. */
export interface ChannelAccessRequestJournalPort {
  requestAccess(
    input: ChannelAccessRequest,
    requester: DiscoveryRequester,
    context: ChannelAccessRequesterContext,
    options?: CallOptions,
  ): Promise<AccessRequestStatus>;
  requestCreate(
    input: ChannelCreateIntent,
    requester: DiscoveryRequester,
    context: ChannelAccessRequesterContext,
    options?: CallOptions,
  ): Promise<AccessRequestStatus>;
  inspect(
    input: ChannelAccessStatusQuery,
    requester: DiscoveryRequester,
    options?: CallOptions,
  ): Promise<AccessRequestStatus>;
}

export type ChannelAccessDecisionRejection =
  | 'forbidden'
  | 'not_found'
  | 'stale_revision'
  | 'decision_conflict'
  | 'expired'
  | 'revoked'
  | 'operation_mismatch';

/** Human-only journal surface. The principal comes from authenticated composition. */
export interface ChannelAccessDecisionPort {
  inbox(
    owner: AuthPrincipal,
    options?: CallOptions,
  ): Promise<OperationResult<readonly ChannelAccessOwnerProjection[], never>>;
  decide(
    input: ChannelAccessDecisionCommand,
    owner: AuthPrincipal,
    options?: CallOptions,
  ): Promise<OperationResult<ChannelAccessOwnerProjection, ChannelAccessDecisionRejection>>;
  setMute(
    input: ChannelAccessMuteCommand,
    owner: AuthPrincipal,
    options?: CallOptions,
  ): Promise<OperationResult<ChannelAccessMuteResult, 'forbidden' | 'not_found' | 'stale_revision' | 'operation_mismatch'>>;
}

/** Minimal-payload, revisioned notification upsert. Inbox state remains authoritative. */
export interface ChannelAccessNotificationPort {
  publish(
    notification: ChannelAccessNotification,
    options?: CallOptions,
  ): Promise<OperationResult<null, never>>;
}

export type ChannelAccessFulfillmentClaim = Readonly<{
  v: 1;
  requestHandle: ChannelAccessRequestHandle;
  expectedRevision: string;
  operationId: string;
}>;

export type ChannelAccessFulfillmentUpdate = Readonly<{
  v: 1;
  requestHandle: ChannelAccessRequestHandle;
  expectedRevision: string;
  operationId: string;
  outcome: 'connected' | 'repair_required' | 'revoked';
}>;

type ChannelAccessAuthorizationCommon = Readonly<{
  v: 1;
  authorizationRef: string;
  requestHandle: ChannelAccessRequestHandle;
  requestRevision: string;
  /** The original requester operation, never a credential. */
  operationId: string;
  ownerId: OwnerId;
  requester: StableAgentPrincipal;
  origin: string;
  sessionGeneration: number;
  sessionFingerprint: string;
  deadline: string;
}>;

declare const accessAuthorization: unique symbol;
declare const createAuthorization: unique symbol;

/** Trusted access-consumer authority. No decoder turns caller JSON into this type. */
export type ChannelAccessAuthorization = ChannelAccessAuthorizationCommon & Readonly<{
  kind: 'access';
  channelRef: AuthorizedChannelRef;
  [accessAuthorization]: true;
}>;

/** Trusted create-consumer authority. It cannot be passed to an access consumer. */
export type ChannelCreateAuthorization = ChannelAccessAuthorizationCommon & Readonly<{
  kind: 'create';
  proposalDigest: string;
  proposedTitle: string;
  [createAuthorization]: true;
}>;

export type ChannelAccessFulfillmentRejection =
  | 'expired'
  | 'revoked'
  | 'stale_revision'
  | 'operation_mismatch'
  | 'wrong_kind';

/**
 * Trusted in-process boundary. Claiming moves approved work to connecting;
 * updating changes journal lifecycle only and has no provider-side method.
 */
export interface ChannelAccessFulfillmentPort {
  claimAccess(
    input: ChannelAccessFulfillmentClaim,
    options?: CallOptions,
  ): Promise<OperationResult<ChannelAccessAuthorization, ChannelAccessFulfillmentRejection>>;
  claimCreate(
    input: ChannelAccessFulfillmentClaim,
    options?: CallOptions,
  ): Promise<OperationResult<ChannelCreateAuthorization, ChannelAccessFulfillmentRejection>>;
  updateAccess(
    input: ChannelAccessFulfillmentUpdate,
    options?: CallOptions,
  ): Promise<OperationResult<AccessRequestStatus, ChannelAccessFulfillmentRejection>>;
  updateCreate(
    input: ChannelAccessFulfillmentUpdate,
    options?: CallOptions,
  ): Promise<OperationResult<AccessRequestStatus, ChannelAccessFulfillmentRejection>>;
}

const DIGEST = /^[A-Za-z0-9_-]{43}$/;
const REQUEST_HANDLE = /^careq_[A-Za-z0-9_-]{43}$/;
const OWNER_PROJECTION_FIELDS = [
  'v', 'requestHandle', 'operationKind', 'outcome', 'revision', 'requester', 'detail', 'createdAt', 'deadline',
  'ownerDecision', 'decidedAt', 'muted', 'muteRevision',
] as const;

function readDigest(input: unknown, path: string): string {
  if (typeof input !== 'string') fail(path, 'wrong_type');
  if (!DIGEST.test(input)) fail(path, 'invalid_value');
  return input;
}

function readRequestHandle(input: unknown, path: string): ChannelAccessRequestHandle {
  if (typeof input !== 'string') fail(path, 'wrong_type');
  if (!REQUEST_HANDLE.test(input)) fail(path, 'invalid_value');
  return input as ChannelAccessRequestHandle;
}

function readOptionalDisplayLabel(input: unknown, path: string): string | null {
  return nullable(input, value => {
    const decoded = displayText(value, path, MAX_CHANNEL_ACCESS_LABEL_BYTES);
    if (decoded.length === 0) fail(path, 'empty');
    return decoded;
  });
}

function readRequesterProjection(input: unknown, path: string): ChannelAccessRequesterProjection {
  const r = object(input, path, ['sessionFingerprint', 'harness', 'displayLabel', 'workspaceLabel']);
  return {
    sessionFingerprint: readDigest(r.field('sessionFingerprint'), r.at('sessionFingerprint')),
    harness: identifier(r.field('harness'), r.at('harness')),
    displayLabel: readOptionalDisplayLabel(r.field('displayLabel'), r.at('displayLabel')),
    workspaceLabel: readOptionalDisplayLabel(r.field('workspaceLabel'), r.at('workspaceLabel')),
  };
}

function readDetail(
  input: unknown,
  path: string,
  operationKind: ChannelAccessOperationKind,
): ChannelAccessOwnerProjection['detail'] {
  if (operationKind === 'access') {
    const r = object(input, path, ['kind', 'title', 'history']);
    const kind = literal(r.field('kind'), r.at('kind'), ['access', 'create']);
    if (kind !== 'access') fail(r.at('kind'), 'mismatch');
    const title = displayText(r.field('title'), r.at('title'), MAX_CHANNEL_ACCESS_LABEL_BYTES);
    if (title.length === 0) fail(r.at('title'), 'empty');
    return { kind, title, history: literal(r.field('history'), r.at('history'), ['none']) };
  }
  const r = object(input, path, ['kind', 'proposedTitle']);
  const kind = literal(r.field('kind'), r.at('kind'), ['access', 'create']);
  if (kind !== 'create') fail(r.at('kind'), 'mismatch');
  const proposedTitle = displayText(r.field('proposedTitle'), r.at('proposedTitle'), MAX_CHANNEL_ACCESS_LABEL_BYTES);
  if (proposedTitle.length === 0) fail(r.at('proposedTitle'), 'empty');
  return { kind, proposedTitle };
}

export function decodeChannelAccessRequesterContext(input: unknown): Decoded<ChannelAccessRequesterContext> {
  return decodeWith(() => {
    const r = object(input, '', [
      'v', 'principal', 'origin', 'sessionGeneration', 'sessionFingerprint', 'harness', 'displayLabel', 'workspaceLabel',
    ]);
    return {
      v: version(r.field('v'), r.at('v')),
      principal: identifier(r.field('principal'), r.at('principal')) as StableAgentPrincipal,
      origin: readCanonicalOrigin(r.field('origin'), r.at('origin')),
      sessionGeneration: safeInteger(r.field('sessionGeneration'), r.at('sessionGeneration')),
      sessionFingerprint: readDigest(r.field('sessionFingerprint'), r.at('sessionFingerprint')),
      harness: identifier(r.field('harness'), r.at('harness')),
      displayLabel: readOptionalDisplayLabel(r.field('displayLabel'), r.at('displayLabel')),
      workspaceLabel: readOptionalDisplayLabel(r.field('workspaceLabel'), r.at('workspaceLabel')),
    };
  });
}

export function decodeChannelAccessOwnerProjection(input: unknown): Decoded<ChannelAccessOwnerProjection> {
  return decodeWith(() => {
    const r = object(input, '', OWNER_PROJECTION_FIELDS);
    const operationKind = literal(r.field('operationKind'), r.at('operationKind'), ['access', 'create']);
    const outcome = literal(r.field('outcome'), r.at('outcome'), CHANNEL_ACCESS_OWNER_OUTCOMES);
    const ownerDecision = literal(r.field('ownerDecision'), r.at('ownerDecision'), ['pending', 'approved', 'denied']);
    const createdAt = utcTimestamp(r.field('createdAt'), r.at('createdAt'));
    const deadline = utcTimestamp(r.field('deadline'), r.at('deadline'));
    const decidedAt = nullable(r.field('decidedAt'), value => utcTimestamp(value, r.at('decidedAt')));
    const muted = r.field('muted');
    if (typeof muted !== 'boolean') fail(r.at('muted'), 'wrong_type');
    const muteRevision = nullable(r.field('muteRevision'), value => identifier(value, r.at('muteRevision')));

    if (Date.parse(deadline) <= Date.parse(createdAt)) fail(r.at('deadline'), 'invalid_value');
    if (decidedAt !== null
      && (Date.parse(decidedAt) < Date.parse(createdAt) || Date.parse(decidedAt) >= Date.parse(deadline))) {
      fail(r.at('decidedAt'), 'invalid_value');
    }
    if ((ownerDecision === 'pending') !== (decidedAt === null)) fail(r.at('decidedAt'), 'mismatch');
    const expectedDecision = outcome === 'pending_owner' ? 'pending'
      : outcome === 'denied' ? 'denied'
        : outcome === 'expired' || outcome === 'revoked' ? null
          : 'approved';
    if (expectedDecision !== null && ownerDecision !== expectedDecision) fail(r.at('ownerDecision'), 'mismatch');
    if (expectedDecision === null && ownerDecision === 'denied') fail(r.at('ownerDecision'), 'mismatch');
    if (muted && muteRevision === null) fail(r.at('muteRevision'), 'mismatch');

    const common = {
      v: version(r.field('v'), r.at('v')),
      requestHandle: readRequestHandle(r.field('requestHandle'), r.at('requestHandle')),
      outcome,
      revision: identifier(r.field('revision'), r.at('revision')),
      requester: readRequesterProjection(r.field('requester'), r.at('requester')),
      createdAt,
      deadline,
      ownerDecision,
      decidedAt,
      muted,
      muteRevision,
    } as const;
    const detail = readDetail(r.field('detail'), r.at('detail'), operationKind);
    return operationKind === 'access'
      ? { ...common, operationKind, detail: detail as Extract<ChannelAccessOwnerProjection, { operationKind: 'access' }>['detail'] }
      : { ...common, operationKind, detail: detail as Extract<ChannelAccessOwnerProjection, { operationKind: 'create' }>['detail'] };
  });
}

export function decodeChannelAccessStatusQuery(input: unknown): Decoded<ChannelAccessStatusQuery> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'operationId', 'operationKind']);
    return {
      v: version(r.field('v'), r.at('v')),
      operationId: identifier(r.field('operationId'), r.at('operationId')),
      operationKind: literal(r.field('operationKind'), r.at('operationKind'), ['access', 'create']),
    };
  });
}

export function decodeChannelAccessDecisionCommand(input: unknown): Decoded<ChannelAccessDecisionCommand> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'requestHandle', 'expectedRevision', 'decision', 'operationId']);
    return {
      v: version(r.field('v'), r.at('v')),
      requestHandle: readRequestHandle(r.field('requestHandle'), r.at('requestHandle')),
      expectedRevision: identifier(r.field('expectedRevision'), r.at('expectedRevision')),
      decision: literal(r.field('decision'), r.at('decision'), ['approve', 'deny']),
      operationId: identifier(r.field('operationId'), r.at('operationId')),
    };
  });
}

export function decodeChannelAccessMuteCommand(input: unknown): Decoded<ChannelAccessMuteCommand> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'requestHandle', 'expectedRevision', 'action', 'operationId']);
    return {
      v: version(r.field('v'), r.at('v')),
      requestHandle: readRequestHandle(r.field('requestHandle'), r.at('requestHandle')),
      expectedRevision: nullable(r.field('expectedRevision'), value => identifier(value, r.at('expectedRevision'))),
      action: literal(r.field('action'), r.at('action'), ['mute', 'unmute']),
      operationId: identifier(r.field('operationId'), r.at('operationId')),
    };
  });
}

export function decodeChannelAccessNotification(input: unknown): Decoded<ChannelAccessNotification> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'notificationId', 'revision', 'ownerId', 'kind', 'requestHandle', 'count']);
    const kind = literal(r.field('kind'), r.at('kind'), ['request', 'batch']);
    const requestHandle = nullable(r.field('requestHandle'), value => readRequestHandle(value, r.at('requestHandle')));
    const count = safeInteger(r.field('count'), r.at('count'));
    if (count < 1 || count > MAX_CHANNEL_ACCESS_OWNER_PENDING) fail(r.at('count'), 'invalid_value');
    if (kind === 'request' && count !== 1) fail(r.at('count'), 'mismatch');
    if ((kind === 'request') !== (requestHandle !== null)) fail(r.at('requestHandle'), 'mismatch');
    const common = {
      v: version(r.field('v'), r.at('v')),
      notificationId: identifier(r.field('notificationId'), r.at('notificationId')),
      revision: identifier(r.field('revision'), r.at('revision')),
      ownerId: readId<'OwnerId'>(r.field('ownerId'), r.at('ownerId')),
      count,
    } as const;
    return kind === 'request'
      ? { ...common, kind, requestHandle: requestHandle as ChannelAccessRequestHandle }
      : { ...common, kind, requestHandle: null };
  });
}

export function decodeChannelAccessFulfillmentClaim(input: unknown): Decoded<ChannelAccessFulfillmentClaim> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'requestHandle', 'expectedRevision', 'operationId']);
    return {
      v: version(r.field('v'), r.at('v')),
      requestHandle: readRequestHandle(r.field('requestHandle'), r.at('requestHandle')),
      expectedRevision: identifier(r.field('expectedRevision'), r.at('expectedRevision')),
      operationId: identifier(r.field('operationId'), r.at('operationId')),
    };
  });
}

export function decodeChannelAccessFulfillmentUpdate(input: unknown): Decoded<ChannelAccessFulfillmentUpdate> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'requestHandle', 'expectedRevision', 'operationId', 'outcome']);
    return {
      v: version(r.field('v'), r.at('v')),
      requestHandle: readRequestHandle(r.field('requestHandle'), r.at('requestHandle')),
      expectedRevision: identifier(r.field('expectedRevision'), r.at('expectedRevision')),
      operationId: identifier(r.field('operationId'), r.at('operationId')),
      outcome: literal(r.field('outcome'), r.at('outcome'), ['connected', 'repair_required', 'revoked']),
    };
  });
}
