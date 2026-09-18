import type {
  Admission,
  AdmissionRejection,
  AuthPrincipal,
  CallOptions,
  DeviceId,
  OperationResult,
  RoomSummary,
} from '@khala/contracts/messaging/index';
import { ok, outcomeUnknown, rejected, unavailable } from '@khala/contracts/messaging/index';
import type { AdmissionRuntime } from './index';
import { type AdmissionBinding, type JournalEntry, createAdmissionJournal } from './journal';
import { currentPrincipal, safeRead, writeAndResolve } from './internal';
import { policyAllows, readInviteRecord, type AdmissionHistory, type InviteRecord } from './policy';

type AdmitInput = Readonly<{ operationId: string; inviteRef: string; deviceId: DeviceId }>;

export async function admitInvite(
  runtime: AdmissionRuntime,
  input: AdmitInput,
  options?: CallOptions,
): Promise<OperationResult<Admission, AdmissionRejection>> {
  const identity = await currentPrincipal(runtime.identity, options);
  if (identity === 'auth_required') return rejected('auth_required');
  if (identity === 'unavailable') return unavailable();
  const journal = createAdmissionJournal(runtime.store, runtime.digests);
  const existing = await journal.read(input.operationId, options);
  if (existing === 'unavailable') return unavailable();
  if (existing !== 'absent') {
    if (!sameRequest(existing, input, identity.principal.ownerId, runtime)) return rejected('operation_mismatch');
    if (existing.record.state === 'joined') return ok({ outcome: 'already_joined', room: existing.record.room as RoomSummary });
    return resumeAdmission(runtime, journal, input, existing, identity.principal, options, true);
  }

  const authorized = await authorizeInvite(runtime, input, identity.principal, options);
  if ('kind' in authorized) return authorized.result;
  const binding: AdmissionBinding = {
    inviteRefDigest: runtime.digests.inviteRef(input.inviteRef),
    inviteRevision: authorized.revision,
    policyRevision: 1,
    roomId: authorized.invite.roomId,
    ownerId: identity.principal.ownerId,
    deviceId: input.deviceId,
    history: authorized.invite.policy.history,
  };
  const claimed = await journal.claim(input.operationId, binding, options);
  if (claimed === 'operation_mismatch') return rejected('operation_mismatch');
  if (claimed === 'unavailable') return unavailable();
  if (claimed === 'outcome_unknown') return outcomeUnknown(input.operationId);
  if (claimed.record.state === 'joined') return ok({ outcome: 'already_joined', room: claimed.record.room as RoomSummary });
  return resumeAdmission(runtime, journal, input, claimed, identity.principal, options, false);
}

type AuthorizationFailure = Readonly<{ kind: 'failure'; result: OperationResult<never, AdmissionRejection> }>;

async function authorizeInvite(
  runtime: AdmissionRuntime,
  input: AdmitInput,
  principal: AuthPrincipal,
  options?: CallOptions,
): Promise<Readonly<{ invite: InviteRecord; revision: string }> | AuthorizationFailure> {
  const operationDigest = runtime.digests.operation(input.operationId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const eligible = await readEligibleInvite(runtime, input, principal, options);
    if ('kind' in eligible) return eligible;
    const { invite, revision } = eligible;
    const next: InviteRecord = { ...invite, lastAuthorizedOperationDigest: operationDigest };
    const write = await writeAndResolve(runtime.store, {
      key: runtime.digests.inviteKey(input.inviteRef),
      expectedRevision: revision,
      operationId: `invitation.authorize.${operationDigest}`,
      next: { value: next, expiresAt: null },
    }, options);
    if (write.kind === 'applied') return { invite: write.record.value, revision: write.record.revision };
    if (write.kind === 'operation_mismatch') return { kind: 'failure', result: rejected('operation_mismatch') };
    if (write.kind === 'unavailable') return { kind: 'failure', result: unavailable() };
    if (write.kind === 'outcome_unknown') return { kind: 'failure', result: outcomeUnknown(input.operationId) };
  }
  return { kind: 'failure', result: unavailable() };
}

async function readEligibleInvite(
  runtime: AdmissionRuntime,
  input: AdmitInput,
  principal: AuthPrincipal,
  options?: CallOptions,
): Promise<Readonly<{ invite: InviteRecord; revision: string }> | AuthorizationFailure> {
  const read = await safeRead<InviteRecord>(runtime.store, runtime.digests.inviteKey(input.inviteRef), options);
  if (read.kind === 'unavailable') return { kind: 'failure', result: unavailable() };
  if (read.kind === 'absent') return { kind: 'failure', result: rejected('revoked') };
  const invite = readInviteRecord(read.record.value);
  if (!invite || invite.inviteRefDigest !== runtime.digests.inviteRef(input.inviteRef)) {
    return { kind: 'failure', result: unavailable() };
  }
  if (invite.expiresAt !== null && runtime.clock() >= Date.parse(invite.expiresAt)) {
    return { kind: 'failure', result: rejected('expired') };
  }
  if (invite.status === 'revoked') return { kind: 'failure', result: rejected('revoked') };
  if (!policyAllows(invite.policy, principal, runtime.digests)) {
    return { kind: 'failure', result: rejected('identity_mismatch') };
  }
  return { invite, revision: read.record.revision };
}

