import path from 'node:path';
import { plainObject } from '../cli/validation.js';
import { CODEX_HOOK_EVENTS, type CodexHookEvent } from './hook.js';

/**
 * The installed handler. Codex hashes each handler when the user trusts it, so this
 * string must stay byte-stable across Khala releases: any change asks for a fresh
 * review. It carries no channel, binding, token or message bytes.
 */
export const CODEX_HOOK_COMMAND = 'khala codex-hook';
export const CODEX_HOOK_TIMEOUT_SECONDS = 30;

type CodexHookHandler = Readonly<{ type: 'command'; command: typeof CODEX_HOOK_COMMAND; timeout: number }>;
export type CodexHooksFragment = Readonly<{
  hooks: Readonly<Record<CodexHookEvent, readonly Readonly<{ hooks: readonly CodexHookHandler[] }>[]>>;
}>;

/** The `hooks.json` entries `setup-cli-codex` merges into the user's Codex config layer. */
export function codexHooksFragment(): CodexHooksFragment {
  const handler: CodexHookHandler = { type: 'command', command: CODEX_HOOK_COMMAND, timeout: CODEX_HOOK_TIMEOUT_SECONDS };
  const group = [{ hooks: [handler] }];
  return { hooks: { PreToolUse: group, PostToolUse: group, UserPromptSubmit: group, Stop: group } };
}

export type CodexHookReview =
  | Readonly<{ state: 'trusted' }>
  | Readonly<{ state: 'awaiting_hook_review' | 'unknown'; reason: string }>;

const TRUST_EVENT: Readonly<Record<CodexHookEvent, string>> = {
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
  UserPromptSubmit: 'user_prompt_submit',
  Stop: 'stop',
};

/**
 * Whether the user has trusted every installed Khala handler in Codex's
 * **Hooks need review** dialog. Codex records that trust as
 * `[hooks.state."<hooks.json path>:<event>:<group>:<handler>"] trusted_hash`
 * in `config.toml`. This only reads that record; setup must never write it.
 */
export function codexHookReviewState(input: Readonly<{
  hooksPath: string;
  hooksJson: unknown;
  configToml: string | null;
}>): CodexHookReview {
  if (!path.isAbsolute(input.hooksPath)) {
    return { state: 'unknown', reason: 'The Codex hooks.json path is not absolute.' };
  }
  const installed = installedKhalaHandlers(input.hooksJson);
  if (installed === null) return { state: 'unknown', reason: 'The Codex hooks.json file is not valid hook configuration.' };
  const missing = CODEX_HOOK_EVENTS.filter(event => installed[event].length === 0);
  if (missing.length > 0) {
    return { state: 'unknown', reason: `The Khala Codex hook is not installed for ${missing.join(', ')}.` };
  }
  const trusted = input.configToml === null ? new Set<string>() : trustedHookKeys(input.configToml);
  const untrusted = CODEX_HOOK_EVENTS.filter(event => installed[event].some(position => !trusted.has(
    `${input.hooksPath}:${TRUST_EVENT[event]}:${position.group}:${position.handler}`,
  )));
  if (untrusted.length > 0) {
    return {
      state: 'awaiting_hook_review',
      reason: `Codex has not trusted the Khala hook for ${untrusted.join(', ')}. `
        + 'Start Codex and trust the Khala hooks once in its Hooks need review dialog.',
    };
  }
  return { state: 'trusted' };
}

type HandlerPosition = Readonly<{ group: number; handler: number }>;

function installedKhalaHandlers(value: unknown): Record<CodexHookEvent, HandlerPosition[]> | null {
  if (!plainObject(value) || !(value.hooks === undefined || plainObject(value.hooks))) return null;
  const hooks = (value.hooks ?? {}) as Record<string, unknown>;
  const found = Object.fromEntries(CODEX_HOOK_EVENTS.map(event => [event, [] as HandlerPosition[]])) as
    Record<CodexHookEvent, HandlerPosition[]>;
  for (const event of CODEX_HOOK_EVENTS) {
    const groups = hooks[event];
    if (groups === undefined) continue;
    if (!Array.isArray(groups)) return null;
    for (const [group, entry] of groups.entries()) {
      if (!plainObject(entry) || !Array.isArray(entry.hooks)) return null;
      for (const [handler, candidate] of entry.hooks.entries()) {
        if (plainObject(candidate) && candidate.type === 'command' && candidate.command === CODEX_HOOK_COMMAND) {
          found[event].push({ group, handler });
        }
      }
    }
  }
  return found;
}

const HOOK_STATE_HEADER = /^\s*\[\s*hooks\s*\.\s*state\s*\.\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*\]\s*(?:#.*)?$/;
const TABLE_HEADER = /^\s*\[/;
const TRUSTED_HASH = /^\s*trusted_hash\s*=\s*"sha256:[0-9a-f]{64}"\s*(?:#.*)?$/;

/** Keys of `[hooks.state."…"]` tables that carry a `trusted_hash`, in Codex's written form. */
function trustedHookKeys(toml: string): Set<string> {
  const trusted = new Set<string>();
  let current: string | null = null;
  for (const line of toml.split(/\r?\n/)) {
    const header = HOOK_STATE_HEADER.exec(line);
    if (header) {
      current = tomlKey(header[1]!);
      continue;
    }
    if (TABLE_HEADER.test(line)) {
      current = null;
      continue;
    }
    if (current !== null && TRUSTED_HASH.test(line)) trusted.add(current);
  }
  return trusted;
}

function tomlKey(quoted: string): string | null {
  if (quoted.startsWith("'")) return quoted.slice(1, -1);
  try {
    const decoded: unknown = JSON.parse(quoted);
    return typeof decoded === 'string' ? decoded : null;
  } catch {
    return null;
  }
}
