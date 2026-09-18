import { createHmac } from 'node:crypto';
import type {
  CallOptions,
  CompareAndSetInput,
  ControlRead,
  ControlStore,
  IdentityState,
  IdentityPort,
  JsonValue,
  WriteResult,
} from '@khala/contracts/messaging/index';

type SignedIn = Extract<IdentityState, { kind: 'signed_in' }>;

export type Digests = Readonly<{
  token(operationId: string): string;
  inviteKey(inviteRef: string): string;
  inviteRef(inviteRef: string): string;
  operation(operationId: string): string;
  email(email: string): string;
}>;

export function createDigests(secret: string | Uint8Array): Digests {
  const bytes = Buffer.from(secret);
  if (bytes.byteLength < 32) throw new Error('invitation secret must contain at least 32 bytes');
  const digest = (purpose: string, value: string) => createHmac('sha256', bytes).update(`${purpose}\0${value}`).digest('base64url');
  return {
    token: operationId => `inv_${digest('invite-token', operationId)}`,
    inviteKey: inviteRef => `invitations.invite.${digest('invite-key', inviteRef)}`,
    inviteRef: inviteRef => digest('invite-reference', inviteRef),
    operation: operationId => digest('operation', operationId),
    email: email => digest('named-email', email),
  };
}

export function validateOrigin(origin: string, allowedOrigins: readonly string[]): string {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error('invitation origin must be a valid allowlisted origin');
  }
  const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash
    || !(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback.has(parsed.hostname)))) {
    throw new Error('invitation origin must be a valid allowlisted origin');
  }
  const allowlist = allowedOrigins.map(value => {
    try { return new URL(value).origin; } catch { return ''; }
  });
  if (!allowlist.includes(parsed.origin)) throw new Error('invitation origin must be allowlisted');
  return parsed.origin;
}

export async function currentPrincipal(identity: IdentityPort, options?: CallOptions): Promise<SignedIn | 'auth_required' | 'unavailable'> {
  try {
    const state = await identity.current(options);
    if (state.kind === 'signed_in') return state;
    return state.kind === 'signed_out' ? 'auth_required' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

export async function safeRead<T extends JsonValue>(store: ControlStore, key: string, options?: CallOptions): Promise<ControlRead<T>> {
  try {
    return await store.read<T>(key, options);
  } catch {
    return { kind: 'unavailable' };
  }
}

export async function writeAndResolve<T extends JsonValue>(
  store: ControlStore,
  input: CompareAndSetInput<T>,
  options?: CallOptions,
): Promise<WriteResult<T>> {
  let result: WriteResult<T>;
  try {
    result = await store.compareAndSet<T>(input, options);
  } catch {
    return { kind: 'outcome_unknown', operationId: input.operationId };
  }
  if (result.kind !== 'outcome_unknown') return result;
  try {
    const resolved = await store.resolve<T>({ key: input.key, operationId: input.operationId }, options);
    if (resolved.kind === 'applied') return resolved;
    if (resolved.kind === 'not_applied') {
      try { return await store.compareAndSet<T>(input, options); } catch { return result; }
    }
    // Once a write may have landed, a failed read-back cannot make it definitely
    // absent. Preserve the original ambiguity until a later retry can prove it.
    return result;
  } catch {
    return result;
  }
}
