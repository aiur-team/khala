import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultHumanColor } from '@khala/contracts/m1/colors';
import { base64url, LOCAL_IDLE_EXIT_MS, LOCAL_LINK_TTL_MS, LOCAL_OWNER_USER_ID } from '@khala/contracts/m1/local';
import { StateError, writeJsonAtomic } from '../state';
import { KHALA_AGENT_VERSION } from '../version';
import { resolveLocalOwnerName } from './identity';
import { helperPaths, readHelperFile } from './lifecycle';
import { LocalStoreError, openLocalStore, type OpenedLocalStore } from './store';
import { createHelperServer, type HelperServer } from './http';
import { agentJoinRoutes } from './routes/agent-join';
import { roomRoutes } from './routes/rooms';
import { ownerRoutes, serial } from './routes/owner';
import { profileRoutes } from './routes/profile';

export type RunHelperOptions = {
  env?: NodeJS.ProcessEnv; port?: number; webDir?: string; idleMs?: number; signal?: AbortSignal;
  now?: () => number; random?: (bytes: number) => Uint8Array; stderr?: (line: string) => void;
};
export function defaultWebDir(): string {
  return fileURLToPath(new URL('../../../../apps/web/dist-local/', import.meta.url));
}
const hash = (token: string) => createHash('sha256').update(token).digest();

export async function runHelper(options: RunHelperOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const random = options.random ?? randomBytes;
  const stderr = options.stderr ?? (line => { process.stderr.write(line); });
  let store: OpenedLocalStore | undefined;
  let server: HelperServer | undefined;
  let boundPort: number | undefined;
  let stop!: () => void;
  const stopped = new Promise<void>(resolve => { stop = resolve; });
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const paths = helperPaths(env);
    const port = options.port ?? paths.port;
    const idleValue = env.KHALA_LOCAL_IDLE_MS;
    const idleMs = options.idleMs ?? (idleValue && /^\d+$/u.test(idleValue) && Number.isSafeInteger(Number(idleValue)) && Number(idleValue) > 0 ? Number(idleValue) : LOCAL_IDLE_EXIT_MS);
    const webDir = options.webDir ?? (env.KHALA_LOCAL_WEB_DIR && path.isAbsolute(env.KHALA_LOCAL_WEB_DIR) ? env.KHALA_LOCAL_WEB_DIR : defaultWebDir());
    store = await openLocalStore({ root: paths.root, ownerDefault: {
      v: 1, initials: null, username: await resolveLocalOwnerName(env), color: defaultHumanColor(LOCAL_OWNER_USER_ID), updatedAt: new Date(now()).toISOString(),
    }, now, random });
    const localStore = store;
    const adminToken = base64url(random(32));
    const adminHash = hash(adminToken);
    const sessions = new Set<string>();
    const openTokens = new Map<string, { roomId?: string; expiresAt: number }>();
    const queue = serial();
    server = createHelperServer({
      port, webDir, idleMs, onIdle: stop,
      routes: [...agentJoinRoutes(), ...roomRoutes(), ...ownerRoutes({ queue }), ...profileRoutes({ queue })],
      authenticateCookie: value => sessions.has(value),
      authenticateBearer: token => {
        if (timingSafeEqual(hash(token), adminHash)) return { kind: 'owner', via: 'admin' };
        const agent = localStore.agentForToken(token);
        return agent ? { kind: 'agent', ...agent } : { kind: 'none' };
      },
      createContext: origin => ({
        store: localStore, origin, now, random, version: KHALA_AGENT_VERSION, joins: new Map(),
        mintOpenToken(roomId) {
          const token = base64url(random(32));
          const expiresAt = now() + LOCAL_LINK_TTL_MS;
          openTokens.set(hash(token).toString('hex'), { ...(roomId === undefined ? {} : { roomId }), expiresAt });
          return { token, expiresAt: new Date(expiresAt).toISOString() };
        },
        consumeOpenToken(token) {
          const key = hash(token).toString('hex');
          const entry = openTokens.get(key);
          openTokens.delete(key);
          return !entry || entry.expiresAt <= now() ? null : entry.roomId === undefined ? {} : { roomId: entry.roomId };
        },
        createOwnerSession() { const token = base64url(random(32)); sessions.add(token); return token; },
        shutdown() { shutdownTimer ??= setTimeout(stop, 25); },
      }),
    });
    let bound: { port: number; origin: string };
    try { bound = await server.listen(); }
    catch (error) {
      await store.close();
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });
          if (response.status === 200 && (await response.json()).ok === true) return 0;
          await response.body?.cancel();
        } catch { /* An unrelated listener must not move our port. */ }
        stderr('{"error":"port_in_use"}\n');
      } else stderr('{"error":"listen_failed"}\n');
      return 1;
    }
    boundPort = bound.port;
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) stop();
    await store.setOwner(store.owner());
    await writeJsonAtomic(paths.helperFile, { v: 1, pid: process.pid, ...bound, adminToken, version: KHALA_AGENT_VERSION, startedAt: new Date(now()).toISOString() });
    await stopped;
    return 0;
  } catch (error) {
    stderr(JSON.stringify({ error: error instanceof StateError || error instanceof LocalStoreError ? error.code : 'internal_error' }) + '\n');
    return 1;
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    options.signal?.removeEventListener('abort', stop);
    if (shutdownTimer) clearTimeout(shutdownTimer);
    let cleanupFailed = false;
    try { await server?.close(); } catch { cleanupFailed = true; }
    try { await store?.close(); } catch { cleanupFailed = true; }
    try {
      if (boundPort !== undefined) {
        const file = await readHelperFile(env);
        if (file?.pid === process.pid && file.port === boundPort) await unlink(helperPaths(env).helperFile);
      }
    } catch { cleanupFailed = true; }
    if (cleanupFailed) { stderr('{"error":"storage_failed"}\n'); return 1; }
  }
}
