import {
  type Decoded, decodeWith, fail, identifier, literal, nullable, object, safeInteger, utcTimestamp, version,
} from './decode';
import { type BindingId, type CommandId, readId } from './ids';

export const LISTENING_MODES = ['steer', 'sync', 'async'] as const;
export const MODE_SUPPORT_STATUSES = [
  'proven', 'experimental', 'blocked_without_wrapper', 'unsupported', 'unknown',
] as const;
export const ACKNOWLEDGEMENT_SUPPORT = ['unknown', 'unsupported', 'batch_token_next_call'] as const;
export const OWNER_ROUTE_GRANT_COMMAND_KINDS = [
  'grant_experimental_route', 'revoke_experimental_route', 'grant_hard_cancel', 'revoke_hard_cancel',
] as const;
export const LISTENING_MODE_RESULT_OUTCOMES = ['applied', 'conflict', 'refused'] as const;

export type ListeningMode = (typeof LISTENING_MODES)[number];
export type AcknowledgementSupport = (typeof ACKNOWLEDGEMENT_SUPPORT)[number];

type EvidencedModeSupport = Readonly<{
  status: 'proven' | 'experimental';
  route: string;
  testedVersion: string;
  evidenceRef: string;
  evidenceRevision: string;
  reason: string | null;
}>;

type WrapperBlockedModeSupport = Readonly<{
  status: 'blocked_without_wrapper';
  route: string;
  testedVersion: string;
  evidenceRef: string;
  evidenceRevision: string;
  reason: string;
}>;

type ClosedModeSupport = Readonly<{
  status: 'unsupported' | 'unknown';
  route: string;
  testedVersion?: string;
  evidenceRef: string | null;
  evidenceRevision: string | null;
  reason: string;
}>;

export type ModeSupport = EvidencedModeSupport | WrapperBlockedModeSupport | ClosedModeSupport;
export type ModeSupportMap = Readonly<Record<ListeningMode, ModeSupport>>;

export type ListeningModeCommand = Readonly<{
  v: 1;
  commandId: CommandId;
  bindingId: BindingId;
  expectedBindingGeneration: number;
  expectedVersion: number;
  requested: ListeningMode;
  issuedAt: string;
}>;

export type ListeningModeResult = Readonly<{
  v: 1;
  commandId: CommandId;
  bindingId: BindingId;
  generation: number;
  outcome: (typeof LISTENING_MODE_RESULT_OUTCOMES)[number];
  version: number;
  requested: ListeningMode;
  effective: ListeningMode | null;
  reason: string | null;
}>;

export type OwnerRouteGrantCommand = Readonly<{
  v: 1;
  kind: (typeof OWNER_ROUTE_GRANT_COMMAND_KINDS)[number];
  commandId: CommandId;
  bindingId: BindingId;
  expectedBindingGeneration: number;
  expectedVersion: number;
  route: string;
  harnessVersion: string;
  evidenceRevision: string;
  issuedAt: string;
}>;

export type RouteGrant = Readonly<{
  v: 1;
  kind: 'experimental_route' | 'hard_cancel';
  bindingId: BindingId;
  generation: number;
  mode: ListeningMode;
  route: string;
  harnessVersion: string;
  evidenceRevision: string;
  grantRevision: number;
}>;

const join = (field: string, key: string) => field.length === 0 ? key : `${field}.${key}`;

function requiredReason(input: unknown, field: string): string {
  const reason = identifier(input, field);
  if (reason.trim().length === 0) fail(field, 'invalid_field');
  return reason;
}

export function decodeListeningMode(input: unknown): Decoded<ListeningMode> {
  return decodeWith(() => literal(input, '', LISTENING_MODES));
}

