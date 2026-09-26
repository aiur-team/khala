// The wired internal-mode system for the security suite: the real SQLite channel
// store, loopback channel server and release feed (apps/internal), and the real
// agent CLI with its descriptor-backed client, inbox and delivery (@aiur/khala),
// composed as `cli/main.ts` composes them. Nothing here is a mock port; only the
// clock and identifiers are fixed, and every process runs in this test worker.
//
// The agent starts on the fixture's Bob binding. `stop` and `admit` replay what the owner's
// Stop and a fresh channel-access admission record, so a probe can run as a re-admitted
// binding: the world's bearer and descriptor always name the binding currently held.

import fs from 'node:fs';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { EventId, ParticipantId, RoomId } from '@khala/contracts/messaging/index';
import { encodeInternalDescriptor } from '@khala/contracts/internal/descriptor';
import { composeBindingControl } from '../../../apps/internal/src/composition/binding-control/index';
import { composeBindingModes } from '../../../apps/internal/src/composition/binding-modes/index';
import { FakeHostedProvider } from '../../../apps/internal/src/composition/fixtures/make-external-provider';
import { composeMakeExternal } from '../../../apps/internal/src/composition/make-external';
import { createInternalReleaseFeed } from '../../../apps/internal/src/composition/internal-delivery/release-feed';
import { startChannelServer } from '../../../apps/internal/src/server/channel-server';
import type { ChannelStore } from '../../../apps/internal/src/store/channel-store';
import { createDiscoveryStore } from '../../../apps/internal/src/store/discovery-store';
import { createReceiptReadModel } from '../../../apps/internal/src/store/receipts';
import { type BindingCredential, mintCredential } from '../../../apps/internal/src/server/credentials';
import {
  type ChannelFixture, alice, aliceDevice, bobBinding, channelId, createChannelFixture, otherChannelId,
} from '../../../apps/internal/src/server/fixtures/channel-fixture';
import type { LogEvent, LoopbackServer } from '../../../apps/internal/src/server/server';
import { runCli } from '../../../packages/agent-cli/src/cli/app';
import { openInbox } from '../../../packages/agent-cli/src/cli/inbox';
import type { CliDependencies } from '../../../packages/agent-cli/src/cli/types';
import { createInternalClient } from '../../../packages/agent-cli/src/composition/internal';
import { createInternalDelivery } from '../../../packages/agent-cli/src/composition/internal-delivery';
import { createUnavailableClient } from '../../../packages/agent-cli/src/composition/unavailable';

export { bobBinding, channelId, otherChannelId };

export const NOW = Date.parse('2026-09-25T00:00:00.000Z');

export type CliRun = Readonly<{ code: number; out: string; err: string }>;

export type InternalWorld = Readonly<{
  fixture: ChannelFixture;
  root: string;
  /** Server state (channel store), agent state (inbox) and the descriptor live under here. */
  serverState: string;
  agentState: string;
  descriptorPath: string;
  logs: LogEvent[];
  server: LoopbackServer;
  pause: { value: boolean };
  /** The held binding's bearer, as the agent's descriptor carries it. */
  readonly bearer: string;
  /** The binding the agent currently holds. */
  binding(): SessionBinding;
  /** The owner's Stop of the held binding: its generation is revoked and nothing is held. */
  stop(): void;
  /**
   * Admits the agent to its channel through channel access again, as a fresh binding with its
   * own capability and descriptor. `none` shares no earlier history; `shared` shares it all.
   */
  admit(history: 'none' | 'shared'): SessionBinding;
  /** A human message in `channel`, stored by the real channel store. */
  say(channel: RoomId, body: string): EventId;
  /** Runs the agent CLI as installed, optionally against the descriptor, with stdin. */
  khala(args: readonly string[], options?: Readonly<{ descriptor?: boolean; stdin?: string; abortAfterMs?: number; client?: 'internal' | 'unavailable' }>): Promise<CliRun>;
  /** One HTTP request to the loopback server. */
  http(method: string, route: string, options?: Readonly<{ bearer?: string | null; body?: unknown; origin?: boolean }>): Promise<Readonly<{ status: number; body: string }>>;
  /** One GET with the agent binding, path sent byte for byte (no client-side normalization). */
  raw(route: string): Promise<Readonly<{ status: number; body: string }>>;
  /** Opens a streaming GET, runs `during` while it is open, and returns what streamed within `ms`. */
  stream(route: string, during: () => void, ms: number): Promise<Readonly<{ status: number; body: string }>>;
  close(): Promise<void>;
}>;

