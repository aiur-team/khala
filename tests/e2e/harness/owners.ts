// Independent owner fixtures. Each owner is a human, their trusted connector device,
// their agent participant and one existing session binding. Identifiers follow the
// KHA-105/106 fixture scalars (`owner-b`, `agent-b`, `dev-b`, `bind-b-1`), and every
// product control is passed in explicitly: there are no policy defaults here.

import {
  type AuthorizationId, type OwnerAuthority, type OwnerId, type ParticipantId, type SessionBinding,
  decodeAuthorizationId, decodeOwnerId, decodeParticipantId, decodeSessionBinding,
} from '@khala/contracts/delivery/index';

export type OwnerProfile = Readonly<{ email: string; displayName: string }>;

/** Scenario-chosen controls. Every field is required so no product default leaks in. */
export type OwnerControls = Readonly<{
  harness: string;
  sessionId: string;
  generation: number;
  policyVersion: number;
  /** Unverified metadata; duplicates across owners are allowed and must not merge them. */
  profile: OwnerProfile;
}>;

export type OwnerFixture = Readonly<{
  seed: string;
  ownerId: OwnerId;
  humanParticipantId: ParticipantId;
  agentParticipantId: ParticipantId;
  deviceId: SessionBinding['deviceId'];
  binding: SessionBinding;
  policyVersion: number;
  profile: OwnerProfile;
}>;

const SEED = /^[a-z][a-z0-9]{0,15}$/;

function decoded<T>(result: { ok: true; value: T } | { ok: false; field: string }, what: string): T {
  if (!result.ok) throw new TypeError(`owner fixture ${what} is not a valid contract value (${result.field || 'root'})`);
  return result.value;
}

export function createOwnerFixture(seed: string, controls: OwnerControls): OwnerFixture {
  if (!SEED.test(seed)) throw new TypeError(`owner seed must match ${SEED}`);
  if (!Number.isSafeInteger(controls.policyVersion) || controls.policyVersion < 0) {
    throw new TypeError('policyVersion must be a non-negative safe integer');
  }
  const binding = decoded(decodeSessionBinding({
    v: 1,
    bindingId: `bind-${seed}-1`,
    ownerId: `owner-${seed}`,
    agentParticipantId: `agent-${seed}`,
    deviceId: `dev-${seed}`,
    harness: controls.harness,
    sessionId: controls.sessionId,
    generation: controls.generation,
  }), 'binding');
  return Object.freeze({
    seed,
    ownerId: decoded(decodeOwnerId(`owner-${seed}`), 'ownerId'),
    humanParticipantId: decoded(decodeParticipantId(`human-${seed}`), 'humanParticipantId'),
    agentParticipantId: binding.agentParticipantId,
    deviceId: binding.deviceId,
    binding,
    policyVersion: controls.policyVersion,
    profile: Object.freeze({ ...controls.profile }),
  });
}

/** A binding for the same owner after revoke/re-arm: same identity, next generation. */
export function nextGeneration(owner: OwnerFixture): OwnerFixture {
  return Object.freeze({ ...owner, binding: Object.freeze({ ...owner.binding, generation: owner.binding.generation + 1 }) });
}

export class ConflatedOwners extends Error {
  constructor(field: string, value: string) {
    super(`owners share ${field} ${value}; independent owners need distinct identities`);
    this.name = 'ConflatedOwners';
  }
}

/**
 * Refuses owner sets that share any verified identity: owner, human, agent, device,
 * binding or session. Email and display name are deliberately not compared.
 */
export function assertIndependentOwners(owners: readonly OwnerFixture[]): void {
  const seen = new Map<string, string>();
  for (const owner of owners) {
    const identities: [string, string][] = [
      ['ownerId', owner.ownerId],
      ['participant', owner.humanParticipantId],
      ['participant', owner.agentParticipantId],
      ['deviceId', owner.deviceId],
      ['bindingId', owner.binding.bindingId],
      ['session', `${owner.binding.harness}/${owner.binding.sessionId}`],
    ];
    if (owner.binding.ownerId !== owner.ownerId) throw new ConflatedOwners('binding owner', owner.binding.ownerId);
    for (const [field, value] of identities) {
      const key = `${field}:${value}`;
      if (seen.has(key)) throw new ConflatedOwners(field, value);
      seen.set(key, owner.seed);
    }
  }
}

/**
 * Trusted-composition authority for one owner. Only the harness builds this; there
 * is intentionally no way to derive it from a request body.
 */
export function ownerAuthority(
  owner: OwnerFixture,
  grant: Readonly<{ authorizationId: string; authenticatedAt: string }>,
): OwnerAuthority {
  const authorizationId: AuthorizationId = decoded(decodeAuthorizationId(grant.authorizationId), 'authorizationId');
  return Object.freeze({
    ownerId: owner.ownerId,
    issuer: 'khala-e2e-fixture',
    subject: owner.humanParticipantId,
    authenticatedAt: grant.authenticatedAt,
    authorizationId,
  });
}
