import { createHash } from 'node:crypto';
import { sameJsonValue, type JsonValue } from '@khala/contracts/messaging/index';
import type { ChannelAdmissionProviderPort, ChannelAdmissionRequest } from '@khala/messaging/channel-access/exchange/ports';
import { pairingInviteRef, type SessionRef } from '../../agent-bootstrap/handler';
import { createMatrixAgentAdmission } from './matrix-admission';
import { readHostedAccessTarget } from '../human/hosted-channel-access-resolver';
import type { ProductionHumanDependencies, ProductionHumanRuntime } from '../human/production';

/** Rechecks the persisted owner/key/session approval, including its revision. */
export type HostedAdmissionAuthority = Readonly<{
  current(input: ChannelAdmissionRequest): Promise<'current' | 'revoked' | 'unavailable'>;
}>;

/** The requester is the approved proof-key principal, never a claimed provider thread ID. */
function sessionFor(input: ChannelAdmissionRequest): SessionRef | null {
  if (!/^agent_[A-Za-z0-9_-]{43}$/u.test(input.requester)) return null;
  return { harness: 'proof-key', sessionId: input.requester, generation: input.sessionGeneration };
}

function claim(input: ChannelAdmissionRequest, roomId: string) {
  const key = `hosted-channel-admission.v1.${createHash('sha256').update(input.providerOperationId).digest('base64url')}`;
  const value = { v: 1, ownerId: input.ownerId, roomId, requester: input.requester,
    sessionGeneration: input.sessionGeneration, sessionFingerprint: input.sessionFingerprint,
    deviceId: input.deviceId };
  return { key, value };
}

/** Bind a provider operation to one immutable admission before any Matrix effect. */
async function claimed(active: ProductionHumanRuntime, input: ChannelAdmissionRequest, roomId: string): Promise<boolean> {
  const { key, value } = claim(input, roomId);
  const write = await active.store.compareAndSet<JsonValue>({ key, expectedRevision: null,
    operationId: `hosted-admission:${input.providerOperationId}`,
    next: { value, expiresAt: null } });
  if (write.kind === 'applied') return true;
  if (write.kind === 'conflict' && write.current !== null) {
    return sameJsonValue(write.current.value, value);
  }
  return false;
}

export function createHostedChannelAdmissionProvider(
  active: ProductionHumanRuntime,
  dependencies: ProductionHumanDependencies,
  authority: HostedAdmissionAuthority,
): ChannelAdmissionProviderPort {
  const matrix = createMatrixAgentAdmission({
    homeserverOrigin: active.env.publicHomeserverOrigin,
    serverName: active.env.matrixServerName,
    registrationSharedSecret: active.env.matrixRegistrationSharedSecret,
    passwordDerivationSecret: active.env.matrixPasswordDerivationSecret,
    invitationHmacSecret: active.env.invitationHmacSecret,
    ...(active.env.matrixRegistrationIngressToken ? { registrationIngressToken: active.env.matrixRegistrationIngressToken } : {}),
    store: active.store, clock: active.clock,
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
  });

  async function inspect(input: ChannelAdmissionRequest) {
    const session = sessionFor(input);
    if (session === null || input.history !== 'none') return null;
    const target = await readHostedAccessTarget(active, input.channelRef);
    return target === 'unavailable' ? 'unavailable'
      : target !== null && target.ownerId === input.ownerId ? { target, session } : null;
  }

  const admit: ChannelAdmissionProviderPort['admit'] = async input => {
    const current = await inspect(input);
    if (current === 'unavailable') return { kind: 'unavailable' };
    if (current === null) return { kind: 'rejected' };
    if (!await claimed(active, input, current.target.roomId)) return { kind: 'unavailable' };
    const inviteRef = pairingInviteRef(current.target.roomId);
    const before = await matrix.agents.inspect({ ownerId: input.ownerId, inviteRef, session: current.session });
    if (before.kind !== 'ok' || before.value.roomId !== current.target.roomId) return { kind: 'unavailable' };
    const approval = await authority.current(input);
    if (approval !== 'current') return { kind: approval === 'revoked' ? 'rejected' : 'unavailable' };
    const result = await matrix.agents.admit({ ownerId: input.ownerId, inviteRef,
      session: current.session, deviceId: input.deviceId, operationId: input.providerOperationId,
      expectedAgentParticipantId: before.value.agentParticipantId, expectedRoomId: current.target.roomId });
    if (result.kind === 'ok') return { kind: 'admitted', membership: 'joined' };
    if (result.kind === 'outcome_unknown') return { kind: 'outcome_unknown' };
    return result.kind === 'rejected' ? { kind: 'rejected' } : { kind: 'unavailable' };
  };
  return {
    admit,
    async reconcile(input) {
      const current = await inspect(input);
      if (current === 'unavailable') return { kind: 'unavailable' };
      if (current === null) return { kind: 'rejected' };
      const expected = claim(input, current.target.roomId);
      const read = await active.store.read<JsonValue>(expected.key);
      if (read.kind === 'absent') return { kind: 'not_applied' };
      if (read.kind !== 'record' || !sameJsonValue(read.record.value, expected.value)) return { kind: 'unavailable' };
      const approval = await authority.current(input);
      if (approval !== 'current') return { kind: approval === 'revoked' ? 'rejected' : 'unavailable' };
      const membership = await matrix.inspectAgentRoomMembership(input.ownerId, current.session, current.target.roomId);
      return membership === 'joined' ? { kind: 'admitted', membership: 'already_joined' }
        : membership === 'absent' ? admit(input) : { kind: 'unavailable' };
    },
  };
}