/** Re-admissions a world can hold after the fixture's binding, each with a capability minted up front. */
const ADMISSIONS = 2;

export async function startInternalWorld(options: Readonly<{
  /** Wraps the store the server and release feed read, to compose a deliberately wrong read path. */
  store?: (store: ChannelStore) => ChannelStore;
}> = {}): Promise<InternalWorld> {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'kha138-internal-'));
  const fixture = createChannelFixture({ root, now: NOW });
  const logs: LogEvent[] = [];
  const pause = { value: false };
  const modes = composeBindingModes({ handle: fixture.handle, store: fixture.store });
  const agentState = path.join(root, 'agent-state');
  const descriptorPath = path.join(root, 'descriptor.json');
  let id = 0;
  const store = options.store ? options.store(fixture.store) : fixture.store;
  // The capabilities are known to the server from the start, and authenticate once admission records their binding.
  const admissions: BindingCredential[] = Array.from({ length: ADMISSIONS }, (_, index) => ({
    credential: mintCredential(),
    binding: { ...bobBinding, bindingId: `binding-bob-admitted-${index + 1}` as SessionBinding['bindingId'] },
    channels: [channelId],
  }));
  const server = await startChannelServer({
    store,
    bootstrap: [fixture.bootstrap],
    bindings: [fixture.bob, ...admissions],
    // Composed as the launcher composes it (`composeBindingModes`), plus this world's own pause switch.
    releases: createInternalReleaseFeed({
      store,
      listeningModes: modes.listeningModes,
      paused: binding => (pause.value ? true : modes.pause.read(binding)),
    }),
    bindingModes: modes.control,
    newId: () => `id-${++id}`,
    clock: () => NOW,
    log: event => logs.push(event),
    receipts: createReceiptReadModel(fixture.handle),
    // Composed as the launcher composes it, so the human-only Stop route is mounted and probed.
    stop: composeBindingControl({ handle: fixture.handle, root: path.join(root, 'state') }),
    // The launcher does not mount Make external yet. The real journey over the real store
    // is composed here so its human-only routes are mounted and probed; only the hosted
    // side is the journey's own test provider, which the agent binding never reaches.
    makeExternal: (() => {
      const hosted = new FakeHostedProvider();
      return composeMakeExternal({
        handle: fixture.handle, hosted, sessions: hosted, access: hosted, bindings: hosted, signIn: hosted,
        destinationUrl: hosted.destinationUrl,
      }).journey;
    })(),
    startPort: 0,
  });
  const transportCapability = mintCredential();
  let held: BindingCredential | null = fixture.bob;
  const holding = (): BindingCredential => {
    if (!held) throw new Error('the agent holds no binding');
    return held;
  };
  const writeDescriptor = (credential: BindingCredential) => fs.writeFileSync(descriptorPath, encodeInternalDescriptor({
    v: 1, channelId, origin: server.origin, transportCapability,
    grantRef: `grant-${credential.binding.bindingId}`, bindingId: credential.binding.bindingId, bindingCapability: credential.credential,
  }), { mode: 0o600 });
  writeDescriptor(fixture.bob);
  const discovery = createDiscoveryStore(fixture.handle);

  let sent = 0;
  const say = (channel: RoomId, body: string): EventId => {
    const eventId = `event-${++sent}` as EventId;
    const result = fixture.store.send({
      channelId: channel, eventId, authorParticipantId: alice.participantId as ParticipantId, authorDeviceId: aliceDevice,
      clientTxnId: `txn-${sent}`, content: { v: 1, kind: 'text', body }, receivedAt: new Date(NOW + sent).toISOString(),
    });
    if (result.kind !== 'stored') throw new Error(`fixture send: ${result.kind}`);
    return eventId;
  };

  const khala: InternalWorld['khala'] = async (args, options = {}) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const chunks = { out: '', err: '' };
    stdout.on('data', chunk => { chunks.out += String(chunk); });
    stderr.on('data', chunk => { chunks.err += String(chunk); });
    const stdin = new PassThrough();
    stdin.end(options.stdin ?? '');
    const abort = new AbortController();
    const timer = options.abortAfterMs === undefined ? null : setTimeout(() => abort.abort(), options.abortAfterMs);
    const deps: CliDependencies = {
      client: options.client === 'internal' ? await createInternalClient({ descriptorPath }) : createUnavailableClient(),
      listeningMode: null,
      inbox: (bindingId, generation) => openInbox({
        stateDirectory: agentState, bindingId, generation, maxPayloadBytes: 64 * 1024, maxSelectionEvents: 32,
      }),
      stdin, stdout, stderr, signal: abort.signal, env: {}, cwd: root,
      internalClient: async descriptor => createInternalClient({ descriptorPath: descriptor }),
      internalDelivery: async descriptor => createInternalDelivery({ descriptorPath: descriptor, stateDirectory: agentState }),
    };
    try {
      const code = await runCli(options.descriptor ? ['--internal-descriptor', descriptorPath, ...args] : args, deps);
      return { code, ...chunks };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const http: InternalWorld['http'] = async (method, route, options = {}) => {
    const bearer = options.bearer === undefined ? holding().credential : options.bearer;
    const response = await fetch(`${server.origin}${route}`, {
      method,
      headers: {
        ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.origin ? { origin: server.origin } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return { status: response.status, body: await response.text() };
  };

  const raw: InternalWorld['raw'] = route => new Promise((resolve, reject) => {
    const { hostname, port } = new URL(server.origin);
    const request = httpRequest({
      host: hostname, port, method: 'GET', path: route, headers: { authorization: `Bearer ${holding().credential}` },
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on('error', reject);
    request.end();
  });

  const stream: InternalWorld['stream'] = async (route, during, ms) => {
    const abort = new AbortController();
    const response = await fetch(`${server.origin}${route}`, {
      headers: { authorization: `Bearer ${holding().credential}` }, signal: abort.signal,
    });
    let body = '';
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    const reading = (async () => {
      try {
        for (;;) {
          const chunk = await reader?.read();
          if (!chunk || chunk.done) return;
          body += decoder.decode(chunk.value, { stream: true });
        }
      } catch {
        // Aborted: the stream was read for as long as the probe needed.
      }
    })();
    during();
    await new Promise(resolve => setTimeout(resolve, ms));
    abort.abort();
    await reading;
    return { status: response.status, body };
  };

  return {
    fixture, root, serverState: path.join(root, 'state'), agentState, descriptorPath, logs, server, pause,
    get bearer() { return holding().credential; },
    binding: () => holding().binding,
    stop() {
      if (fixture.store.revokeBinding(holding().binding).kind !== 'done') throw new Error('fixture stop');
      held = null;
    },
    admit(history) {
      const next = admissions.shift();
      if (!next) throw new Error('no admission left in this world');
      const admitted = discovery.activate({
        operationKey: `admission-${next.binding.bindingId}`, binding: next.binding, channelId, sessionGeneration: 1, history,
      });
      if (admitted.kind !== 'activated') throw new Error(`fixture admission: ${admitted.kind}`);
      held = next;
      writeDescriptor(next);
      return next.binding;
    },
    say, khala, http, raw, stream,
    async close() {
      await server.close();
      fixture.dispose();
    },
  };
}
