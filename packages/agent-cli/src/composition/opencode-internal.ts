import { homedir } from 'node:os';
import path from 'node:path';
import { OPENCODE_HARNESS, type SessionBinding } from '@khala/contracts/delivery/index';
import { isGrantedDescriptor } from '@khala/contracts/internal/descriptor';
import { installedOpenCodeCapabilities } from '@khala/harnesses/opencode/interactive';
import { openInbox } from '../cli/inbox.js';
import { MAX_SEND_BYTES, SendService } from '../cli/send.js';
import type { AgentClientPort } from '../cli/types.js';
import type { OpenCodeControls } from '../opencode/bridge.js';
import { type KhalaOpenCodeDependencies, openCodeVersionFromExecPath } from '../opencode/plugin.js';
import { openOpenCodeBridgeStore } from '../opencode/store.js';
import { type OpenGenerationInbox, deliveringInbox } from './delivering-inbox.js';
import { createInternalClient, readInternalDescriptor } from './internal.js';
import { createInternalDelivery } from './internal-delivery.js';
import { internalSessionDigest } from './internal-session.js';
import { LOCAL_DELIVERY_LIMITS } from './local-harness-capabilities.js';
import { sessionGrants } from './session-grant.js';

// The installed OpenCode plugin's live composition over local internal-mode state. An
// OpenCode session becomes bound when its agent joins a channel, which leaves that
// session's own grant at `discovery/<principal>/grant.json`. The plugin serves the session
// its hooks and tools come from, and only through that session's grant: it never falls
// back to the launcher's `active.json` or to another session's grant. One OpenCode
// process serves one bound session at a time, the most recent one that holds a grant.
//
// While a binding generation is held, releases are pulled from the internal server into
// that generation's inbox, and the plugin holds the inbox's listener. The owner sees the
// same route claim the plugin projects its mode through, derived from the OpenCode version.

export type InternalOpenCodeOptions = Readonly<{
  /** The private Khala state root: `internal/` and every inbox live below it. */
  stateDirectory: string;
  /** The running OpenCode version; defaults to the one in the executable path, else unknown. */
  version?: string | null;
  fetch?: typeof globalThis.fetch;
  /** How often a held binding generation pulls the internal server's releases. */
  pullIntervalMs?: number;
}>;

const UNBOUND: OpenCodeControls = { binding: null, paused: false, mode: null };

/** `$XDG_STATE_HOME/khala`, the root the `khala` CLI and the internal launcher use. */
export function khalaStateDirectory(env: NodeJS.ProcessEnv): string {
  return path.resolve(env.XDG_STATE_HOME ?? path.join(homedir(), '.local/state'), 'khala');
}

export function internalOpenCodeDependencies(options: InternalOpenCodeOptions): KhalaOpenCodeDependencies {
  const { stateDirectory } = options;
  const version = options.version === undefined ? openCodeVersionFromExecPath(process.execPath) : options.version;
  const grants = sessionGrants(path.join(stateDirectory, 'internal'));
  const clients = new Map<string, AgentClientPort>();
  let selected: string | null = null;

  /** The session's own granted descriptor, or null when it holds no live grant. */
  const grantOf = (sessionID: string): string | null => {
    let file: string;
    try { file = grants({ harness: OPENCODE_HARNESS, sessionId: sessionID }); } catch { return null; }
    const read = readInternalDescriptor(file);
    return read.ok && isGrantedDescriptor(read.value) ? file : null;
  };

  const clientOf = (file: string): AgentClientPort => {
    let client = clients.get(file);
    if (client === undefined) {
      client = createInternalClient({
        descriptorPath: file,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        capabilities: async binding => binding.harness === OPENCODE_HARNESS
          ? installedOpenCodeCapabilities(version, LOCAL_DELIVERY_LIMITS) : null,
        // The plugin is the route, so there is no hook review to report.
        observation: async () => version === null ? null : { version, hookReview: 'unknown' },
      });
      clients.set(file, client);
    }
    return client;
  };

  const selectedClient = (): AgentClientPort | null => {
    const file = selected === null ? null : grantOf(selected);
    return file === null ? null : clientOf(file);
  };

  const send = new SendService({
    async connect() { return { kind: 'unavailable' }; },
    async send(input, signal) {
      const client = selectedClient();
      return client === null ? { kind: 'refused', code: 'not_connected', clientTxnId: input.clientTxnId } : client.send(input, signal);
    },
    async status() { return { v: 1, connected: false, binding: null, route: 'unknown', sourceCursor: null }; },
    async listChannels() { return { kind: 'unavailable' }; },
    async listAgents() { return { kind: 'unavailable' }; },
  });

  // The delivering inbox passes the recorder that writes this generation's receipts on the server.
  const openGeneration: OpenGenerationInbox = (bindingId, generation, inboxOptions) => openInbox({
    stateDirectory, bindingId, generation, maxPayloadBytes: MAX_SEND_BYTES, maxSelectionEvents: 32,
    ...(inboxOptions?.recordAcknowledgement === undefined ? {} : { recordAcknowledgement: inboxOptions.recordAcknowledgement }),
  });

  return {
    version,
    observeSession(sessionID) {
      if (sessionID !== selected && grantOf(sessionID) !== null) selected = sessionID;
    },
    controls: {
      async read() {
        const sessionID = selected;
        const client = selectedClient();
        if (sessionID === null || client === null) return UNBOUND;
        const status = await client.status();
        const held = status.connected ? status.binding : null;
        // The server binds the session's digest; only this session's own binding is served.
        if (held === null || held.harness !== OPENCODE_HARNESS
          || held.sessionId !== internalSessionDigest(OPENCODE_HARNESS, sessionID)) return UNBOUND;
        let mode: OpenCodeControls['mode'] = null;
        try {
          const current = await client.listeningMode?.();
          if (current?.bindingId === held.bindingId && current.generation === held.generation) mode = current.effective;
        } catch {
          mode = null;
        }
        // The bridge addresses OpenCode by its own session ID. A pause holds the server's
        // releases, so nothing new reaches the inbox while paused.
        return { binding: { ...held, sessionId: sessionID } as SessionBinding, paused: false, mode };
      },
    },
    send,
    async openBatch(binding) {
      const delivering = deliveringInbox(openGeneration, createInternalDelivery({
        descriptorPath: grants({ harness: OPENCODE_HARNESS, sessionId: binding.sessionId }),
        stateDirectory,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }), options.pullIntervalMs === undefined ? {} : { intervalMs: options.pullIntervalMs });
      try {
        const listener = await (await delivering.inbox(binding.bindingId, binding.generation)).acquireListener();
        return {
          readBatch: input => listener.readBatch(input),
          nextWake: () => listener.nextWake(),
          async release() {
            await listener.release().catch(() => undefined);
            await delivering.stop();
          },
        };
      } catch (error) {
        await delivering.stop();
        throw error;
      }
    },
    openStore: binding => openOpenCodeBridgeStore({ stateDirectory, bindingId: binding.bindingId, generation: binding.generation }),
  };
}
