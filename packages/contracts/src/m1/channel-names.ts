// Per-channel names. Usernames and agent names are not unique across Khala, so a
// member can hold a name for one channel that overrides their global one there.
// Identity, owners, colours and mentions stay keyed by ids; these helpers only
// pick which name a member shows in one channel and who has to change it.
import { type Decoded, decodeWith, fail, identifier, object } from '../messaging/decode';
import type { HarnessId } from './harness';
import { AGENT_NAME_MAX, checkName, defaultAgentName, USERNAME_MAX, type NameKind } from './names';

/** `POST` `{ name }` sets the local owner's name in one channel; answers `{ name }`. */
export const localChannelNamePath = (roomId: string): string => `/api/local/channels/${encodeURIComponent(roomId)}/name`;
export type ChannelNameResult = { name: string };
export function decodeChannelNameResult(input: unknown): Decoded<ChannelNameResult> {
  return decodeWith(() => {
    const r = object(input, '', ['name']);
    const name = identifier(r.field('name'), r.at('name'));
    const checked = checkName(name, 'username');
    if (!checked.ok || checked.name !== name) fail(r.at('name'), 'invalid_value');
    return { name };
  });
}

const key = (name: string): string => name.trim().toLowerCase();

/** The lowercase names `members` hold, for case-insensitive collision checks. */
export function takenNames(names: Iterable<string>): Set<string> {
  return new Set([...names].map(key));
}

/**
 * The lowest free numbered variant of `name` in a channel whose other members
 * hold `taken`: `alice` → `alice2`, then `alice3`, filling gaps first. An
 * agent keeps today's dash form (`kevin-Claude` → `kevin-Claude-2`). A name
 * that already ends in a number counts from its stem (`alice2` → `alice3`).
 */
export function channelNameSuggestion(name: string, kind: NameKind, taken: Iterable<string>): string {
  const used = takenNames(taken);
  const trimmed = name.trim();
  const max = kind === 'username' ? USERNAME_MAX : AGENT_NAME_MAX;
  const stem = (kind === 'username' ? trimmed.replace(/\d+$/u, '') : trimmed.replace(/-\d+$/u, '')) || trimmed;
  for (let n = 2; n < 1000; n++) {
    const suffix = kind === 'username' ? String(n) : `-${n}`;
    const candidate = `${stem.slice(0, max - suffix.length).replace(/[._-]+$/u, '')}${suffix}`;
    if (!used.has(key(candidate)) && checkName(candidate, kind).ok) return candidate;
  }
  return trimmed;
}

/** An agent's default name with the lowest `-N` free among `taken` in its channel. */
export function freeAgentName(username: string, harness: HarnessId, taken: Iterable<string>): string {
  const used = takenNames(taken);
  let n = 1;
  while (n < 1000 && used.has(key(defaultAgentName(username, harness, n)))) n++;
  return defaultAgentName(username, harness, n);
}

export type NamedMember = Readonly<{ id: string; name: string; since?: number | null }>;

/**
 * Which members share an effective name with someone who held it first. The
 * member who held the name first is never listed; every later holder maps to
 * that first holder's id. `since` is when the member took its current name
 * (its latest membership event); members without one keep their list order
 * after those with one.
 */
export function nameCollisions(members: readonly NamedMember[]): ReadonlyMap<string, string> {
  const ordered = members.map((member, index) => ({ member, index })).sort((a, b) => {
    const left = a.member.since ?? Number.POSITIVE_INFINITY, right = b.member.since ?? Number.POSITIVE_INFINITY;
    return left === right ? a.index - b.index : left - right;
  });
  const first = new Map<string, string>();
  const collisions = new Map<string, string>();
  for (const { member } of ordered) {
    const name = key(member.name);
    if (!name) continue;
    const holder = first.get(name);
    if (holder === undefined) first.set(name, member.id);
    else if (holder !== member.id) collisions.set(member.id, holder);
  }
  return collisions;
}

/**
 * Whether an agent's `name` reads as an automatic `-N` suffix on a name another
 * member of the channel holds, so its owner should see the channel name it got.
 */
export function isSuffixedAgentName(name: string, others: Iterable<string>): boolean {
  const match = /^(.+)-(\d+)$/u.exec(name.trim());
  if (!match || Number(match[2]) < 2) return false;
  const base = key(match[1]!);
  return [...others].some(other => key(other) === base || key(other).startsWith(`${base}-`) && /^-\d+$/u.test(key(other).slice(base.length)));
}
