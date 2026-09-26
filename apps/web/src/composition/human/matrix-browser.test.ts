import { describe, expect, it, vi } from 'vitest';
import { ClientEvent, EventType, Preset, Visibility, type MatrixClient } from 'matrix-js-sdk';
import { createMatrixRoomRequest, startMatrixClient } from './matrix-browser';

describe('Matrix browser safety boundaries', () => {
  it('creates encrypted invite-only rooms', () => {
    const request = createMatrixRoomRequest({ operationId: 'create_1', title: 'Private room' });

    expect(request.visibility).toBe(Visibility.Private);
    expect(request.preset).toBe(Preset.PrivateChat);
    expect(request.initial_state).toContainEqual({
      type: EventType.RoomEncryption,
      state_key: '',
      content: { algorithm: 'm.megolm.v1.aes-sha2' },
    });
  });

  it('stops a client whose initial sync fails', async () => {
    const stopClient = vi.fn();
    const listeners = new Map<string, (...args: never[]) => void>();
    const client = {
      on: vi.fn((event: string, listener: (...args: never[]) => void) => listeners.set(event, listener)),
      off: vi.fn((event: string) => listeners.delete(event)),
      startClient: vi.fn(async () => { throw new Error('sync failed'); }),
      stopClient,
    } as unknown as MatrixClient;

    await expect(startMatrixClient(client, new AbortController().signal)).rejects.toThrow('sync failed');
    expect(client.on).toHaveBeenCalledWith(ClientEvent.Sync, expect.any(Function));
    expect(stopClient).toHaveBeenCalledOnce();
  });
});
