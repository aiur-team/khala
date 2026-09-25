import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { plainObject, validIdentifier } from '../cli/validation.js';
import type { BatchTokenScope, ClaudeSessionStatePort, EnvelopeStep } from './claude-session.js';

const MAX_STATE_BYTES = 4096;

/**
 * The local Khala server's durable `ClaudeSessionStatePort`. The server process is
 * the only writer, so an in-process queue per scope linearizes calls from every
 * hook and command process; the files make a retained token survive a server
 * restart. Each scope is one owner-only file named by a digest of the scope, so a
 * token can only ever be attached to a call for the same principal, binding, and
 * generation.
 *
 * The token is durably removed before the call runs, so it is attached to exactly
 * one call even if the server stops mid-call; a lost token only replays its batch.
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
    envelope<T>(scope: BatchTokenScope, call: (retained: string | undefined) => Promise<EnvelopeStep<T>>): Promise<T> {
      const key = scopeKey(scope);
      const run = async (): Promise<T> => {
        const file = path.join(directory, `${key}.json`);
        const retained = await take(file, scope);
        const step = await call(retained);
        if (step.batchToken !== null) await store(directory, file, scope, step.batchToken);
        return step.value;
      };
      const previous = queues.get(key) ?? Promise.resolve();
      const next = previous.then(run, run);
      const settled = next.catch(() => undefined);
      queues.set(key, settled);
      void settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
      return next;
    },
  };
}

function scopeKey(scope: BatchTokenScope): string {
  return createHash('sha256')
    .update(JSON.stringify(['khala.claude-session-state.v1', scope.principalId, scope.bindingId, scope.generation]))
    .digest('hex');
}

async function take(file: string, scope: BatchTokenScope): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let token: string | undefined;
  try {
    const buffer = Buffer.alloc(MAX_STATE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    token = bytesRead <= MAX_STATE_BYTES ? decode(buffer.subarray(0, bytesRead), scope) : undefined;
  } finally {
    await handle.close();
  }
  // Remove before the call runs, whether or not the record was usable.
  await rm(file, { force: true });
  await syncDirectory(path.dirname(file));
  return token;
}

function decode(bytes: Buffer, scope: BatchTokenScope): string | undefined {
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (plainObject(value) && value.v === 1 && value.principalId === scope.principalId
      && value.bindingId === scope.bindingId && value.generation === scope.generation && validIdentifier(value.token)) {
      return value.token;
    }
  } catch { /* an unreadable record is no token */ }
  return undefined;
}

async function store(directory: string, file: string, scope: BatchTokenScope, token: string): Promise<void> {
  if (!validIdentifier(token)) return;
  const temporary = path.join(directory, `.${randomBytes(8).toString('hex')}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(JSON.stringify({ v: 1, ...scope, token }));
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
