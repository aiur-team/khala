import { museCliPath } from '../wake/muse-monitor';
import { Console } from 'node:console';
import type { Readable, Writable } from 'node:stream';
import type { Harness } from '@khala/contracts/m1/agent-join';
import { KhalaClientError, type KhalaAgentClient } from '../client';
import { codexStartupSessions } from './startup-sessions';
import { createToolRegistry } from './registry';
import { runMcpServer } from './server';
import { resolveHarness, resolveSession } from './session-id';
import { createKhalaTools } from './tools';
import { createRealClientFactory } from './wiring';
import { readStatus, sessionFiles } from '../state';
import { adapterFor } from '../harness';
import type { ResolvedSession } from '../harness/session-sources';

export type ClientFactory = (input: { harness: Harness; sessionId: string; rejoinable?: boolean }) => KhalaAgentClient;

export function createPlaceholderClient(): KhalaAgentClient {
  return {
    async join() { throw new KhalaClientError('link_unavailable'); },
    async status() { return { state: 'idle', unread: 0, listeningMode: 'sync' }; },
    async read() { throw new KhalaClientError('not_connected'); },
    async send() { throw new KhalaClientError('not_connected'); },
    async sendChannelEvent() { throw new KhalaClientError('not_connected'); },
    async leave() { throw new KhalaClientError('not_connected'); },
    async close() {},
  };
}

export async function runMcpCommand(argv: readonly string[], deps: {
  createClient: ClientFactory;
  env?: NodeJS.ProcessEnv;
  input?: Readable;
  output?: Writable;
  signal?: AbortSignal;
}): Promise<number> {
  const env = deps.env ?? process.env;
  const harness = resolveHarness(argv, env);
  if (harness === 'invalid') {
    process.stderr.write('khala: invalid --harness\n');
    return 2;
  }
  const clients = new Map<string, KhalaAgentClient>();
  const clientForSession = (session: ResolvedSession) => {
    const { sessionId, rejoinable } = session;
    const key = `${rejoinable}:${sessionId}`;
    let client = clients.get(key);
    if (client === undefined) {
      client = deps.createClient({ harness, sessionId, rejoinable });
      clients.set(key, client);
    }
    return client;
  };
  const startupSession = adapterFor(harness)?.restoreAtStartup ? await resolveSession(harness, undefined, env) : null;
  if (startupSession !== null) clientForSession(startupSession);
  else if (harness === 'codex' && env.CODEX_THREAD_ID === undefined) {
    for (const session of await codexStartupSessions(env)) clientForSession(session);
  }
  // Plugin hooks can identify a resumed session after MCP has already started.
  // Follow only the live parent's validated mapping, never a workspace guess.
  let stopped = false;
  let polling: Promise<void> | undefined;
  const restoreMappedSession = () => {
    if (stopped || polling) return;
    polling = (async () => {
      try {
        const session = await resolveSession(harness, undefined, env);
        if (!stopped && session) clientForSession(session);
      } catch { /* A late or unavailable hook mapping can be retried on the next poll. */ }
    })().finally(() => { polling = undefined; });
  };
  const restoreTimer = harness === 'opencode' ? setInterval(restoreMappedSession, 1_000) : undefined;
  restoreTimer?.unref();
  const tools = createKhalaTools({
    harness,
    museBin: museCliPath(env),
    ...(startupSession ? { museSessionId: startupSession.sessionId } : {}),
    async clientFor(meta) {
      const session = await resolveSession(harness, meta, env);
      return session === null ? null : clientForSession(session);
    },
  });
  try {
    await runMcpServer({ input: deps.input ?? process.stdin, output: deps.output ?? process.stdout, signal: deps.signal, tools: createToolRegistry(tools) });
  } finally {
    stopped = true;
    clearInterval(restoreTimer);
    await polling;
    await Promise.allSettled([...clients.values()].map(client => Promise.resolve().then(() => client.close())));
  }
  return 0;
}

export default async function main(argv: readonly string[]): Promise<number> {
  // SDK diagnostics must never share the JSON-RPC stream, including late logs.
  globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  const factory = createRealClientFactory(process.env);
  let cleanupFailed = false;
  let exitCode = 1;
  const createClient: ClientFactory = input => {
    const client = factory(input);
    return {
      ...client,
      async close() {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            (async () => {
              await client.close();
              const status = await readStatus(sessionFiles(input.harness, input.sessionId, process.env));
              if (status?.state !== 'disconnected' || status.detail !== 'closed') throw new Error('cleanup_not_closed');
            })(),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error('cleanup_timeout')), 5000);
            }),
          ]);
        } catch (error) {
          cleanupFailed = true;
          const code = error instanceof Error && ['cleanup_timeout', 'cleanup_not_closed'].includes(error.message)
            ? error.message : 'cleanup_failed';
          process.stderr.write(`khala: ${code}\n`);
          throw error;
        } finally { if (timer) clearTimeout(timer); }
      },
    };
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  try {
    const code = await runMcpCommand(argv, { createClient, signal: stop.signal });
    exitCode = cleanupFailed ? 1 : code;
    return exitCode;
  } finally {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    process.stdin.destroy();
    // CLI cleanup is finished; SDK request-deadline timers may still be alive.
    setImmediate(() => process.exit(exitCode));
  }
}
