import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDirectory, writePrivateFile } from '../../descriptor/write';

/** Must match the plugin runtime's claudeWakeSignalPath for this native session. */
export function claudeWakeSignalPath(root: string, sessionId: string): string {
  const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
  return path.join(path.dirname(root), 'claude-hooks', `${digest}.signal`);
}

function safeSignal(file: string): boolean {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600
      && (typeof process.getuid !== 'function' || stat.uid === process.getuid());
  } catch { return false; }
}

/** Create only after an approved binding. Existing signal inodes stay stable for Claude's watcher. */
export function ensureClaudeWakeSignal(root: string, sessionId: string): boolean {
  const file = claudeWakeSignalPath(root, sessionId);
  try {
    ensurePrivateDirectory(path.dirname(file));
    if (!fs.existsSync(file)) writePrivateFile(path.dirname(file), path.basename(file), '0');
    return safeSignal(file);
  } catch { return false; }
}

/** A content-free in-place change; neither this file nor its writer holds a message or token. */
export function pulseClaudeWakeSignal(root: string, sessionId: string, generation: number): boolean {
  const file = claudeWakeSignalPath(root, sessionId);
  if (!safeSignal(file)) return false;
  let handle: number | null = null;
  try {
    handle = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return false;
    fs.ftruncateSync(handle, 0);
    fs.writeSync(handle, `${generation}:${randomBytes(16).toString('hex')}`);
    fs.fsyncSync(handle);
    return true;
  } catch { return false; } finally { if (handle !== null) fs.closeSync(handle); }
}
