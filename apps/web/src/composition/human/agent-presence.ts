import {
  RECEIPT_KINDS,
  type ReceiptKind,
} from '@khala/contracts/delivery/index';
import {
  decodeParticipantId,
  type ParticipantId,
  type RoomId,
} from '@khala/contracts/messaging/ids';
import type {
  AgentConnectionState,
  AgentPresence,
  AgentPresenceSnapshot,
  ChannelUiPort,
} from '../../features/channel/ports';

type TimerHandle = unknown;

export type ChannelUiCompositionOptions = Readonly<{
  fetch: typeof globalThis.fetch;
  endpoint?: string;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  setInterval?: (callback: () => void, milliseconds: number) => TimerHandle;
  clearInterval?: (handle: TimerHandle) => void;
  setTimeout?: (callback: () => void, milliseconds: number) => TimerHandle;
  clearTimeout?: (handle: TimerHandle) => void;
}>;

/** @deprecated Use `ChannelUiCompositionOptions`. Kept through the first tagged release containing #163. */
export type RoomUiCompositionOptions = ChannelUiCompositionOptions;

const CONNECTIONS: readonly AgentConnectionState[] = ['connected', 'stale', 'offline', 'unknown'];
const AGENT_KEYS = [
  'participantId', 'displayName', 'ownerDisplayName', 'connection', 'routeLabel', 'lastReceipt', 'installCommand',
] as const;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function visibleText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
    && !/[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/.test(value);
}

function receipt(value: unknown): Readonly<{ kind: ReceiptKind; observedAt: string }> | null | undefined {
  if (value === null) return null;
  if (!object(value) || !exactKeys(value, ['kind', 'observedAt'])) return undefined;
  if (typeof value.kind !== 'string' || !(RECEIPT_KINDS as readonly string[]).includes(value.kind)) return undefined;
  if (!visibleText(value.observedAt) || Number.isNaN(Date.parse(value.observedAt))) return undefined;
  return { kind: value.kind as ReceiptKind, observedAt: value.observedAt };
}

function decodeSnapshot(value: unknown): Readonly<{
  snapshot: AgentPresenceSnapshot;
  commands: readonly Readonly<{ participantId: ParticipantId; command: string }>[];
}> {
  if (!object(value) || !exactKeys(value, ['generation', 'agents'])
    || !Number.isSafeInteger(value.generation) || (value.generation as number) < 0 || !Array.isArray(value.agents)) {
    throw new TypeError('invalid_agent_status');
  }
  const commands: { participantId: ParticipantId; command: string }[] = [];
  const agents: AgentPresence[] = value.agents.map(raw => {
    if (!object(raw) || !exactKeys(raw, AGENT_KEYS)) throw new TypeError('invalid_agent_status');
    const participant = decodeParticipantId(raw.participantId);
    const lastReceipt = receipt(raw.lastReceipt);
    if (!participant.ok || !visibleText(raw.displayName) || !visibleText(raw.ownerDisplayName)
      || typeof raw.connection !== 'string' || !(CONNECTIONS as readonly string[]).includes(raw.connection)
      || !visibleText(raw.routeLabel) || lastReceipt === undefined || !visibleText(raw.installCommand)) {
      throw new TypeError('invalid_agent_status');
    }
    commands.push({ participantId: participant.value, command: raw.installCommand });
    return {
      participantId: participant.value,
      displayName: raw.displayName,
      ownerDisplayName: raw.ownerDisplayName,
      connection: raw.connection as AgentConnectionState,
      routeLabel: raw.routeLabel,
      lastReceipt,
    };
  });
  return { snapshot: { generation: value.generation as number, agents }, commands };
}

/** Browser adapter for the authenticated, content-free agent status route. */
export function createChannelUiPort(options: ChannelUiCompositionOptions): ChannelUiPort {
  const endpoint = options.endpoint ?? '/api/agent/status';
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const schedule = options.setInterval ?? ((callback, milliseconds) => globalThis.setInterval(callback, milliseconds));
  const cancel = options.clearInterval ?? (handle => globalThis.clearInterval(handle as number));
  const scheduleOnce = options.setTimeout ?? ((callback, milliseconds) => globalThis.setTimeout(callback, milliseconds));
  const cancelOnce = options.clearTimeout ?? (handle => globalThis.clearTimeout(handle as number));
  const commands = new Map<ParticipantId, string>();
  const snapshots = new Map<RoomId, AgentPresenceSnapshot>();

  async function agents(roomId: RoomId, signal: AbortSignal): Promise<AgentPresenceSnapshot> {
    const separator = endpoint.includes('?') ? '&' : '?';
    const response = await options.fetch(`${endpoint}${separator}roomId=${encodeURIComponent(roomId)}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal,
    });
    if (!response.ok) throw new Error('agent_status_unavailable');
    let body: unknown;
    try { body = await response.json(); } catch { throw new TypeError('invalid_agent_status'); }
    const decoded = decodeSnapshot(body);
    for (const item of decoded.commands) commands.set(item.participantId, item.command);
    snapshots.set(roomId, decoded.snapshot);
    return decoded.snapshot;
  }

  return {
    agents,
    subscribeAgents(roomId, listener) {
      const abort = new AbortController();
      let disposed = false;
      let inFlight = false;
      const refresh = () => {
        if (disposed || inFlight) return;
        inFlight = true;
        const request = new AbortController();
        const abortRequest = () => request.abort();
        abort.signal.addEventListener('abort', abortRequest, { once: true });
        const timeout = scheduleOnce(abortRequest, requestTimeoutMs);
        void agents(roomId, request.signal).then(snapshot => {
          if (!disposed) listener(snapshot);
        }, () => {
          const previous = snapshots.get(roomId);
          if (!disposed && previous) {
            listener({
              generation: previous.generation,
              agents: previous.agents.map(agent => ({
                ...agent,
                connection: agent.connection === 'connected' ? 'unknown' : agent.connection,
              })),
            });
          }
        }).finally(() => {
          cancelOnce(timeout);
          abort.signal.removeEventListener('abort', abortRequest);
          inFlight = false;
        });
      };
      const timer = schedule(refresh, pollIntervalMs);
      return () => {
        if (disposed) return;
        disposed = true;
        abort.abort();
        cancel(timer);
      };
    },
    async installCommand(participantId, signal) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      const command = commands.get(participantId);
      if (!command) throw new Error('install_command_unavailable');
      return command;
    },
  };
}

/** @deprecated Use `createChannelUiPort`. Kept through the first tagged release containing #163. */
export const createRoomUiPort = createChannelUiPort;
