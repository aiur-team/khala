import { decodeHumanInitialsRecord, humanInitialsRecordKey, normalizeInitials } from '@khala/contracts/m1/initials';
import { decodeHumanColorRecord, defaultHumanColor, humanColorRecordKey, isHumanColorId, type HumanColorId } from '@khala/contracts/m1/colors';
import { checkName, suggestUsername } from '@khala/contracts/m1/names';
import { decodeProfileRecord, profileRecordKey, type ProfileRecord } from '@khala/contracts/m1/profile';
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
  async function readInitials(ownerId: OwnerId): Promise<
    { kind: 'ok'; initials: string | null; revision: string | null; valid: boolean } | { kind: 'unavailable' }
  > {
    const read = await safeRead(deps.store, humanInitialsRecordKey(ownerId));
    if (read.kind === 'unavailable') return { kind: 'unavailable' };
    if (read.kind === 'absent') return { kind: 'ok', initials: null, revision: null, valid: true };
    const decoded = decodeHumanInitialsRecord(read.record.value);
    const valid = decoded.ok && decoded.value.ownerId === ownerId;
    return { kind: 'ok', initials: valid ? decoded.value.initials : null, revision: read.record.revision, valid };
  }
  async function getProfile(principal: AuthPrincipal): Promise<Response> {
    const profile = await readProfile(principal.ownerId);
    if (profile.kind !== 'ok') return unavailable();
    const color = await readColor(principal.ownerId);
    if (color.kind !== 'ok') return unavailable();
    const initials = await readInitials(principal.ownerId);
    if (initials.kind !== 'ok') return unavailable();
    // Usernames are not unique across Khala, so the suggestion needs no reservation lookup.
    return json(200, { username: profile.record?.username ?? null, suggestion: suggestUsername(principal.verifiedEmail),
      color: color.color, initials: initials.initials });
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
    // Usernames are not unique across Khala: two people may share one, and a
    // channel where they meet asks the later one for a name there instead.
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
  async function setInitials(request: Request, principal: AuthPrincipal): Promise<Response> {
    let input: unknown;
    try { input = await request.json(); } catch { return error(400, 'invalid_request'); }
    const parsed = decodeWith(() => object(input, '', ['initials']).field('initials'));
    if (!parsed.ok) return error(400, 'invalid_request');
    const initials = parsed.value === null ? null : normalizeInitials(parsed.value);
    if (parsed.value !== null && initials === null) return error(400, 'invalid_initials');
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await readInitials(principal.ownerId);
      if (current.kind !== 'ok') return unavailable();
      if (current.valid && current.initials === initials) return json(200, { initials });
      const written = await writeAndResolve(deps.store, { key: humanInitialsRecordKey(principal.ownerId),
        expectedRevision: current.revision, operationId: operationId(),
        next: { value: { v: 1, ownerId: principal.ownerId, initials }, expiresAt: null } });
      if (written.kind === 'applied') return json(200, { initials });
      if (written.kind !== 'conflict') return unavailable();
    }
    return unavailable();
  }
  const handler = (kind: 'get' | 'username' | 'color' | 'initials') => async (request: Request): Promise<Response> => {
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
      if (kind === 'initials') return await setInitials(request, principal);
      if (kind === 'color') return await setColor(request, principal);
      if (kind === 'username') return await setUsername(request, principal);
      return await getProfile(principal);
    } catch { return unavailable(); }
  };
  return { get: handler('get'), setUsername: handler('username'), setColor: handler('color'), setInitials: handler('initials') };
}
