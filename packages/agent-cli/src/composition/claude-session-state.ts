import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { plainObject, validIdentifier } from '../cli/validation.js';
import {
  MAX_RETAINED, nextRetained, type ClaudeSessionStatePort, type EnvelopeStep, type RetainedToken, type SessionScope,
} from './claude-session.js';

const MAX_STATE_BYTES = 4096;

/**
 * The local Khala server's durable `ClaudeSessionStatePort`. The server process is
 * the only writer, so an in-process queue per session scope linearizes calls from
 * every hook and command process; the files make retained tokens survive a server
 * restart. Each (principal, binding) is one owner-only file named by a digest of
 * that pair, holding at most one token per generation.
 *
 * Tokens are cleared only after the call that carried them resolves and reports
 * them committed. A crash in between keeps them, and the next agent call replays
 * them; the shared contract answers a replayed acknowledgement with `duplicate`.
 */
export async function openClaudeSessionState(directory: string): Promise<ClaudeSessionStatePort> {
  if (!path.isAbsolute(directory)) throw new TypeError('claude session state: directory must be absolute');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()
    || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw new Error('claude session state: unsafe directory');
  }
  await chmod(directory, 0o700);

  const queues = new Map<string, Promise<unknown>>();

  return {
    envelope<T>(key: SessionScope, call: (retained: readonly RetainedToken[]) => Promise<EnvelopeStep<T>>): Promise<T> {
      const name = scopeKey(key);
      const run = async (): Promise<T> => {
        const file = path.join(directory, `${name}.json`);
        const retained = await load(file, key);
        const step = await call(retained);
        const next = nextRetained(retained, step);
        // The call already happened; failing to persist must not hide its result (an
        // accepted send would look retryable). A kept token replays as `duplicate`;
        // a lost one leaves its batch outstanding, so the batch replays.
        if (!sameTokens(retained, next)) await save(directory, file, key, next).catch(() => undefined);
        return step.value;
      };
      const previous = queues.get(name) ?? Promise.resolve();
      const next = previous.then(run, run);
      const settled = next.catch(() => undefined);
      queues.set(name, settled);
      void settled.then(() => { if (queues.get(name) === settled) queues.delete(name); });
      return next;
    },
  };
}

function scopeKey(key: SessionScope): string {
  return createHash('sha256')
    .update(JSON.stringify(['khala.claude-session-state.v2', key.principalId, key.bindingId]))
    .digest('hex');
}

function sameTokens(a: readonly RetainedToken[], b: readonly RetainedToken[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry.generation === b[index]!.generation && entry.token === b[index]!.token);
}

async function load(file: string, key: SessionScope): Promise<readonly RetainedToken[]> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  try {
    const buffer = Buffer.alloc(MAX_STATE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    return bytesRead <= MAX_STATE_BYTES ? decode(buffer.subarray(0, bytesRead), key) : [];
  } finally {
    await handle.close();
  }
}

function decode(bytes: Buffer, key: SessionScope): readonly RetainedToken[] {
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!plainObject(value) || value.v !== 2 || value.principalId !== key.principalId || value.bindingId !== key.bindingId
      || !Array.isArray(value.tokens) || value.tokens.length > MAX_RETAINED) return [];
    const tokens: RetainedToken[] = [];
    for (const entry of value.tokens as unknown[]) {
      if (!plainObject(entry) || !Number.isSafeInteger(entry.generation) || (entry.generation as number) < 0
        || !validIdentifier(entry.token) || tokens.some(seen => seen.generation === entry.generation)) return [];
      tokens.push({ generation: entry.generation as number, token: entry.token });
    }
    return tokens;
  } catch { return []; }
}

async function save(directory: string, file: string, key: SessionScope, tokens: readonly RetainedToken[]): Promise<void> {
  if (tokens.length === 0) {
    await rm(file, { force: true });
    await syncDirectory(directory);
    return;
  }
  const temporary = path.join(directory, `.${randomBytes(8).toString('hex')}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(JSON.stringify({ v: 2, principalId: key.principalId, bindingId: key.bindingId, tokens }));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
  await syncDirectory(directory);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