export function readModeSupport(input: unknown, field: string): ModeSupport {
  const raw = input as Record<string, unknown> | null;
  const status = literal(raw?.status, join(field, 'status'), MODE_SUPPORT_STATUSES);
  const hasTestedVersion = raw !== null && Object.hasOwn(raw, 'testedVersion');
  const fields = [
    'status', 'route', ...(hasTestedVersion ? ['testedVersion'] : []), 'evidenceRef', 'evidenceRevision', 'reason',
  ];
  const r = object(input, field, fields);
  const route = identifier(r.field('route'), r.at('route'));

  if (status === 'blocked_without_wrapper') {
    if (!hasTestedVersion) fail(r.at('testedVersion'), 'invalid_field');
    return {
      status,
      route,
      testedVersion: identifier(r.field('testedVersion'), r.at('testedVersion')),
      evidenceRef: identifier(r.field('evidenceRef'), r.at('evidenceRef')),
      evidenceRevision: identifier(r.field('evidenceRevision'), r.at('evidenceRevision')),
      reason: requiredReason(r.field('reason'), r.at('reason')),
    };
  }

  if (status === 'proven' || status === 'experimental') {
    if (!hasTestedVersion) fail(r.at('testedVersion'), 'invalid_field');
    return {
      status,
      route,
      testedVersion: identifier(r.field('testedVersion'), r.at('testedVersion')),
      evidenceRef: identifier(r.field('evidenceRef'), r.at('evidenceRef')),
      evidenceRevision: identifier(r.field('evidenceRevision'), r.at('evidenceRevision')),
      reason: nullable(r.field('reason'), value => requiredReason(value, r.at('reason'))),
    };
  }

  const evidenceRef = nullable(r.field('evidenceRef'), value => identifier(value, r.at('evidenceRef')));
  const evidenceRevision = nullable(r.field('evidenceRevision'), value => identifier(value, r.at('evidenceRevision')));
  if ((evidenceRef === null) !== (evidenceRevision === null)) fail(r.at('evidenceRevision'), 'invalid_field');
  return {
    status,
    route,
    ...(hasTestedVersion ? { testedVersion: identifier(r.field('testedVersion'), r.at('testedVersion')) } : {}),
    evidenceRef,
    evidenceRevision,
    reason: requiredReason(r.field('reason'), r.at('reason')),
  };
}

export function decodeModeSupport(input: unknown): Decoded<ModeSupport> {
  return decodeWith(() => readModeSupport(input, ''));
}

export function readModeSupportMap(input: unknown, field: string): ModeSupportMap {
  const r = object(input, field, LISTENING_MODES);
  return {
    steer: readModeSupport(r.field('steer'), r.at('steer')),
    sync: readModeSupport(r.field('sync'), r.at('sync')),
    async: readModeSupport(r.field('async'), r.at('async')),
  };
}

export function decodeModeSupportMap(input: unknown): Decoded<ModeSupportMap> {
  return decodeWith(() => readModeSupportMap(input, ''));
}

export function unknownModeSupport(route: string, reason: string, testedVersion?: string): ModeSupport {
  return {
    status: 'unknown',
    route,
    ...(testedVersion === undefined ? {} : { testedVersion }),
    evidenceRef: null,
    evidenceRevision: null,
    reason,
  };
}

export function unknownModeSupportMap(routePrefix: string, reason: string, testedVersion?: string): ModeSupportMap {
  return {
    steer: unknownModeSupport(`${routePrefix}-steer`, reason, testedVersion),
    sync: unknownModeSupport(`${routePrefix}-sync`, reason, testedVersion),
    async: unknownModeSupport(`${routePrefix}-async`, reason, testedVersion),
  };
}

export function initialListeningMode(modes: ModeSupportMap): Readonly<{ requested: ListeningMode; reason: string | null }> {
  const sync = modes.sync;
  const asyncSupport = modes.async;
  const exactNegative = sync.status === 'unsupported'
    && sync.testedVersion !== undefined
    && sync.evidenceRef !== null
    && sync.evidenceRevision !== null;
  if (exactNegative && asyncSupport.status === 'proven') return { requested: 'async', reason: sync.reason };
  return { requested: 'sync', reason: null };
}

