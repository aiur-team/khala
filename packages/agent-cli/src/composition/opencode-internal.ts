import { homedir } from 'node:os';
import path from 'node:path';
import { OPENCODE_HARNESS, type SessionBinding } from '@khala/contracts/delivery/index';
import { isGrantedDescriptor } from '@khala/contracts/internal/descriptor';
import { INTERNAL_DISCOVERY_DESCRIPTOR_FILE } from '@khala/contracts/internal/discovery-descriptor';
import { installedOpenCodeCapabilities } from '@khala/harnesses/opencode/interactive';
import { openInbox } from '../cli/inbox.js';
import { MAX_SEND_BYTES, SendService } from '../cli/send.js';
import type { AgentClientPort } from '../cli/types.js';
import type { OpenCodeControls } from '../opencode/bridge.js';
import { type KhalaOpenCodeDependencies, openCodeVersionFromExecPath } from '../opencode/plugin.js';
import { openOpenCodeBridgeStore } from '../opencode/store.js';
import { type OpenGenerationInbox, deliveringInbox } from './delivering-inbox.js';
import { createInternalClient, readInternalDescriptor } from './internal.js';
import { type InternalActivationOutcome, restoreInternalGrant } from './internal-activation.js';
import { type InternalDelivery, createInternalDelivery } from './internal-delivery.js';
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
//
// Capabilities are launch-scoped, and OpenCode outlives `khala internal --resume`. When the
// held binding's capability is refused, the plugin restores that same binding from the
// session's activation journal, as a later `join` would, and keeps pulling. A binding the
// server refuses to restore, such as one Stop revoked, is never tried again.

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

/** Restore outcomes the server will not change: the binding ended, so pulling ends too. */
const FINAL: ReadonlySet<InternalActivationOutcome> = new Set(['revoked', 'denied', 'expired']);

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
  /** The binding each session last held, and every binding the server refused to restore. */
  const lastHeld = new Map<string, string>();
  const unrestorable = new Set<string>();
  const restoring = new Map<string, Promise<InternalActivationOutcome>>();

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

  /** Restores `bindingId` for the session after its capability was refused; one attempt at a time. */
  const restore = (sessionID: string, bindingId: string): Promise<InternalActivationOutcome> => {
    if (unrestorable.has(bindingId)) return Promise.resolve('revoked');
    let running = restoring.get(bindingId);
    if (running === undefined) {
      running = restoreInternalGrant({
        descriptorPath: path.join(path.dirname(grants({ harness: OPENCODE_HARNESS, sessionId: sessionID })), INTERNAL_DISCOVERY_DESCRIPTOR_FILE),
        bindingId,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }).catch(() => 'unavailable' as const).then(outcome => {
        if (FINAL.has(outcome)) unrestorable.add(bindingId);
        return outcome;
      }).finally(() => restoring.delete(bindingId));
      restoring.set(bindingId, running);
    }
    return running;
  };

  /** Pulls as `delivery` does, restoring the binding once when its capability is refused. */
  const restoringDelivery = (sessionID: string, delivery: InternalDelivery): InternalDelivery => ({
    async pull(held, open, signal) {
      const pulled = await delivery.pull(held, open, signal);
      if (pulled !== 'revoked') return pulled;
      const restored = await restore(sessionID, held.bindingId);
      if (restored === 'connected') return delivery.pull(held, open, signal);
      return FINAL.has(restored) ? 'revoked' : 'unavailable';
    },
  });

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
        if (sessionID === null) return UNBOUND;
        const heldBinding = async () => {
          const client = selectedClient();
          if (client === null) return null;
          const status = await client.status();
          const held = status.connected ? status.binding : null;
          // The server binds the session's digest; only this session's own binding is served.
          return held === null || held.harness !== OPENCODE_HARNESS
            || held.sessionId !== internalSessionDigest(OPENCODE_HARNESS, sessionID) ? null : { client, held };
        };
        let bound = await heldBinding();
        const last = lastHeld.get(sessionID);
        if (bound === null && last !== undefined && await restore(sessionID, last) === 'connected') bound = await heldBinding();
        if (bound === null) return UNBOUND;
        const { client, held } = bound;
        lastHeld.set(sessionID, held.bindingId);
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
      const delivering = deliveringInbox(openGeneration, restoringDelivery(binding.sessionId, createInternalDelivery({
        descriptorPath: grants({ harness: OPENCODE_HARNESS, sessionId: binding.sessionId }),
        stateDirectory,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      })), options.pullIntervalMs === undefined ? {} : { intervalMs: options.pullIntervalMs });
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
