// Shared builders for the trust tests. Lives outside `src/` so it is neither built
// into `dist` nor reachable through the package's `./trust/*` export.

import type {
  BindingId, CausalRootId, CommandId, EventRef, OwnerAuthority, OwnerId, ParticipantId, PolicyAck, PolicySetCommand,
  ReleaseId, RoomId, SessionBinding,
} from '@khala/contracts/delivery/index';
import { initialTrustState } from '../../src/trust/transitions';
import type { AutomationAuthority } from '../../src/trust/gate';
import type { PolicyActor, TrustState } from '../../src/trust/types';

export const ROOM = 'room_1' as RoomId;
export const BINDING = 'binding_1' as BindingId;
export const ALICE = 'owner_alice' as OwnerId;
export const MALLORY = 'owner_mallory' as OwnerId;
export const PEER = 'participant_bob_agent' as ParticipantId;
export const OTHER_PEER = 'participant_carol_agent' as ParticipantId;
export const OWN_AGENT = 'participant_alice_agent' as ParticipantId;

export const authority = (ownerId: OwnerId = ALICE): OwnerAuthority => ({
  ownerId,
  issuer: 'https://issuer.example',
  subject: `subject-${ownerId}`,
  authenticatedAt: '2026-09-18T10:00:00Z',
  authorizationId: `auth-${ownerId}` as OwnerAuthority['authorizationId'],
});

export const owner = (ownerId: OwnerId = ALICE): PolicyActor => ({ kind: 'owner', authority: authority(ownerId) });

export const start = (generation = 1, policyVersion = 1): TrustState =>
  initialTrustState({ roomId: ROOM, bindingId: BINDING, ownerId: ALICE, generation, policyVersion });

export function command(overrides: Partial<PolicySetCommand> = {}): PolicySetCommand {
  return {
    v: 1,
    commandId: 'cmd_1' as CommandId,
    roomId: ROOM,
    bindingId: BINDING,
    peerParticipantId: PEER,
    expectedPolicyVersion: 1,
    expectedBindingGeneration: 1,
    mode: 'auto',
    paused: false,
    issuedAt: '2026-09-18T10:00:00Z',
    ...overrides,
  };
}

export function ack(overrides: Partial<PolicyAck> = {}): PolicyAck {
  return {
    v: 1,
    commandId: 'cmd_1' as CommandId,
    bindingId: BINDING,
    generation: 1,
    requestedVersion: 2,
    effectiveVersion: 2,
    connectorState: 'effective',
    errorCode: null,
    ...overrides,
  };
}

export const binding = (generation = 1): SessionBinding => ({
  v: 1,
  bindingId: BINDING,
  ownerId: ALICE,
  agentParticipantId: OWN_AGENT,
  deviceId: 'device_alice' as SessionBinding['deviceId'],
  harness: 'claude',
  sessionId: 'session-1',
  generation,
});

export const event = (id = 'event_1', author: ParticipantId = PEER): EventRef => ({
  v: 1,
  roomId: ROOM,
  eventId: id as EventRef['eventId'],
  authorParticipantId: author,
  authorDeviceId: 'device_bob' as EventRef['authorDeviceId'],
  contentDigest: `sha256:${'a'.repeat(64)}`,
});

export const releaseId = (id = 'release_1') => id as ReleaseId;
export const causalRoot = 'causal_1' as CausalRootId;

/** Example limits that are not approved values, injected the way composition would. */
export const exampleAutomation = (maxCausalDepth = 3): AutomationAuthority => ({
  approvedAutomation: () => ({ maxCausalDepth }),
});
