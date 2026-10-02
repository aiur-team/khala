import { Console } from 'node:console';
import type { Readable, Writable } from 'node:stream';
import type { Harness } from '@khala/contracts/m1/agent-join';
import { KhalaClientError, type KhalaAgentClient } from '../client';
import { createToolRegistry } from './registry';
import { runMcpServer } from './server';
import { resolveHarness, resolveSessionId } from './session-id';
import { createKhalaTools } from './tools';
import { createRealClientFactory } from './wiring';

export type ClientFactory = (input: { harness: Harness; sessionId: string }) => KhalaAgentClient;

export function createPlaceholderClient(): KhalaAgentClient {
  return {
    async join() { throw new KhalaClientError('link_unavailable'); },
    async status() { return { state: 'idle', unread: 0 }; },
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
  const tools = createKhalaTools({
    harness,
    clientFor(meta) {
      const sessionId = resolveSessionId(harness, meta, env);
      if (sessionId === null) return null;
      let client = clients.get(sessionId);
      if (client === undefined) {
        client = deps.createClient({ harness, sessionId });
        clients.set(sessionId, client);
      }
      return client;
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
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  try {
    return await runMcpCommand(argv, { createClient: createRealClientFactory(process.env), signal: stop.signal });
  } finally {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    if (stop.signal.aborted) process.stdin.destroy();
  }
}
