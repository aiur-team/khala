import { isHumanColorId } from '@khala/contracts/m1/colors';
import { normalizeInitials } from '@khala/contracts/m1/initials';
import { DEFAULT_LISTENING_MODE, LISTENING_MODE_MEMBER_KEY } from '@khala/contracts/m1/listening-mode';
import { LOCAL_OWNER_ID, LOCAL_OWNER_USER_ID, type OwnerProfileView } from '@khala/contracts/m1/local';
import { checkName, defaultAgentName, isDefaultAgentName } from '@khala/contracts/m1/names';
import { decodeWith, object } from '@khala/contracts/messaging/decode';
import { serial, type SerialQueue } from './owner';
import type { HelperContext, LocalRequest, LocalResponse, LocalRoute, LocalStore } from '../types';

const fail = (status: number, error: string): LocalResponse => ({ status, json: { error } });
const field = (body: unknown, key: string) => decodeWith(() => object(body, '', [key]).field(key));
const iso = (ctx: HelperContext): string => new Date(ctx.now()).toISOString();

async function cascade(store: LocalStore, previous: string, next: string): Promise<void> {
  for (const { roomId } of store.listChannels()) {
    try {
      const members = store.members(roomId);
      const taken = new Set(members.map(m => m.displayName.toLowerCase()));
      const owner = members.find(m => m.userId === LOCAL_OWNER_USER_ID);
      // The owner projection already reads the newly saved profile; the room's
      // membership event still needs to record the transition for subscribers.
      if (owner && previous !== next) {
        try {
          await store.append(roomId, { type: 'm.room.member', sender: LOCAL_OWNER_USER_ID,
            content: { user: LOCAL_OWNER_USER_ID, membership: owner.membership, displayname: next, kind: 'human' } });
          taken.delete(previous.toLowerCase());
          taken.add(next.toLowerCase());
        } catch { /* A failed owner event must not stop the agents in this channel. */ }
      }
      for (const m of members) {
        if (m.kind !== 'agent' || !m.harness || !isDefaultAgentName(m.displayName, previous, m.harness)) continue;
        const n = Number(/-(\d+)$/u.exec(m.displayName)?.[1] ?? 1);
        if (!Number.isSafeInteger(n) || n < 1) continue;
        const oldKey = m.displayName.toLowerCase();
        taken.delete(oldKey);
        try {
          let name = defaultAgentName(next, m.harness, n);
          if (taken.has(name.toLowerCase())) {
            let k = 1;
            do { name = defaultAgentName(next, m.harness, k++); } while (taken.has(name.toLowerCase()));
          }
          if (!checkName(name, 'agent').ok) {
            taken.add(oldKey);
            continue;
          }
          if (name !== m.displayName) {
            await store.append(roomId, { type: 'm.room.member', sender: LOCAL_OWNER_USER_ID,
              content: { user: m.userId, membership: m.membership, displayname: name, kind: 'agent', harness: m.harness,
                [LISTENING_MODE_MEMBER_KEY]: m.listeningMode ?? DEFAULT_LISTENING_MODE } });
          }
          taken.add(name.toLowerCase());
        } catch {
          taken.add(oldKey);
          // Keep the failed agent's name reserved while continuing the cascade.
        }
      }
    } catch { /* One unavailable channel must not stop the other channels. */ }
  }
}

export function profileRoutes(options: { queue?: SerialQueue } = {}): LocalRoute[] {
  const queue = options.queue ?? serial();
  const route = (method: LocalRoute['method'], pattern: RegExp,
    run: (req: LocalRequest, ctx: HelperContext) => Promise<LocalResponse>): LocalRoute => ({
    method, pattern,
    async handle(req, _params, ctx) {
      if (req.auth.kind === 'none') return fail(401, 'unauthorized');
      if (req.auth.kind === 'agent') return fail(403, 'forbidden');
      try { return await queue(() => run(req, ctx)); }
      catch { return fail(503, 'unavailable'); }
    },
  });
  return [
    route('GET', /^\/api\/local\/profile$/u, async (_req, ctx) => {
      const p = ctx.store.owner();
      const profile: OwnerProfileView = { userId: LOCAL_OWNER_USER_ID, ownerId: LOCAL_OWNER_ID,
        username: p.username, suggestion: p.username, color: p.color, initials: p.initials };
      return { status: 200, json: profile };
    }),
    route('POST', /^\/api\/local\/profile\/username$/u, async (req, ctx) => {
      const parsed = field(req.body, 'username');
      if (!parsed.ok) return fail(400, 'invalid_request');
      const checked = checkName(parsed.value, 'username');
      if (!checked.ok) return { status: 400, json: { error: 'invalid_username', reason: checked.error } };
      const username = checked.name;
      const p = ctx.store.owner();
      if (p.username !== username) {
        await ctx.store.setOwner({ ...p, username, updatedAt: iso(ctx) });
        try { await cascade(ctx.store, p.username, username); }
        catch { /* Persisted profile changes succeed even if the cascade is unavailable. */ }
      }
      return { status: 200, json: { username } };
    }),
    route('POST', /^\/api\/local\/profile\/color$/u, async (req, ctx) => {
      const parsed = field(req.body, 'color');
      if (!parsed.ok) return fail(400, 'invalid_request');
      if (!isHumanColorId(parsed.value)) return fail(400, 'invalid_color');
      const color = parsed.value;
      const p = ctx.store.owner();
      if (p.color !== color) await ctx.store.setOwner({ ...p, color, updatedAt: iso(ctx) });
      return { status: 200, json: { color } };
    }),
    route('POST', /^\/api\/local\/profile\/initials$/u, async (req, ctx) => {
      const parsed = field(req.body, 'initials');
      if (!parsed.ok) return fail(400, 'invalid_request');
      const initials = parsed.value === null ? null : normalizeInitials(parsed.value);
      if (parsed.value !== null && initials === null) return fail(400, 'invalid_initials');
      const p = ctx.store.owner();
      if (p.initials !== initials) await ctx.store.setOwner({ ...p, initials, updatedAt: iso(ctx) });
      return { status: 200, json: { initials } };
    }),
  ];
}