export function routeGrantMatches(
  grant: RouteGrant,
  input: Readonly<{
    bindingId: BindingId;
    generation: number;
    grantRevision: number;
    mode: ListeningMode;
    support: ModeSupport;
  }>,
): boolean {
  const { support } = input;
  if (support.status !== 'proven' && support.status !== 'experimental') return false;
  return grant.kind === 'experimental_route'
    && grant.bindingId === input.bindingId
    && grant.generation === input.generation
    && grant.grantRevision === input.grantRevision
    && grant.mode === input.mode
    && grant.route === support.route
    && grant.harnessVersion === support.testedVersion
    && grant.evidenceRevision === support.evidenceRevision;
}

export function decodeListeningModeCommand(input: unknown): Decoded<ListeningModeCommand> {
  return decodeWith(() => {
    const r = object(input, '', [
      'v', 'commandId', 'bindingId', 'expectedBindingGeneration', 'expectedVersion', 'requested', 'issuedAt',
    ]);
    return {
      v: version(r.field('v'), r.at('v')),
      commandId: readId<'CommandId'>(r.field('commandId'), r.at('commandId')),
      bindingId: readId<'BindingId'>(r.field('bindingId'), r.at('bindingId')),
      expectedBindingGeneration: safeInteger(r.field('expectedBindingGeneration'), r.at('expectedBindingGeneration')),
      expectedVersion: safeInteger(r.field('expectedVersion'), r.at('expectedVersion')),
      requested: literal(r.field('requested'), r.at('requested'), LISTENING_MODES),
      issuedAt: utcTimestamp(r.field('issuedAt'), r.at('issuedAt')),
    };
  });
}

export function decodeListeningModeResult(input: unknown): Decoded<ListeningModeResult> {
  return decodeWith(() => {
    const r = object(input, '', [
      'v', 'commandId', 'bindingId', 'generation', 'outcome', 'version', 'requested', 'effective', 'reason',
    ]);
    return {
      v: version(r.field('v'), r.at('v')),
      commandId: readId<'CommandId'>(r.field('commandId'), r.at('commandId')),
      bindingId: readId<'BindingId'>(r.field('bindingId'), r.at('bindingId')),
      generation: safeInteger(r.field('generation'), r.at('generation')),
      outcome: literal(r.field('outcome'), r.at('outcome'), LISTENING_MODE_RESULT_OUTCOMES),
      version: safeInteger(r.field('version'), r.at('version')),
      requested: literal(r.field('requested'), r.at('requested'), LISTENING_MODES),
      effective: nullable(r.field('effective'), value => literal(value, r.at('effective'), LISTENING_MODES)),
      reason: nullable(r.field('reason'), value => requiredReason(value, r.at('reason'))),
    };
  });
}

export function decodeOwnerRouteGrantCommand(input: unknown): Decoded<OwnerRouteGrantCommand> {
  return decodeWith(() => {
    const r = object(input, '', [
      'v', 'kind', 'commandId', 'bindingId', 'expectedBindingGeneration', 'expectedVersion',
      'route', 'harnessVersion', 'evidenceRevision', 'issuedAt',
    ]);
    return {
      v: version(r.field('v'), r.at('v')),
      kind: literal(r.field('kind'), r.at('kind'), OWNER_ROUTE_GRANT_COMMAND_KINDS),
      commandId: readId<'CommandId'>(r.field('commandId'), r.at('commandId')),
      bindingId: readId<'BindingId'>(r.field('bindingId'), r.at('bindingId')),
      expectedBindingGeneration: safeInteger(r.field('expectedBindingGeneration'), r.at('expectedBindingGeneration')),
      expectedVersion: safeInteger(r.field('expectedVersion'), r.at('expectedVersion')),
      route: identifier(r.field('route'), r.at('route')),
      harnessVersion: identifier(r.field('harnessVersion'), r.at('harnessVersion')),
      evidenceRevision: identifier(r.field('evidenceRevision'), r.at('evidenceRevision')),
      issuedAt: utcTimestamp(r.field('issuedAt'), r.at('issuedAt')),
    };
  });
}
