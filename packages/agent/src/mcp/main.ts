import { Console } from 'node:console';
import type { Readable, Writable } from 'node:stream';
import type { Harness } from '@khala/contracts/m1/agent-join';
import { KhalaClientError, type KhalaAgentClient } from '../client';
import { createToolRegistry } from './registry';
import { runMcpServer } from './server';
import { resolveHarness, resolveSessionId } from './session-id';
import { createKhalaTools } from './tools';
import { createRealClientFactory } from './wiring';
import { TERMINAL_SESSION_DETAILS, readStatus, sessionFiles } from '../state';

export type ClientFactory = (input: { harness: Harness; sessionId: string }) => KhalaAgentClient;

export function createPlaceholderClient(): KhalaAgentClient {
  return {
    async join() { throw new KhalaClientError('link_unavailable'); },
    async status() { return { state: 'idle', unread: 0, listeningMode: 'sync' }; },
    async read() { throw new KhalaClientError('not_connected'); },
    async send() { throw new KhalaClientError('not_connected'); },
    async sendChannelEvent() { throw new KhalaClientError('not_connected'); },
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
  const clientForSession = (sessionId: string) => {
    let client = clients.get(sessionId);
    if (client === undefined) {
      client = deps.createClient({ harness, sessionId });
      clients.set(sessionId, client);
    }
    return client;
  };
  const startupSession = resolveSessionId(harness, undefined, env);
  if (startupSession !== null && harness !== 'cursor') clientForSession(startupSession);
  const tools = createKhalaTools({
    harness,
    clientFor(meta) {
      const sessionId = resolveSessionId(harness, meta, env);
      return sessionId === null ? null : clientForSession(sessionId);
    },
  });
  try {
    await runMcpServer({ input: deps.input ?? process.stdin, output: deps.output ?? process.stdout, signal: deps.signal, tools: createToolRegistry(tools) });
  } finally {
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
              if (status?.state !== 'disconnected' || status.detail !== 'closed' && !TERMINAL_SESSION_DETAILS.some(detail => detail === status.detail)) throw new Error('cleanup_not_closed');
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
