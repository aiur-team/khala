import * as fs from 'node:fs/promises';
import path from 'node:path';
import { listChannels } from '../channels';
import { readStateFile, SESSION_ID_PATTERN, sessionFiles, stateRoot, StateError } from '../state';
import type { ResolvedSession } from '../harness/session-sources';

/** Discovery is only for startup intake; a workspace never identifies a tool call's thread. */
export async function codexStartupSessions(env: NodeJS.ProcessEnv): Promise<ResolvedSession[]> {
  const directory = path.join(stateRoot(env), 'codex');
  try { await fs.lstat(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  for (const dir of [stateRoot(env), directory]) {
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || process.platform !== 'win32' && (stat.mode & 0o077) !== 0
      || typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new StateError('unsafe_state_dir');
  }
  const workspace = path.resolve(env.PWD ?? process.cwd());
  const sessions: ResolvedSession[] = [];
  for (const sessionId of await fs.readdir(directory)) {
    if (!SESSION_ID_PATTERN.test(sessionId)) continue;
    const files = sessionFiles('codex', sessionId, env);
    const stat = await fs.lstat(files.dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    for (const channel of await listChannels(files)) {
      const authorization = await readStateFile<{ workspace?: unknown }>(channel.files.dir, 'resume.json');
      if (authorization?.workspace === workspace) {
        sessions.push({ sessionId, rejoinable: true });
        break;
      }
    }
  }
  return sessions;
}
