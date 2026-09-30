import type { AdmissionRejection, CallOptions, OperationResult, RoomId, ShareGrant } from '@khala/contracts/messaging/index';
import type { AdmissionRuntime } from './index';
import { currentPrincipal, safeRead, writeAndResolve } from './internal';
import { readInviteRecord } from './policy';
import { shareInvite } from './share';

type Pointer = Readonly<{ v: 1; generation: number }>;

/** One active personal link per authenticated owner and room; CAS serializes rotation. */
export async function personalLink(
  runtime: AdmissionRuntime, roomId: RoomId, options?: CallOptions,
): Promise<OperationResult<ShareGrant, AdmissionRejection>> {
  const identity = await currentPrincipal(runtime.identity, options);
  if (identity === 'auth_required') return { kind: 'rejected', code: 'auth_required' };
  if (identity === 'unavailable') return { kind: 'unavailable', retryable: true };
  const ownerId = identity.principal.ownerId;
  const pointerKey = runtime.digests.personalKey(ownerId, roomId);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const pointerRead = await safeRead<Pointer>(runtime.store, pointerKey, options);
    if (pointerRead.kind === 'unavailable') return { kind: 'unavailable', retryable: true };
    if (pointerRead.kind === 'absent') {
      const created = await writeAndResolve(runtime.store, {
        key: pointerKey, expectedRevision: null, operationId: pointerOperation(runtime, pointerKey, 0),
        next: { value: { v: 1, generation: 0 }, expiresAt: null },
      }, options);
      if (created.kind === 'unavailable') return { kind: 'unavailable', retryable: true };
      if (created.kind === 'outcome_unknown') return { kind: 'outcome_unknown', operationId: created.operationId };
      if (created.kind === 'operation_mismatch') return { kind: 'rejected', code: 'operation_mismatch' };
      continue;
    }
    const pointer = readPointer(pointerRead.record.value);
    if (!pointer) return { kind: 'unavailable', retryable: true };
    const operationId = runtime.digests.personal(ownerId, roomId, pointer.generation);
    const inviteRef = runtime.digests.token(operationId);
    const inviteRead = await safeRead(runtime.store, runtime.digests.inviteKey(inviteRef), options);
    if (inviteRead.kind === 'unavailable') return { kind: 'unavailable', retryable: true };
    if (inviteRead.kind === 'record') {
      const invite = readInviteRecord(inviteRead.record.value);
      if (!invite || invite.creatorOwnerId !== ownerId || invite.roomId !== roomId
        || invite.inviteRefDigest !== runtime.digests.inviteRef(inviteRef)) return { kind: 'unavailable', retryable: true };
      if (invite.status === 'revoked' || invite.expiresAt !== null && runtime.clock() >= Date.parse(invite.expiresAt)) {
        const next = pointer.generation + 1;
        if (!Number.isSafeInteger(next)) return { kind: 'unavailable', retryable: true };
        const rotated = await writeAndResolve(runtime.store, {
          key: pointerKey, expectedRevision: pointerRead.record.revision,
          operationId: pointerOperation(runtime, pointerKey, next),
          next: { value: { v: 1, generation: next }, expiresAt: null },
        }, options);
        if (rotated.kind === 'unavailable') return { kind: 'unavailable', retryable: true };
        if (rotated.kind === 'outcome_unknown') return { kind: 'outcome_unknown', operationId: rotated.operationId };
        if (rotated.kind === 'operation_mismatch') return { kind: 'rejected', code: 'operation_mismatch' };
        continue;
      }
    }
    const shared = await shareInvite(runtime, { operationId, roomId }, options, ownerId);
    if (shared.kind !== 'ok') return shared;
    // A revoke or expiry may have raced the share. Loop through the pointer
    // rather than returning a link already known to be unusable.
    const current = await safeRead(runtime.store, runtime.digests.inviteKey(shared.value.inviteRef), options);
    if (current.kind !== 'record') return { kind: 'unavailable', retryable: true };
    const invite = readInviteRecord(current.record.value);
    if (!invite || invite.creatorOwnerId !== ownerId || invite.roomId !== roomId) return { kind: 'unavailable', retryable: true };
    if (invite.status === 'revoked' || invite.expiresAt !== null && runtime.clock() >= Date.parse(invite.expiresAt)) continue;
    return shared;
  }
  return { kind: 'unavailable', retryable: true };
}

function readPointer(value: unknown): Pointer | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return record.v === 1 && Number.isSafeInteger(record.generation) && typeof record.generation === 'number'
    && record.generation >= 0 ? { v: 1, generation: record.generation } : null;
}

function pointerOperation(runtime: AdmissionRuntime, key: string, generation: number): string {
  return `personal.pointer.${runtime.digests.operation(`${key}\0${generation}`)}`;
}
