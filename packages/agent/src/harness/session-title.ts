import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { HarnessId } from '@khala/contracts/m1/harness';
import { agentNameFromTitle } from '@khala/contracts/m1/names';
import { SESSION_ID_PATTERN } from '../state';

const home = (env: NodeJS.ProcessEnv, variable: string, fallback: string): string =>
  env[variable] && path.isAbsolute(env[variable]!) ? env[variable]! : path.join(env.HOME ?? os.homedir(), fallback);

/** The last string `pick` returns over a JSONL file; lines without `marker` are not parsed. */
async function lastJsonl(file: string, marker: string, pick: (entry: Record<string, unknown>) => unknown): Promise<string | null> {
  let last: string | null = null;
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes(marker)) continue;
    try {
      const value = pick(JSON.parse(line));
      if (typeof value === 'string') last = value;
    } catch { /* A partial or foreign line names nothing. */ }
  }
  return last;
}

/** Claude Code: `/rename` appends `custom-title` entries; `ai-title` entries are automatic and ignored. */
async function claudeTitle(sessionId: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const projects = path.join(home(env, 'CLAUDE_CONFIG_DIR', '.claude'), 'projects');
  for (const dir of await fs.readdir(projects)) {
    const file = path.join(projects, dir, `${sessionId}.jsonl`);
    if (!(await fs.stat(file).catch(() => null))?.isFile()) continue;
    return lastJsonl(file, '"custom-title"', entry => entry.type === 'custom-title' && entry.sessionId === sessionId ? entry.customTitle : undefined);
  }
  return null;
}

/** Codex: thread names live in `$CODEX_HOME/session_index.jsonl`, newest last. */
function codexTitle(sessionId: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return lastJsonl(path.join(home(env, 'CODEX_HOME', '.codex'), 'session_index.jsonl'), sessionId,
    entry => entry.id === sessionId ? entry.thread_name : undefined);
}

/**
 * The user-set title of this harness session as an agent name, or null. Local and read-only: only the
 * sanitised name leaves this machine. Cursor and OpenCode keep no locally distinguishable user-set title, so they get none.
 */
export async function sessionTitleName(harness: HarnessId, sessionId: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;
  try {
    const title = harness === 'claude' ? await claudeTitle(sessionId, env) : harness === 'codex' ? await codexTitle(sessionId, env) : null;
    return title === null ? null : agentNameFromTitle(title);
  } catch { return null; }
}
