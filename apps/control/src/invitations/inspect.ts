import type { CallOptions, InviteState } from '@khala/contracts/messaging/index';
import type { AdmissionRuntime } from './index';
import { currentPrincipal, safeRead } from './internal';
import { policyAllows, readInviteRecord } from './policy';

export async function inspectInvite(runtime: AdmissionRuntime, inviteRef: string, options?: CallOptions): Promise<InviteState> {
  const identity = await currentPrincipal(runtime.identity, options);
  if (identity === 'auth_required') return 'auth_required';
  if (identity === 'unavailable') return 'unavailable';
  const stored = await safeRead(runtime.store, runtime.digests.inviteKey(inviteRef), options);
  if (stored.kind === 'unavailable') return 'unavailable';
  if (stored.kind === 'absent') return 'revoked';
  const invite = readInviteRecord(stored.record.value);
  if (!invite || invite.inviteRefDigest !== runtime.digests.inviteRef(inviteRef)) return 'unavailable';
  if (invite.expiresAt !== null && runtime.clock() >= Date.parse(invite.expiresAt)) return 'expired';
  if (invite.status === 'revoked') return 'revoked';
  if (!policyAllows(invite.policy, identity.principal, runtime.digests)) return 'identity_mismatch';
  try {
    const membership = await runtime.gateway.inspectMembership({
      roomId: invite.roomId,
      principal: identity.principal,
      history: invite.policy.history,
    }, options);
    if (membership.kind === 'unavailable') return 'unavailable';
    if (membership.kind === 'absent') return 'eligible';
    return invite.policy.history === 'none' || membership.historyReady ? 'already_joined' : 'eligible';
  } catch {
    return 'unavailable';
  }
}
