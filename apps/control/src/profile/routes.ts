import { decodeHumanColorRecord, defaultHumanColor, humanColorRecordKey, isHumanColorId, type HumanColorId } from '@khala/contracts/m1/colors';
import { checkName, nameKey, suggestUsername, USERNAME_MAX } from '@khala/contracts/m1/names';
import { decodeNameReservation, decodeProfileRecord, profileRecordKey, type ProfileRecord } from '@khala/contracts/m1/profile';
import { decodeWith, object } from '@khala/contracts/messaging/decode';
import type { AuthPrincipal, ControlRecord, ControlStore, OwnerId } from '@khala/contracts/messaging/index';
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
  async function readColor(ownerId: OwnerId): Promise<
    { kind: 'ok'; color: HumanColorId; revision: string | null; chosen: boolean } | { kind: 'unavailable' }
  > {
    const read = await safeRead(deps.store, humanColorRecordKey(ownerId));
    if (read.kind === 'unavailable') return { kind: 'unavailable' };
    if (read.kind === 'absent') return { kind: 'ok', color: defaultHumanColor(ownerId), revision: null, chosen: false };
    const decoded = decodeHumanColorRecord(read.record.value);
    const chosen = decoded.ok && decoded.value.ownerId === ownerId;
    return { kind: 'ok', color: chosen ? decoded.value.color : defaultHumanColor(ownerId),
      revision: read.record.revision, chosen };
  }
  async function getProfile(principal: AuthPrincipal): Promise<Response> {
    const profile = await readProfile(principal.ownerId);
    if (profile.kind !== 'ok') return unavailable();
    const color = await readColor(principal.ownerId);
    if (color.kind !== 'ok') return unavailable();
    const base = suggestUsername(principal.verifiedEmail);
    for (let n = 1; n <= 99; n++) {
      const suffix = n === 1 ? '' : String(n);
      const stem = base.slice(0, USERNAME_MAX - suffix.length).replace(/[._-]+$/u, '');
      const suggestion = `${stem}${suffix}`;
      const reservation = await safeRead(deps.store, nameKey(suggestion));
      if (reservation.kind === 'unavailable') return unavailable();
      if (reservation.kind === 'absent' || ownReservation(reservation.record.value, principal.ownerId)) {
        return json(200, { username: profile.record?.username ?? null, suggestion, color: color.color });
      }
    }
    return unavailable();
  }
  async function displayName(ownerId: OwnerId): Promise<void> {
    try {
      // Cleanup can be delayed behind a newer rename; reconcile to the latest
      // committed profile rather than replaying this request's historical name.
      const latest = await readProfile(ownerId);
      if (latest.kind === 'ok' && latest.record && await deps.setDisplayName(ownerId, latest.record.username)) return;
    } catch { /* Log only the finite failure code, never upstream details. */ }
    console.warn('profile_display_name_unavailable');
  }
  async function release(record: ControlRecord | null): Promise<void> {
    if (record === null) return;
    try {
      await writeAndResolve(deps.store, { key: record.key, expectedRevision: record.revision, operationId: operationId(),
        next: { value: record.value, expiresAt: new Date(deps.clock()).toISOString() } });
    } catch { /* Releasing an old name is best effort. */ }
  }
  async function reserve(ownerId: OwnerId, username: string): Promise<'ok' | 'taken' | 'unavailable'> {
    const input = { key: nameKey(username), expectedRevision: null, operationId: operationId(),
      next: { value: { v: 1, kind: 'human', ownerId }, expiresAt: null } } as const;
    const reserved = await writeAndResolve(deps.store, input);
    if (reserved.kind === 'applied') return 'ok';
    if (reserved.kind !== 'conflict') return 'unavailable';
    if (!reserved.current || !ownReservation(reserved.current.value, ownerId)) return 'taken';
    // Rotate even an own reservation: an earlier rename may still be releasing
    // the revision it observed before committing its profile change.
    const renewed = await writeAndResolve(deps.store, { ...input, expectedRevision: reserved.current.revision,
      operationId: operationId() });
    if (renewed.kind === 'applied') return 'ok';
    if (renewed.kind === 'conflict' && renewed.current && !ownReservation(renewed.current.value, ownerId)) return 'taken';
    return 'unavailable';
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
      await displayName(principal.ownerId);
      return json(200, { username });
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const reserved = await reserve(principal.ownerId, username);
      if (reserved === 'taken') return error(409, 'username_taken');
      if (reserved !== 'ok') return unavailable();
      const previous = profile.record?.username ?? null;
      let previousReservation: ControlRecord | null = null;
      if (previous !== null && nameKey(previous) !== nameKey(username)) {
        const read = await safeRead(deps.store, nameKey(previous));
        if (read.kind === 'record' && ownReservation(read.record.value, principal.ownerId)) previousReservation = read.record;
      }
      // Capture the old reservation before the profile CAS. A concurrent claim
      // either rotates this revision or must retry after its profile CAS fails.
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
      await release(previousReservation);
      await displayName(principal.ownerId);
      try { await deps.afterUsernameChange?.(principal.ownerId, previous, username); }
      catch { console.warn('profile_after_username_change_unavailable'); }
      return json(200, { username });
    }
    return unavailable();
  }
  async function setColor(request: Request, principal: AuthPrincipal): Promise<Response> {
    let input: unknown;
    try { input = await request.json(); } catch { return error(400, 'invalid_request'); }
    const parsed = decodeWith(() => object(input, '', ['color']).field('color'));
    if (!parsed.ok) return error(400, 'invalid_request');
    if (!isHumanColorId(parsed.value)) return error(400, 'invalid_color');
    const color = parsed.value;
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await readColor(principal.ownerId);
      if (current.kind !== 'ok') return unavailable();
      // A fallback is display data, not a stored choice: repair corrupt records
      // even when the requested colour happens to equal the default.
      if (current.chosen && current.color === color) return json(200, { color });
      const written = await writeAndResolve(deps.store, { key: humanColorRecordKey(principal.ownerId),
        expectedRevision: current.revision, operationId: operationId(),
        next: { value: { v: 1, ownerId: principal.ownerId, color }, expiresAt: null } });
      if (written.kind === 'applied') return json(200, { color });
      if (written.kind !== 'conflict') return unavailable();
    }
    return unavailable();
  }
  const handler = (kind: 'get' | 'username' | 'color') => async (request: Request): Promise<Response> => {
    const mutation = kind !== 'get';
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
      if (kind === 'color') return await setColor(request, principal);
      if (kind === 'username') return await setUsername(request, principal);
      return await getProfile(principal);
    } catch { return unavailable(); }
  };
  return { get: handler('get'), setUsername: handler('username'), setColor: handler('color') };
}
