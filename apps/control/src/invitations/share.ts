import type {
  AdmissionRejection,
  CallOptions,
  OperationResult,
  RoomId,
  ShareGrant,
} from '@khala/contracts/messaging/index';
import { ok, outcomeUnknown, rejected, sameJsonValue, unavailable } from '@khala/contracts/messaging/index';
import type { AdmissionRuntime, ShareInput } from './index';
import { currentPrincipal, safeRead, writeAndResolve } from './internal';
import { type InviteRecord, readInviteRecord, storePolicy } from './policy';

export async function shareInvite(
  runtime: AdmissionRuntime,
  input: ShareInput,
  options?: CallOptions,
): Promise<OperationResult<ShareGrant, AdmissionRejection>> {
  const identity = await currentPrincipal(runtime.identity, options);
  if (identity === 'auth_required') return rejected('auth_required');
  if (identity === 'unavailable') return unavailable();
  const policy = storePolicy(input.policy, runtime.digests);
  if (!policy) return rejected('forbidden');
  let authority: 'allowed' | 'forbidden' | 'unavailable';
  try {
    authority = await runtime.authority.canShare({ principal: identity.principal, roomId: input.roomId }, options);
  } catch {
    return unavailable();
  }
  if (authority === 'forbidden') return rejected('forbidden');
  if (authority === 'unavailable') return unavailable();

  const inviteRef = runtime.digests.token(input.operationId);
  const key = runtime.digests.inviteKey(inviteRef);
  const existing = await safeRead<InviteRecord>(runtime.store, key, options);
  if (existing.kind === 'unavailable') return unavailable();
  if (existing.kind === 'record') {
    const invite = readInviteRecord(existing.record.value);
    if (!invite) return unavailable();
    return sameShare(invite, identity.principal.ownerId, input.roomId, policy, runtime, inviteRef)
      ? ok(grant(runtime, inviteRef, invite.expiresAt))
      : rejected('operation_mismatch');
  }
  const expiresAt = runtime.inviteLifetimeMs === null ? null : new Date(runtime.clock() + runtime.inviteLifetimeMs).toISOString();
  const value: InviteRecord = {
    v: 1,
    roomId: input.roomId,
    creatorOwnerId: identity.principal.ownerId,
    inviteRefDigest: runtime.digests.inviteRef(inviteRef),
    policyRevision: 1,
    policy,
    status: 'active',
    expiresAt,
    lastAuthorizedOperationDigest: null,
  };
  const write = await writeAndResolve(runtime.store, {
    key,
    expectedRevision: null,
    operationId: `invitation.share.${runtime.digests.operation(input.operationId)}`,
    next: { value, expiresAt: null },
  }, options);
  if (write.kind === 'conflict' && write.current) {
    const invite = readInviteRecord(write.current.value);
    return invite && sameShare(invite, identity.principal.ownerId, input.roomId, policy, runtime, inviteRef)
      ? ok(grant(runtime, inviteRef, invite.expiresAt))
      : rejected('operation_mismatch');
  }
  if (write.kind === 'operation_mismatch' || write.kind === 'conflict') return rejected('operation_mismatch');
  if (write.kind === 'unavailable') return unavailable();
  if (write.kind === 'outcome_unknown') return outcomeUnknown(input.operationId);
  const stored = write.record.value;
  if (!sameShare(stored, identity.principal.ownerId, input.roomId, policy, runtime, inviteRef)) return rejected('operation_mismatch');
  return ok(grant(runtime, inviteRef, expiresAt));
}

export async function revokeInvite(
  runtime: AdmissionRuntime,
  input: Readonly<{ operationId: string; inviteRef: string }>,
  options?: CallOptions,
): Promise<OperationResult<null, AdmissionRejection>> {
  const identity = await currentPrincipal(runtime.identity, options);
  if (identity === 'auth_required') return rejected('auth_required');
  if (identity === 'unavailable') return unavailable();
  const key = runtime.digests.inviteKey(input.inviteRef);
  const inviteRefDigest = runtime.digests.inviteRef(input.inviteRef);
  const operationDigest = runtime.digests.operation(input.operationId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const read = await runtime.store.read(key, options).catch(() => ({ kind: 'unavailable' as const }));
    if (read.kind === 'unavailable') return unavailable();
    if (read.kind === 'absent') return rejected('revoked');
    const invite = readInviteRecord(read.record.value);
    if (!invite || invite.inviteRefDigest !== inviteRefDigest) return unavailable();
    if (invite.creatorOwnerId !== identity.principal.ownerId) return rejected('forbidden');
    if (invite.expiresAt !== null && runtime.clock() >= Date.parse(invite.expiresAt)) return rejected('expired');
    if (invite.status === 'revoked') return ok(null);
    const write = await writeAndResolve(runtime.store, {
      key,
      expectedRevision: read.record.revision,
      operationId: `invitation.revoke.${operationDigest}`,
      next: {
        value: { ...invite, status: 'revoked' as const, lastAuthorizedOperationDigest: null },
        expiresAt: null,
      },
    }, options);
    if (write.kind === 'applied') return ok(null);
    if (write.kind === 'operation_mismatch') return rejected('operation_mismatch');
    if (write.kind === 'unavailable') return unavailable();
    if (write.kind === 'outcome_unknown') return outcomeUnknown(input.operationId);
  }
  return unavailable();
}

function grant(runtime: AdmissionRuntime, inviteRef: string, expiresAt: string | null): ShareGrant {
  return { inviteRef, shareUrl: new URL(`/join/${encodeURIComponent(inviteRef)}`, runtime.origin).href, expiresAt };
}

function sameShare(
  invite: InviteRecord,
  creatorOwnerId: string,
  roomId: RoomId,
  policy: InviteRecord['policy'],
  runtime: AdmissionRuntime,
  inviteRef: string,
): boolean {
  return invite.creatorOwnerId === creatorOwnerId && invite.roomId === roomId
    && invite.inviteRefDigest === runtime.digests.inviteRef(inviteRef)
    && sameJsonValue(invite.policy, policy);
}
