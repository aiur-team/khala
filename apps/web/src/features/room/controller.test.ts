import { describe, expect, it, vi } from 'vitest';
import type { ParticipantId, RoomId } from '@khala/contracts/messaging/ids';
import { createRoomController } from './controller';
import type { AgentPresenceSnapshot, RoomUiPort } from './ports';

const roomId = 'room_1' as RoomId;
const scoutId = 'agent_scout' as ParticipantId;

function snapshot(generation: number, connection: 'connected' | 'offline'): AgentPresenceSnapshot {
  return {
    generation,
    agents: [{
      participantId: scoutId,
      displayName: 'Scout',
      ownerDisplayName: 'Mira',
      connection,
      routeLabel: connection === 'connected' ? 'Codex CLI' : 'Khala skill',
      lastReceipt: null,
    }],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('createRoomController', () => {
  it('subscribes before reading and does not let a late initial read replace a live snapshot', async () => {
    const initial = deferred<AgentPresenceSnapshot>();
    let listener: ((value: AgentPresenceSnapshot) => void) | null = null;
    const port: RoomUiPort = {
      agents: () => initial.promise,
      subscribeAgents: (_roomId, next) => {
        listener = next;
        return () => { listener = null; };
      },
      installCommand: async () => 'khala connect room-link',
    };
    const controller = createRoomController(port, { roomId, generation: 2 });

    listener!(snapshot(2, 'connected'));
    initial.resolve(snapshot(2, 'offline'));
    await initial.promise;
    await Promise.resolve();

    expect(controller.getSnapshot().agents[0]?.connection).toBe('connected');
    controller.dispose();
  });

  it('ignores another binding generation and loads onboarding only for disconnected agents', async () => {
    let listener: ((value: AgentPresenceSnapshot) => void) | null = null;
    const installCommand = vi.fn(async () => 'khala connect https://khala.example/room/1');
    const port: RoomUiPort = {
      agents: async () => snapshot(4, 'offline'),
      subscribeAgents: (_roomId, next) => {
        listener = next;
        return () => { listener = null; };
      },
      installCommand,
    };
    const controller = createRoomController(port, { roomId, generation: 4 });
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe('ready'));
    await vi.waitFor(() => expect(controller.getSnapshot().agents[0]?.installCommand).toContain('khala connect'));

    listener!(snapshot(3, 'connected'));
    expect(controller.getSnapshot().agents[0]?.connection).toBe('offline');
    expect(installCommand).toHaveBeenCalledOnce();
    expect(installCommand).toHaveBeenCalledWith(scoutId, expect.any(AbortSignal));
    controller.dispose();
  });

  it('keeps unsupported route copy intact and exposes install failures without hiding the agent', async () => {
    const port: RoomUiPort = {
      agents: async () => ({
        generation: 1,
        agents: [{
          participantId: scoutId,
          displayName: 'Scout',
          ownerDisplayName: 'Mira',
          connection: 'unknown',
          routeLabel: 'Unsupported',
          lastReceipt: null,
        }],
      }),
      subscribeAgents: () => () => {},
      installCommand: async () => { throw new Error('offline'); },
    };
    const controller = createRoomController(port, { roomId, generation: 1 });
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe('ready'));
    await vi.waitFor(() => expect(controller.getSnapshot().agents[0]?.installCommandError).toBe(true));

    expect(controller.getSnapshot().agents[0]?.routeLabel).toBe('Unsupported');
    expect(controller.getSnapshot().agents[0]?.displayName).toBe('Scout');
    controller.dispose();
  });

  it('retries a transient install command failure on the next presence snapshot', async () => {
    let listener: ((value: AgentPresenceSnapshot) => void) | null = null;
    const installCommand = vi.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce('khala connect recovered-link');
    const port: RoomUiPort = {
      agents: async () => snapshot(1, 'offline'),
      subscribeAgents: (_roomId, next) => {
        listener = next;
        return () => { listener = null; };
      },
      installCommand,
    };
    const controller = createRoomController(port, { roomId, generation: 1 });
    await vi.waitFor(() => expect(controller.getSnapshot().agents[0]?.installCommandError).toBe(true));

    listener!(snapshot(1, 'offline'));

    await vi.waitFor(() => expect(controller.getSnapshot().agents[0]?.installCommand).toBe('khala connect recovered-link'));
    expect(controller.getSnapshot().agents[0]?.installCommandError).toBe(false);
    expect(installCommand).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it('reports presence as unavailable when the initial read has another generation', async () => {
    const port: RoomUiPort = {
      agents: async () => snapshot(9, 'connected'),
      subscribeAgents: () => () => {},
      installCommand: async () => 'unused',
    };
    const controller = createRoomController(port, { roomId, generation: 1 });

    await vi.waitFor(() => expect(controller.getSnapshot()).toEqual({ phase: 'unavailable', agents: [] }));
    controller.dispose();
  });

  it('reports presence as unavailable when the initial read fails before any live snapshot', async () => {
    const port: RoomUiPort = {
      agents: async () => { throw new Error('presence offline'); },
      subscribeAgents: () => () => {},
      installCommand: async () => 'unused',
    };
    const controller = createRoomController(port, { roomId, generation: 1 });

    await vi.waitFor(() => expect(controller.getSnapshot()).toEqual({ phase: 'unavailable', agents: [] }));
    controller.dispose();
  });
});
