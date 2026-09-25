import type { ParticipantId, RoomId } from '@khala/contracts/messaging/ids';
import { describe, expect, it, vi } from 'vitest';
import {
  createChannelUiPort,
  createRoomUiPort,
  type ChannelUiCompositionOptions,
  type RoomUiCompositionOptions,
} from './agent-presence';

describe('human channel composition', () => {
  it('keeps deprecated room composition aliases on the canonical implementation', () => {
    expect(createRoomUiPort).toBe(createChannelUiPort);
    const options = null as unknown as RoomUiCompositionOptions;
    expect(options as ChannelUiCompositionOptions).toBeNull();
  });

  it('decodes presence and keeps install commands out of the public agent snapshot', async () => {
    const fetchStatus = vi.fn(async () => new Response(JSON.stringify({
      generation: 7,
      agents: [{
        participantId: 'agent-1',
        displayName: 'Build agent',
        ownerDisplayName: 'Owner',
        connection: 'connected',
        routeLabel: 'Codex CLI',
        lastReceipt: { kind: 'harness_queued', observedAt: '2026-09-19T12:00:00.000Z' },
        installCommand: "khala connect 'https://khala.example/channel/link'",
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const port = createChannelUiPort({ fetch: fetchStatus });

    const snapshot = await port.agents('room-1' as RoomId, new AbortController().signal);

    expect(snapshot).toEqual({
      generation: 7,
      agents: [{
        participantId: 'agent-1',
        displayName: 'Build agent',
        ownerDisplayName: 'Owner',
        connection: 'connected',
        routeLabel: 'Codex CLI',
        lastReceipt: { kind: 'harness_queued', observedAt: '2026-09-19T12:00:00.000Z' },
      }],
    });
    await expect(port.installCommand('agent-1' as ParticipantId, new AbortController().signal))
      .resolves.toBe("khala connect 'https://khala.example/channel/link'");
    expect(fetchStatus).toHaveBeenCalledOnce();
  });

  it('fails closed on malformed or content-bearing status responses', async () => {
    const port = createChannelUiPort({
      fetch: async () => new Response(JSON.stringify({
        generation: 1,
        agents: [{
          participantId: 'agent-1',
          displayName: 'Agent',
          ownerDisplayName: 'Owner',
          connection: 'connected',
          routeLabel: 'Codex CLI',
          lastReceipt: null,
          installCommand: 'khala connect link',
          payload: 'pending plaintext',
        }],
      })),
    });

    await expect(port.agents('room-1' as RoomId, new AbortController().signal)).rejects.toThrow('invalid_agent_status');
  });

  it('rejects an invalid connection state', async () => {
    const port = createChannelUiPort({
      fetch: async () => new Response(JSON.stringify({
        generation: 1,
        agents: [{
          participantId: 'agent-1',
          displayName: 'Agent',
          ownerDisplayName: 'Owner',
          connection: 'connecting',
          routeLabel: 'Codex CLI',
          lastReceipt: null,
          installCommand: 'khala connect link',
        }],
      })),
    });

    await expect(port.agents('room-1' as RoomId, new AbortController().signal)).rejects.toThrow('invalid_agent_status');
  });

  it('rejects invisible and bidi control characters in presence labels', async () => {
    const port = createChannelUiPort({
      fetch: async () => new Response(JSON.stringify({
        generation: 1,
        agents: [{
          participantId: 'agent-1',
          displayName: 'Owner\u202EAgent',
          ownerDisplayName: 'Owner',
          connection: 'connected',
          routeLabel: 'Codex CLI',
          lastReceipt: null,
          installCommand: 'khala connect link',
        }],
      })),
    });

    await expect(port.agents('room-1' as RoomId, new AbortController().signal)).rejects.toThrow('invalid_agent_status');
  });

  it('publishes increasing snapshots to subscribers and stops polling after unsubscribe', async () => {
    let generation = 0;
    const callbacks: Array<() => void> = [];
    const clearInterval = vi.fn();
    const port = createChannelUiPort({
      fetch: async () => new Response(JSON.stringify({ generation: ++generation, agents: [] })),
      setInterval(callback) { callbacks.push(callback); return callbacks.length; },
      clearInterval,
    });
    const listener = vi.fn();
    const unsubscribe = port.subscribeAgents('room-1' as RoomId, listener);

    callbacks[0]!();
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith({ generation: 1, agents: [] }));
    unsubscribe();
    expect(clearInterval).toHaveBeenCalledOnce();
  });

  it('keeps polling single-flight and degrades a cached connected snapshot after timeout', async () => {
    const intervalCallbacks: Array<() => void> = [];
    const timeoutCallbacks: Array<() => void> = [];
    let calls = 0;
    const port = createChannelUiPort({
      fetch: async (_input, init) => {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify({
            generation: 1,
            agents: [{
              participantId: 'agent-1',
              displayName: 'Agent',
              ownerDisplayName: 'Owner',
              connection: 'connected',
              routeLabel: 'Codex CLI',
              lastReceipt: null,
              installCommand: 'khala connect link',
            }],
          }));
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
      },
      setInterval(callback) { intervalCallbacks.push(callback); return intervalCallbacks.length; },
      clearInterval() {},
      setTimeout(callback) { timeoutCallbacks.push(callback); return timeoutCallbacks.length; },
      clearTimeout() {},
    });
    await port.agents('room-1' as RoomId, new AbortController().signal);
    const listener = vi.fn();
    const unsubscribe = port.subscribeAgents('room-1' as RoomId, listener);

    intervalCallbacks[0]!();
    intervalCallbacks[0]!();
    expect(calls).toBe(2);
    timeoutCallbacks[0]!();
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      agents: [expect.objectContaining({ connection: 'unknown' })],
    })));
    unsubscribe();
  });
});