async function resumeAdmission(
  runtime: AdmissionRuntime,
  journal: ReturnType<typeof createAdmissionJournal>,
  input: AdmitInput,
  entry: JournalEntry,
  principal: AuthPrincipal,
  options: CallOptions | undefined,
  reconcileFirst: boolean,
): Promise<OperationResult<Admission, AdmissionRejection>> {
  const operationId = input.operationId;
  const request = {
    operationId,
    roomId: entry.record.roomId,
    principal,
    deviceId: entry.record.deviceId,
    history: entry.record.history,
    inviteRevision: entry.record.inviteRevision,
  };
  if (reconcileFirst) {
    const reconciled = await callGateway(() => runtime.gateway.lookup(request, options));
    if (reconciled.kind === 'joined' && disclosureReady(entry.record.history, reconciled.historyReady)) {
      return complete(journal, operationId, entry, reconciled.room, options);
    }
    if (reconciled.kind === 'unavailable') {
      return entry.record.state === 'outcome_unknown' ? outcomeUnknown(operationId) : unavailable();
    }
    if (reconciled.kind === 'outcome_unknown') return outcomeUnknown(operationId);
    const eligible = await readEligibleInvite(runtime, input, principal, options);
    if ('kind' in eligible) {
      if (reconciled.kind === 'joined') {
        await journal.setState(operationId, entry, 'outcome_unknown', reconciled.room, options);
        return outcomeUnknown(operationId);
      }
      return eligible.result;
    }
    if (eligible.invite.roomId !== entry.record.roomId
      || eligible.invite.policyRevision !== entry.record.policyRevision
      || eligible.invite.policy.history !== entry.record.history) return unavailable();
  }
  const admitted = await callEffectfulGateway(() => runtime.gateway.admit(request, options));
  if (admitted.kind === 'threw') return reconcileAmbiguous(runtime, journal, request, entry, options);
  if (admitted.kind === 'forbidden') return rejected('forbidden');
  if (admitted.kind === 'unavailable') return unavailable();
  if (admitted.kind === 'joined' && disclosureReady(entry.record.history, admitted.historyReady)) {
    return complete(journal, operationId, entry, admitted.room, options);
  }
  if (admitted.kind === 'outcome_unknown') {
    return reconcileAmbiguous(runtime, journal, request, entry, options);
  }
  await journal.setState(operationId, entry, 'outcome_unknown', admitted.room, options);
  return outcomeUnknown(operationId);
}

async function reconcileAmbiguous(
  runtime: AdmissionRuntime,
  journal: ReturnType<typeof createAdmissionJournal>,
  request: Parameters<AdmissionRuntime['gateway']['lookup']>[0],
  entry: JournalEntry,
  options?: CallOptions,
): Promise<OperationResult<Admission, AdmissionRejection>> {
  const reconciled = await callGateway(() => runtime.gateway.lookup(request, options));
  if (reconciled.kind === 'joined' && disclosureReady(request.history, reconciled.historyReady)) {
    return complete(journal, request.operationId, entry, reconciled.room, options);
  }
  await journal.setState(
    request.operationId,
    entry,
    'outcome_unknown',
    reconciled.kind === 'joined' ? reconciled.room : null,
    options,
  );
  return outcomeUnknown(request.operationId);
}

async function complete(
  journal: ReturnType<typeof createAdmissionJournal>,
  operationId: string,
  entry: JournalEntry,
  room: RoomSummary,
  options?: CallOptions,
): Promise<OperationResult<Admission, AdmissionRejection>> {
  if (room.membership !== 'joined') return unavailable();
  const saved = await journal.setState(operationId, entry, 'joined', room, options);
  if (saved === 'unavailable') return unavailable();
  if (saved === 'outcome_unknown') return outcomeUnknown(operationId);
  return ok({ outcome: 'joined', room });
}

async function callGateway<T>(call: () => Promise<T>): Promise<T | { kind: 'unavailable' }> {
  try { return await call(); } catch { return { kind: 'unavailable' }; }
}

async function callEffectfulGateway<T>(call: () => Promise<T>): Promise<T | { kind: 'threw' }> {
  try { return await call(); } catch { return { kind: 'threw' }; }
}

function sameRequest(entry: JournalEntry, input: AdmitInput, ownerId: AuthPrincipal['ownerId'], runtime: AdmissionRuntime): boolean {
  return entry.record.inviteRefDigest === runtime.digests.inviteRef(input.inviteRef)
    && entry.record.ownerId === ownerId && entry.record.deviceId === input.deviceId;
}

function disclosureReady(history: AdmissionHistory, historyReady: boolean): boolean {
  return history === 'none' || historyReady;
}
