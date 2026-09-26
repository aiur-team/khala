// Live `AgentControlsUiPort` for one of the human's agent bindings (KHA-135). It reads
// the connector's owner-scoped controls status and submits versioned policy commands
// over the protected controls transport. Owner authority never appears here: the
// injected client is the authenticated transport, and the connector derives authority
// from its session, never from a request body.
//
// Successful transport is not effect. An answer is a `PolicyAck` the connector built
// after its dispatch ledger committed (or refused) the revision; a lost answer rejects,
// so the panel shows the outcome as unknown and retries with the same command identity.

import {
  type BindingId, type ListeningModeCommand, type ListeningModeResult, type OwnerRouteGrantCommand, type PolicyAck,
  type PolicySetCommand, decodePolicyAck,
} from '@khala/contracts/delivery/index';
import type { Disposer } from '@khala/contracts/messaging/index';
import type { AgentControlsSnapshot, AgentControlsUiPort, RouteGrantAck } from '../../features/agent-controls/ports';
import { type ControlsObservation, type ControlsStatus, decodeControlsStatus, projectControls, toAgentControlsSnapshot } from './projection';

/**
 * The protected human controls transport. `lost` means the request may have reached
 * the connector and its answer is unknown; it is never a definite refusal.
 */
export interface ControlsClient {
  status(bindingId: BindingId, signal: AbortSignal): Promise<
    | Readonly<{ kind: 'ok'; body: unknown }>
    | Readonly<{ kind: 'refused'; code: 'forbidden' | 'unavailable' }>
    | Readonly<{ kind: 'lost' }>
  >;
  /** Deliberately takes no signal: closing a browser wait is not cancellation. */
  setPolicy(command: PolicySetCommand): Promise<Readonly<{ kind: 'answered'; body: unknown }> | Readonly<{ kind: 'lost' }>>;
}

export type BrowserAgentControlsPortOptions = Readonly<{
  client: ControlsClient;
  bindingId: BindingId;
  /** Status refresh interval while observed. Defaults to 5 s; 0 disables polling. */
  refreshMs?: number;
  /** A status read unanswered after this long is treated as lost. Defaults to 10 s. */
  statusTimeoutMs?: number;
}>;

export type BrowserAgentControlsPort = AgentControlsUiPort & Readonly<{
  /** Content-free view of the last status, or null before one arrived. */
  observation(): ControlsObservation | null;
  dispose(): void;
}>;

/** The binding's connector could not be reached, or its answer could not be trusted. */
export class ControlsUnavailableError extends Error {
  constructor(readonly code: 'forbidden' | 'unavailable' | 'lost') {
    super(`controls ${code}`);
  }
}

export function createBrowserAgentControlsPort(options: BrowserAgentControlsPortOptions): BrowserAgentControlsPort {
  const { client, bindingId } = options;
  const statusTimeoutMs = options.statusTimeoutMs ?? 10_000;
  const listeners = new Set<(snapshot: AgentControlsSnapshot) => void>();
  let status: ControlsStatus | null = null;
  let connection: AgentControlsSnapshot['connection'] = 'unknown';
  let request = 0;
  let inFlight: AbortController | null = null;
  let disposed = false;

  function publish(): AgentControlsSnapshot | null {
    if (status === null) return null;
    const snapshot = toAgentControlsSnapshot(status, connection);
    if (!disposed) for (const listener of [...listeners]) listener(snapshot);
    return snapshot;
  }

  /** Reads the status. Only the newest read may publish; an older answer is dropped. */
  async function read(): Promise<AgentControlsSnapshot> {
    if (disposed) throw new ControlsUnavailableError('unavailable');
    const token = ++request;
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    // A hung read would hold `inFlight` and stop polling for good, so it is abandoned as lost.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<{ kind: 'lost' }>(resolve => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve({ kind: 'lost' });
      }, statusTimeoutMs);
    });
    const answer = await Promise.race([
      client.status(bindingId, controller.signal).catch(() => ({ kind: 'lost' as const })),
      expired,
    ]);
    clearTimeout(timeout);
    if (token === request) inFlight = null;
    if (disposed) throw new ControlsUnavailableError('unavailable');
    if (token !== request) {
      // Superseded: answer with the newest known state rather than an older one.
      if (status === null) throw new ControlsUnavailableError('lost');
      return toAgentControlsSnapshot(status, connection);
    }
    if (answer.kind === 'ok') {
      const decoded = decodeControlsStatus(answer.body, bindingId);
      if (decoded === null) throw new ControlsUnavailableError('unavailable');
      // A status for an older binding generation never replaces a newer one.
      if (status !== null && decoded.binding.generation < status.binding.generation) {
        return toAgentControlsSnapshot(status, connection);
      }
      status = decoded;
      connection = 'connected';
      return publish()!;
    }
    // Refused or unreachable: the last enforced values stay, labelled offline, never refreshed
    // by guess, and subscribers stop showing the connection as live.
    connection = 'offline';
    if (answer.kind === 'refused') {
      publish();
      throw new ControlsUnavailableError(answer.code);
    }
    const kept = publish();
    if (kept === null) throw new ControlsUnavailableError('lost');
    return kept;
  }

  const refreshMs = options.refreshMs ?? 5_000;
  const timer = refreshMs > 0 ? setInterval(() => {
    if (listeners.size > 0 && inFlight === null) void read().catch(() => undefined);
  }, refreshMs) : null;
  (timer as { unref?: () => void } | null)?.unref?.();

  async function submitPolicy(command: PolicySetCommand): Promise<PolicyAck> {
    if (disposed || command.bindingId !== bindingId) throw new ControlsUnavailableError('unavailable');
    const answer = await client.setPolicy(command).catch(() => ({ kind: 'lost' as const }));
    // A lost answer publishes nothing: a fresh snapshot would clear the panel's
    // same-command retry, which is the only safe next step for an unknown outcome.
    if (answer.kind === 'lost') throw new ControlsUnavailableError('lost');
    // Answered commands refresh the authoritative status even if nobody waits for them.
    void read().catch(() => undefined);
    const decoded = decodePolicyAck(answer.body);
    // A malformed or mismatched answer may still follow a write: unknown, never success.
    if (!decoded.ok) throw new ControlsUnavailableError('lost');
    const ack = decoded.value;
    if (ack.commandId !== command.commandId || ack.bindingId !== command.bindingId) {
      throw new ControlsUnavailableError('lost');
    }
    return ack;
  }

  return {
    readSnapshot(requested) {
      if (requested !== bindingId) return Promise.reject(new ControlsUnavailableError('forbidden'));
      return read();
    },

    subscribe(requested, listener): Disposer {
      if (disposed || requested !== bindingId) return () => undefined;
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    submitPolicy,

    // The hosted controls transport serves no owner listening-mode route. The panel's
    // listening section stays hidden (`listening: null`), so this is a refusal, never a write.
    async submitListeningMode(command: ListeningModeCommand): Promise<ListeningModeResult> {
      return {
        v: 1, commandId: command.commandId, bindingId: command.bindingId, generation: command.expectedBindingGeneration,
        outcome: 'refused', version: command.expectedVersion, requested: command.requested, effective: null,
        reason: 'unavailable',
      };
    },

    async submitRouteGrant(command: OwnerRouteGrantCommand): Promise<RouteGrantAck> {
      return { commandId: command.commandId, outcome: 'refused', reason: 'unavailable' };
    },

    observation: () => (status === null ? null : projectControls(status, connection)),

    dispose() {
      if (disposed) return;
      disposed = true;
      inFlight?.abort();
      if (timer !== null) clearInterval(timer);
      listeners.clear();
    },
  };
}
