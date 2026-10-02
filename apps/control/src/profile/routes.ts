import { checkName, nameKey, suggestUsername, USERNAME_MAX } from '@khala/contracts/m1/names';
import { decodeNameReservation, decodeProfileRecord, profileRecordKey, type ProfileRecord } from '@khala/contracts/m1/profile';
import { decodeWith, object } from '@khala/contracts/messaging/decode';
import type { AuthPrincipal, ControlStore, OwnerId } from '@khala/contracts/messaging/index';
import type { AuthService } from '../auth/index';
import { safeRead, writeAndResolve } from '../invitations/internal';

export type ProfileDeps = Readonly<{
  auth: Pick<AuthService, 'authenticateRequest' | 'requireHumanMutation'>;
  store: ControlStore;
  clock: () => number;
  random: (bytes: number) => Uint8Array;
  setDisplayName(ownerId: OwnerId, name: string): Promise<boolean>;
  afterUsernameChange?(ownerId: OwnerId, previous: string | null, next: string): Promise<void>;
}>;
const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: {
  'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
} });
const error = (status: number, code: string) => json(status, { error: code });
const unavailable = () => error(503, 'unavailable');
const ownReservation = (value: unknown, ownerId: string): boolean => {
  const decoded = decodeNameReservation(value);
  return decoded.ok && decoded.value.kind === 'human' && decoded.value.ownerId === ownerId;
};

export function createProfileHandlers(deps: ProfileDeps) {
  const operationId = () => `profile.${Buffer.from(deps.random(16)).toString('hex')}`;
  async function readProfile(ownerId: OwnerId) {
    const read = await safeRead(deps.store, profileRecordKey(ownerId));
    if (read.kind === 'unavailable') return { kind: 'unavailable' as const };
    if (read.kind === 'absent') return { kind: 'ok' as const, record: null, revision: null };
    const decoded = decodeProfileRecord(read.record.value);
    if (!decoded.ok || decoded.value.ownerId !== ownerId) return { kind: 'unavailable' as const };
    return { kind: 'ok' as const, record: decoded.value, revision: read.record.revision };
  }
  async function getProfile(principal: AuthPrincipal): Promise<Response> {
    const profile = await readProfile(principal.ownerId);
    if (profile.kind !== 'ok') return unavailable();
    const base = suggestUsername(principal.verifiedEmail);
    for (let n = 1; n <= 99; n++) {
      const suffix = n === 1 ? '' : String(n);
      const stem = base.slice(0, USERNAME_MAX - suffix.length).replace(/[._-]+$/u, '');
      const suggestion = `${stem}${suffix}`;
      const reservation = await safeRead(deps.store, nameKey(suggestion));
      if (reservation.kind === 'unavailable') return unavailable();
      if (reservation.kind === 'absent' || ownReservation(reservation.record.value, principal.ownerId)) {
        return json(200, { username: profile.record?.username ?? null, suggestion });
      }
    }
    return unavailable();
  }
  async function displayName(ownerId: OwnerId, username: string): Promise<void> {
    try {
      if (await deps.setDisplayName(ownerId, username)) return;
    } catch { /* Log only the finite failure code, never upstream details. */ }
    console.warn('profile_display_name_unavailable');
  }
  async function release(ownerId: OwnerId, username: string): Promise<void> {
    try {
      const key = nameKey(username);
      const read = await safeRead(deps.store, key);
      if (read.kind === 'record' && ownReservation(read.record.value, ownerId)) {
        await writeAndResolve(deps.store, { key, expectedRevision: read.record.revision, operationId: operationId(),
          next: { value: read.record.value, expiresAt: new Date(deps.clock()).toISOString() } });
      }
    } catch { /* Releasing an old name is best effort. */ }
  }
  async function setUsername(request: Request, principal: AuthPrincipal): Promise<Response> {
    let input: unknown;
    try { input = await request.json(); } catch { return error(400, 'invalid_request'); }
    const parsed = decodeWith(() => object(input, '', ['username']).field('username'));
    if (!parsed.ok) return error(400, 'invalid_request');
    const checked = checkName(parsed.value, 'username');
    if (!checked.ok) return json(400, { error: 'invalid_username', reason: checked.error });
    const username = checked.name;
    let profile = await readProfile(principal.ownerId);
    if (profile.kind !== 'ok') return unavailable();
    if (profile.record?.username === username) {
      await displayName(principal.ownerId, username);
      return json(200, { username });
    }
    const reserved = await writeAndResolve(deps.store, { key: nameKey(username), expectedRevision: null,
      operationId: operationId(), next: { value: { v: 1, kind: 'human', ownerId: principal.ownerId }, expiresAt: null } });
    if (reserved.kind === 'conflict') {
      if (!ownReservation(reserved.current?.value, principal.ownerId)) return error(409, 'username_taken');
    } else if (reserved.kind !== 'applied') return unavailable();

    for (let attempt = 0; attempt < 2; attempt++) {
      const previous = profile.record?.username ?? null;
      const next: ProfileRecord = { v: 1, ownerId: principal.ownerId, username, updatedAt: new Date(deps.clock()).toISOString() };
      const written = await writeAndResolve(deps.store, { key: profileRecordKey(principal.ownerId), expectedRevision: profile.revision,
        operationId: operationId(), next: { value: next, expiresAt: null } });
      if (written.kind === 'conflict') {
        if (attempt === 1) return unavailable();
        const latest = await readProfile(principal.ownerId);
        if (latest.kind !== 'ok') return unavailable();
        profile = latest;
        continue;
      }
      if (written.kind !== 'applied') return unavailable();
      if (previous !== null && nameKey(previous) !== nameKey(username)) await release(principal.ownerId, previous);
      await displayName(principal.ownerId, username);
      try { await deps.afterUsernameChange?.(principal.ownerId, previous, username); }
      catch { console.warn('profile_after_username_change_unavailable'); }
      return json(200, { username });
    }
    return unavailable();
  }
  const handler = (mutation: boolean) => async (request: Request): Promise<Response> => {
    try {
      if (request.method !== (mutation ? 'POST' : 'GET')) return error(405, 'method_not_allowed');
      let principal: AuthPrincipal;
      if (mutation) {
        const auth = await deps.auth.requireHumanMutation(request);
        if (auth.kind === 'unavailable') return unavailable();
        if (auth.kind === 'rejected') {
          if (auth.code === 'signed_out') return error(401, auth.code);
          if (auth.code === 'not_a_mutation') return error(405, 'method_not_allowed');
          return error(403, auth.code);
        }
        principal = auth.context.principal;
      } else {
        const auth = await deps.auth.authenticateRequest(request);
        if (auth.kind !== 'authenticated') return auth.kind === 'signed_out' ? error(401, 'signed_out') : unavailable();
        principal = auth.context.principal;
      }
      return await (mutation ? setUsername(request, principal) : getProfile(principal));
    } catch { return unavailable(); }
  };
  return { get: handler(false), setUsername: handler(true) };
}
