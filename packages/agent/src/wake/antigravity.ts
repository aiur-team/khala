import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { openSessionDir, readJson, writeJsonAtomic, ensureStateDir, SESSION_ID_PATTERN, type SessionFiles } from '../state';
import type { DeliverCodec } from '../harness/adapter';
import type { WakeDriver } from './driver';
import { readActivity } from '../activity';
import { resetWakeDriver } from './shared/nonce';

const file = 'antigravity-wake.json';
export const ANTIGRAVITY_REGISTER_HINT = 'Run khala wake register --harness antigravity through your own shell tool after khala_join and at every session start; repeat if the local server restarts. Never print or send the credential environment variables.';
type Credentials = { sessionId: string; address: string; token: string; command: string; rejected?: boolean };
const localAddress = (value: unknown): value is string => typeof value === 'string'
  && /^(?:localhost|127\.0\.0\.1|\[::1\]):([0-9]{1,5})$/u.test(value)
  && Number(value.slice(value.lastIndexOf(':') + 1)) > 0 && Number(value.slice(value.lastIndexOf(':') + 1)) <= 65535;
async function credentials(files: SessionFiles, sessionId: string): Promise<Credentials | null> {
  let value: Credentials | null;
  try {
    await ensureStateDir(files.dir);
    const stat = await fs.lstat(path.join(files.dir, file));
    if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) return null;
    value = await readJson<Credentials>(path.join(files.dir, file));
  } catch { return null; }
  return value && value.sessionId === sessionId && localAddress(value.address)
    && typeof value.token === 'string' && value.token.length > 0 && !/[\r\n\0]/u.test(value.token)
    && typeof value.command === 'string' && (path.isAbsolute(value.command) || value.command === 'agy') ? value : null;
}

/** Only agy's agent shell receives these variables; never return their values. */
export async function registerAntigravityWake(env: NodeJS.ProcessEnv): Promise<void> {
  const sessionId = env.ANTIGRAVITY_CONVERSATION_ID;
  const address = env.ANTIGRAVITY_LS_ADDRESS;
  const token = env.ANTIGRAVITY_CSRF_TOKEN;
  const command = env.ANTIGRAVITY_AGENTAPI_EXE || 'agy';
  if (!sessionId || !SESSION_ID_PATTERN.test(sessionId) || !localAddress(address) || !token
    || /[\r\n\0]/u.test(token) || !(path.isAbsolute(command) || command === 'agy')) throw new Error('antigravity_registration_unavailable');
  const files = await openSessionDir('antigravity', sessionId, env);
  await writeJsonAtomic(path.join(files.dir, file), { sessionId, address, token, command } satisfies Credentials);
  await resetWakeDriver(files.dir, 'antigravity-native');
}

export type AntigravityRun = (command: string, argv: readonly string[], env: NodeJS.ProcessEnv, signal: AbortSignal) => Promise<boolean>;
const run: AntigravityRun = (command, argv, env, signal) => new Promise(resolve => {
  // Buffer neither transcript nor stderr into diagnostics. A rejected token is a reason, never an exception dump.
  execFile(command, [...argv], { env, signal, timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true }, error => resolve(!error));
});
export function createAntigravityWakeDriver(execute: AntigravityRun = run): WakeDriver {
  return {
    id: 'antigravity-native', rung: 1, optIn: true, minIdleMs: 0, deadlineMs: 30_000, verification: 'nonce',
    async available(ctx) { const value = await credentials(ctx.files, ctx.sessionId); return !!value && !value.rejected; },
    async unavailableReason(ctx) {
      const value = await credentials(ctx.files, ctx.sessionId);
      return value?.rejected ? 'antigravity_credentials_rejected' : 'antigravity_credentials_missing';
    },
    async wake(ctx, line) {
      if (!/^Khala: channel messages are waiting\. Continue\. \(k-[0-9a-f]{8}\)$/u.test(line)) throw new Error('invalid_wake_line');
      const value = await credentials(ctx.files, ctx.sessionId);
      if (!value || value.rejected || ctx.signal.aborted || (await readActivity(ctx.files)).state !== 'idle') return 'skipped';
      let accepted = false;
      try {
        accepted = await execute(value.command, ['agentapi', 'send-message', ctx.sessionId, line],
          { ...ctx.env, ANTIGRAVITY_LS_ADDRESS: value.address, ANTIGRAVITY_CSRF_TOKEN: value.token }, ctx.signal);
      } catch { /* Child failures never expose env or stderr. */ }
      if (!accepted && !ctx.signal.aborted) {
        // Preserve a concurrent re-registration rather than marking the new token rejected.
        const current = await credentials(ctx.files, ctx.sessionId);
        if (current?.token === value.token && current.address === value.address) await writeJsonAtomic(path.join(ctx.files.dir, file), { ...value, rejected: true });
        return 'skipped';
      }
    },
  };
}

/** U28's native messages enter as SYSTEM_MESSAGE transcript steps, not hook prompt fields. */
export async function antigravityPromptText(input: NonNullable<ReturnType<DeliverCodec['parse']>>, _files: SessionFiles): Promise<string> {
  if (!input.transcriptPath) return '';
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(input.transcriptPath, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile()) return '';
    const length = Math.min(stat.size, 64 * 1024), start = stat.size - length;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    let tail = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) tail = tail.slice(tail.indexOf('\n') + 1);
    // Only system message content is evidence; channel frames and model/tool echoes cannot verify wakes.
    return tail.split('\n').flatMap(line => {
      try {
        const step = JSON.parse(line);
        if (step.source !== 'SYSTEM' || step.type !== 'SYSTEM_MESSAGE' || typeof step.content !== 'string') return [];
        return step.content.match(/Khala: channel messages are waiting\. Continue\. \(k-[0-9a-f]{8}\)/gu) ?? [];
      } catch { return []; }
    }).join('\n');
  } catch { return ''; }
  finally { await handle?.close().catch(() => {}); }
}
