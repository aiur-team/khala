import type {
  DeliveryReceipt,
  HarnessCapabilities,
  ParticipantId,
  SessionBinding,
} from '@khala/contracts/delivery/index';
import type { RoomId } from '@khala/contracts/messaging/ids';
import type { ConnectorRuntime } from '../../runtime/create';
import type { RuntimeStatus } from '../../runtime/status';

export type PresenceConnection = 'connected' | 'stale' | 'offline' | 'unknown';

export type AgentPresenceSnapshot = Readonly<{
  generation: number;
  agents: readonly Readonly<{
    participantId: ParticipantId;
    displayName: string;
    ownerDisplayName: string;
    connection: PresenceConnection;
    routeLabel: string;
    lastReceipt: Readonly<{ kind: DeliveryReceipt['kind']; observedAt: string }> | null;
    installCommand: string;
  }>[];
}>;

export interface AgentPresenceMetadataPort {
  identity(binding: SessionBinding, signal: AbortSignal): Promise<Readonly<{
    roomId: RoomId;
    displayName: string;
    ownerDisplayName: string;
  }> | null>;
  lastReceipt(binding: SessionBinding, signal: AbortSignal): Promise<DeliveryReceipt | null>;
  installCommand(binding: SessionBinding, signal: AbortSignal): Promise<string>;
  subscribe(listener: () => void): () => void;
}

export interface AgentPresenceSource {
  snapshot(roomId: RoomId, signal: AbortSignal): Promise<AgentPresenceSnapshot>;
  subscribe(listener: () => void): () => void;
}

export type AgentPresenceOptions = Readonly<{
  now?: () => Date;
  staleAfterMs?: number;
}>;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** The one command the channel panel hands to an agent; follow-on route setup is capability-driven. */
export function agentInstallCommand(channelLink: string): string {
  let parsed: URL;
  try { parsed = new URL(channelLink); } catch { throw new TypeError('invalid_channel_link'); }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') {
    throw new TypeError('invalid_channel_link');
  }
  return `khala connect ${shellQuote(parsed.href)}`;
}

function routeLabel(capabilities: HarnessCapabilities | null, harnessReady: boolean): string {
  if (!harnessReady || !capabilities || capabilities.support === 'unsupported') return 'Unsupported';
  switch (capabilities.existingSession) {
    case 'native_cli_queue': return capabilities.harness === 'codex' ? 'Codex CLI' : `${capabilities.harness} CLI`;
    case 'khala_hosted_resume': return capabilities.harness === 'codex' ? 'Codex app-server' : 'Khala-hosted session';
    case 'agent_installed_listener': return 'Khala skill';
    default: return 'Unsupported';
  }
}

function connection(
  runtime: RuntimeStatus,
  lastReceipt: DeliveryReceipt | null,
  now: Date,
  staleAfterMs: number,
): PresenceConnection {
  if (runtime.phase === 'stopped' || runtime.prerequisites.subscription === 'offline') return 'offline';
  if (runtime.phase === 'ready'
    && runtime.prerequisites.subscription === 'ready'
    && runtime.prerequisites.harness === 'ready') {
    return 'connected';
  }
  if (!lastReceipt) return 'unknown';
  const observedAt = Date.parse(lastReceipt.observedAt);
  if (!Number.isFinite(observedAt)) return 'unknown';
  return now.getTime() - observedAt <= staleAfterMs ? 'stale' : 'offline';
}

/**
 * Projects the connector's current binding, selected capability and receipt
 * metadata into the browser-safe presence shape. Payload handles and pending
 * records are not accepted by this interface and cannot reach the projection.
 */
export function createAgentPresenceSource(
  runtime: ConnectorRuntime,
  metadata: AgentPresenceMetadataPort,
  options: AgentPresenceOptions = {},
): AgentPresenceSource {
  const now = options.now ?? (() => new Date());
  const staleAfterMs = options.staleAfterMs ?? 30_000;

  return {
    async snapshot(roomId, signal) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      const current = runtime.status();
      const binding = current.binding;
      if (!binding) return { generation: 0, agents: [] };
      const identity = await metadata.identity(binding, signal);
      if (!identity || identity.roomId !== roomId) return { generation: binding.generation, agents: [] };
      const [lastReceipt, installCommand] = await Promise.all([
        metadata.lastReceipt(binding, signal),
        metadata.installCommand(binding, signal),
      ]);
      return {
        generation: binding.generation,
        agents: [{
          participantId: binding.agentParticipantId,
          displayName: identity.displayName,
          ownerDisplayName: identity.ownerDisplayName,
          connection: connection(current, lastReceipt, now(), staleAfterMs),
          routeLabel: routeLabel(current.harnessCapabilities, current.prerequisites.harness === 'ready'),
          lastReceipt: lastReceipt === null ? null : {
            kind: lastReceipt.kind,
            observedAt: lastReceipt.observedAt,
          },
          installCommand,
        }],
      };
    },
    subscribe: listener => metadata.subscribe(listener),
  };
}
