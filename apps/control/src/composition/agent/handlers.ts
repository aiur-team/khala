import type { ReceiptKind } from '@khala/contracts/delivery/index';
import { decodeRoomId, type RoomId } from '@khala/contracts/messaging/ids';
import type { RouteRegistration } from '../../runtime/handler';

export type AgentAuthorization = 'allowed' | 'unauthenticated' | 'forbidden';
export type AgentStatusSnapshot = Readonly<{
  generation: number;
  agents: readonly Readonly<{
    participantId: string;
    displayName: string;
    ownerDisplayName: string;
    connection: 'connected' | 'stale' | 'offline' | 'unknown';
    routeLabel: string;
    lastReceipt: Readonly<{ kind: ReceiptKind; observedAt: string }> | null;
    installCommand: string;
  }>[];
}>;

export type AgentHandlerDependencies = Readonly<{
  authorize(request: Request, roomId: RoomId): Promise<AgentAuthorization>;
  status: Readonly<{ snapshot(roomId: RoomId, signal: AbortSignal): Promise<AgentStatusSnapshot> }>;
  /** Request-lifetime live pairing registrations supplied by the composition root. */
  pairing?: () => readonly RouteRegistration[];
}>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

const unavailableStatus: RouteRegistration = Object.freeze({
  path: '/api/agent/status',
  methods: Object.freeze(['GET']),
  async handle() {
    return json(503, { code: 'feature_unavailable' });
  },
});

function unavailablePairing(path: string): RouteRegistration {
  return Object.freeze({
    path,
    methods: Object.freeze(['POST']),
    async handle() {
      return json(503, { v: 1, kind: 'rejected', code: 'feature_unavailable' });
    },
  });
}

const unavailablePairingRoutes = Object.freeze([
  unavailablePairing('/api/agent/pairing/claim'),
  unavailablePairing('/api/agent/pairing/result'),
]);

function project(snapshot: AgentStatusSnapshot): AgentStatusSnapshot {
  return {
    generation: snapshot.generation,
    agents: snapshot.agents.map(agent => ({
      participantId: agent.participantId,
      displayName: agent.displayName,
      ownerDisplayName: agent.ownerDisplayName,
      connection: agent.connection,
      routeLabel: agent.routeLabel,
      lastReceipt: agent.lastReceipt === null ? null : {
        kind: agent.lastReceipt.kind,
        observedAt: agent.lastReceipt.observedAt,
      },
      installCommand: agent.installCommand,
    })),
  };
}

export function registerAgentHandlers(dependencies?: AgentHandlerDependencies): readonly RouteRegistration[] {
  if (!dependencies) return Object.freeze([unavailableStatus, ...unavailablePairingRoutes]);
  const status: RouteRegistration = Object.freeze({
    path: '/api/agent/status',
    methods: Object.freeze(['GET']),
    async handle(request) {
      const rawRoomId = new URL(request.url).searchParams.get('roomId');
      const room = decodeRoomId(rawRoomId);
      if (!room.ok) return json(400, { code: 'invalid_request' });
      const authorization = await dependencies.authorize(request, room.value);
      if (authorization === 'unauthenticated') return json(401, { code: 'unauthenticated' });
      if (authorization !== 'allowed') return json(403, { code: 'forbidden' });
      return json(200, project(await dependencies.status.snapshot(room.value, request.signal)));
    },
  });
  return Object.freeze([status, ...(dependencies.pairing?.() ?? unavailablePairingRoutes)]);
}
