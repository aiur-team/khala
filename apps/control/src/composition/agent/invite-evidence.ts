import { createHash } from 'node:crypto';
import type { AuthPrincipal, ControlStore } from '@khala/contracts/messaging/index';
import type { InviteEvidence } from '../../agent-bootstrap/handler';
import { createDigests } from '../../invitations/internal';
import { policyAllows, readInviteRecord } from '../../invitations/policy';

/**
 * The owner's consent captures the exact active invitation version and policy.
 * A later redemption must compare this evidence to the current record before
 * adding an agent: the link alone cannot broaden a named-email or revoked grant.
 */
export function createInviteEvidenceReader(input: Readonly<{
  store: ControlStore;
  secret: string;
  clock: () => number;
}>) {
  const digests = createDigests(input.secret);
  return async (principal: AuthPrincipal, inviteRef: string): Promise<InviteEvidence | null> => {
    const read = await input.store.read(digests.inviteKey(inviteRef));
    if (read.kind !== 'record') return null;
    const invite = readInviteRecord(read.record.value);
    if (!invite || invite.inviteRefDigest !== digests.inviteRef(inviteRef)
      || invite.status !== 'active'
      || invite.expiresAt !== null && input.clock() >= Date.parse(invite.expiresAt)
      || !policyAllows(invite.policy, principal, digests)) return null;
    return {
      roomId: invite.roomId,
      revision: read.record.revision,
      policyDigest: createHash('sha256').update(JSON.stringify(invite.policy)).digest('base64url'),
    };
  };
}

/** Recheck the same owner and link version before any Matrix admission side effect. */
export async function matchesInviteEvidence(input: Readonly<{
  store: ControlStore;
  secret: string;
  clock: () => number;
  principal: AuthPrincipal;
  inviteRef: string;
  expected: InviteEvidence;
}>): Promise<boolean> {
  const current = await createInviteEvidenceReader(input)(input.principal, input.inviteRef);
  return current !== null
    && current.roomId === input.expected.roomId
    && current.revision === input.expected.revision
    && current.policyDigest === input.expected.policyDigest;
}
