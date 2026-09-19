import type { AuthPrincipal, JsonValue, OwnerId, RoomId } from '@khala/contracts/messaging/index';

export type AdmissionHistory = 'none' | 'full';

/** The creator selects one of these three policies for each link at share time. */
export type AdmissionPolicy =
  | Readonly<{ v: 1; kind: 'link'; history: 'none' }>
  | Readonly<{ v: 1; kind: 'named_email'; email: string; history: 'none' }>
  | Readonly<{ v: 1; kind: 'link'; history: 'full' }>;

export const DEFAULT_ADMISSION_POLICY: AdmissionPolicy = { v: 1, kind: 'link', history: 'none' };

export type StoredAdmissionPolicy =
  | Readonly<{ v: 1; kind: 'link'; history: AdmissionHistory }>
  | Readonly<{ v: 1; kind: 'named_email'; emailDigest: string; history: 'none' }>;

export type InviteRecord = Readonly<{
  v: 1;
  roomId: RoomId;
  creatorOwnerId: OwnerId;
  inviteRefDigest: string;
  policyRevision: 1;
  policy: StoredAdmissionPolicy;
  status: 'active' | 'revoked';
  expiresAt: string | null;
  lastAuthorizedOperationDigest: string | null;
}>;

export type PolicyDigests = Readonly<{
  email(email: string): string;
}>;

const EMAIL = /^[^\s@]+@[^\s@]+$/;

export function normalizeEmail(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  return EMAIL.test(normalized) ? normalized : null;
}

export function storePolicy(policy: AdmissionPolicy | undefined, digests: PolicyDigests): StoredAdmissionPolicy | null {
  const selected = policy ?? DEFAULT_ADMISSION_POLICY;
  if (selected.v !== 1) return null;
  if (selected.kind === 'link' && (selected.history === 'none' || selected.history === 'full')) {
    return { v: 1, kind: 'link', history: selected.history };
  }
  if (selected.kind === 'named_email' && selected.history === 'none') {
    const email = normalizeEmail(selected.email);
    return email ? { v: 1, kind: 'named_email', emailDigest: digests.email(email), history: 'none' } : null;
  }
  return null;
}

export function policyAllows(policy: StoredAdmissionPolicy, principal: AuthPrincipal, digests: PolicyDigests): boolean {
  return policy.kind === 'link' || policy.emailDigest === digests.email(principal.verifiedEmail.toLowerCase());
}

export function readInviteRecord(value: JsonValue): InviteRecord | null {
  if (!isObject(value)) return null;
  const { v, roomId, creatorOwnerId, inviteRefDigest, policyRevision, policy, status, expiresAt, lastAuthorizedOperationDigest } = value;
  if (v !== 1 || !nonempty(roomId) || !nonempty(creatorOwnerId) || !nonempty(inviteRefDigest) || policyRevision !== 1) return null;
  if (status !== 'active' && status !== 'revoked') return null;
  if (expiresAt !== null && (!nonempty(expiresAt) || !Number.isFinite(Date.parse(expiresAt)))) return null;
  if (lastAuthorizedOperationDigest !== null && !nonempty(lastAuthorizedOperationDigest)) return null;
  const decodedPolicy = readStoredPolicy(policy);
  return decodedPolicy ? {
    v: 1,
    roomId: roomId as RoomId,
    creatorOwnerId: creatorOwnerId as OwnerId,
    inviteRefDigest,
    policyRevision: 1,
    policy: decodedPolicy,
    status,
    expiresAt,
    lastAuthorizedOperationDigest,
  } : null;
}

function readStoredPolicy(value: JsonValue | undefined): StoredAdmissionPolicy | null {
  if (!isObject(value) || value.v !== 1) return null;
  if (value.kind === 'link' && (value.history === 'none' || value.history === 'full')) {
    return { v: 1, kind: 'link', history: value.history };
  }
  if (value.kind === 'named_email' && value.history === 'none' && nonempty(value.emailDigest)) {
    return { v: 1, kind: 'named_email', emailDigest: value.emailDigest, history: 'none' };
  }
  return null;
}

function nonempty(value: JsonValue | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isObject(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
