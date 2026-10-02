import { reserved } from '../messaging/agent-names';
import type { Harness } from './agent-join';
import { readMatrixUserId } from './agent-join';
import { type Decoded, array, decodeWith, elementPath, fail, identifier, object, version } from '../messaging/decode';
import { ownerFirstName } from './participants';

export const USERNAME_MIN = 2;
export const USERNAME_MAX = 24;
export const AGENT_NAME_MIN = 2;
export const AGENT_NAME_MAX = 40;
export type NameKind = 'username' | 'agent';
export type NameError = 'too_short' | 'too_long' | 'invalid_characters' | 'reserved';
export type NameCheck = { ok: true; name: string } | { ok: false; error: NameError };
const mentionName = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;
const adjacentSeparators = /[._-]{2}/u;
const agentSuffix = /-(?:claude|codex)(?:-\d+)?$/iu;

export function checkName(input: unknown, kind: NameKind): NameCheck {
  if (typeof input !== 'string') return { ok: false, error: 'invalid_characters' };
  const name = input.trim();
  if (name.length < (kind === 'username' ? USERNAME_MIN : AGENT_NAME_MIN)) return { ok: false, error: 'too_short' };
  if (name.length > (kind === 'username' ? USERNAME_MAX : AGENT_NAME_MAX)) return { ok: false, error: 'too_long' };
  if (!mentionName.test(name) || adjacentSeparators.test(name)) return { ok: false, error: 'invalid_characters' };
  if (reserved.test(name) || kind === 'username' && agentSuffix.test(name)) return { ok: false, error: 'reserved' };
  return { ok: true, name };
}

export const nameKey = (name: string): string => `names/v1/${name.toLowerCase()}`;
export const MODEL_NAMES: Record<Harness, string> = { claude: 'Claude', codex: 'Codex' };
export function defaultAgentName(username: string, harness: Harness, n = 1): string {
  return `${username}-${MODEL_NAMES[harness]}${n === 1 ? '' : `-${n}`}`;
}
export function isDefaultAgentName(name: string, username: string, harness: Harness): boolean {
  const escaped = `${username}-${MODEL_NAMES[harness]}`.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`^${escaped}(?:-\\d+)?$`, 'iu').test(name);
}
export function suggestUsername(email: string): string {
  const base = ownerFirstName(email).replace(/[^A-Za-z0-9._-]/gu, '')
    .replace(/^[._-]+|[._-]+$/gu, '').slice(0, USERNAME_MAX).replace(/[._-]+$/gu, '');
  return checkName(base, 'username').ok ? base : 'User';
}

export type OwnerAgents = { v: 1; ownerId: string; agents: string[] };
export const ownerAgentsKey = (ownerId: string): string => `owner-agents/${encodeURIComponent(ownerId)}`;
export function decodeOwnerAgents(input: unknown): Decoded<OwnerAgents> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'ownerId', 'agents']);
    const entries = array(r.field('agents'), r.at('agents'));
    if (entries.length > 200) fail(r.at('agents'), 'too_long');
    const seen = new Set<string>();
    const agents = entries.map((value, index) => {
      const path = elementPath(r.at('agents'), index);
      const userId = readMatrixUserId(value, path);
      if (seen.has(userId)) fail(path, 'duplicate');
      seen.add(userId);
      return userId;
    });
    return { v: version(r.field('v'), r.at('v')), ownerId: identifier(r.field('ownerId'), r.at('ownerId')), agents };
  });
}
