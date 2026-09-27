import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SessionBinding } from '@khala/contracts/messaging/index';
import type { MatrixDeviceSession } from '@khala/connector/bootstrap/ports';
import { afterEach, describe, expect, it } from 'vitest';
import { createMatrixBootstrapDevice } from './bootstrap-device';
import type { MatrixConnectorInput, MatrixConnectorSubstrate } from './matrix';

let state: string | null = null;
afterEach(async () => { if (state) await rm(state, { recursive: true, force: true }); state = null; });

const token = 'a'.repeat(64);
const matrix = (deviceId: string): MatrixDeviceSession => ({
  baseUrl: 'https://matrix.example', userId: '@agent:example', deviceId,
  accessToken: token, roomId: '!room:example', ownerUserId: '@owner:example', ownerParticipantId: `human_${'b'.repeat(40)}`,
});
const binding = (deviceId: string): SessionBinding => ({
  v: 1, bindingId: 'binding-1', ownerId: 'owner-1', agentParticipantId: 'agent-1',
  deviceId, harness: 'claude', sessionId: 'already-running', generation: 0,
}) as SessionBinding;

describe('Matrix endpoint credential and device fence', () => {
  it('reserves before admission, stores the endpoint token privately, and reopens the exact SDK identity', async () => {
    state = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-matrix-device-'));
    const opens: MatrixConnectorInput[] = [];
    let activated = false;
    const open = async (input: MatrixConnectorInput): Promise<MatrixConnectorSubstrate> => {
      opens.push(input);
      return {
        fingerprint: 'signed-ed25519-fingerprint',
        devices: {
          reserve: async () => ({ kind: 'reserved', deviceId: input.deviceId }),
          activate: async () => { activated = true; return { kind: 'ready' }; },
          status: async () => activated ? 'ready' : 'incomplete',
        },
        source: { authorize: async () => 'ok', listen: () => () => undefined,
          read: async () => ({ kind: 'page', events: [], nextCursor: '', caughtUp: true }) },
        send: async () => ({ eventId: '$event:example.test' }),
        trustPeer: async () => undefined, removeOwnDevice: async () => 'removed', close: async () => undefined,
      };
    };
    const options = { stateDirectory: state, profileDirectory: path.join(state, 'crypto'), open };
    const first = createMatrixBootstrapDevice(options);
    const fixed = await first.devices.reserve('operation-123');
    expect(fixed.kind).toBe('reserved');
    if (fixed.kind !== 'reserved') return;
    expect(await first.devices.status(fixed.deviceId)).toBe('unavailable');
    const session = matrix(fixed.deviceId);
    const active = await first.devices.activate({
      deviceId: fixed.deviceId, binding: binding(fixed.deviceId),
      capability: { token, scope: ['publish_own', 'receive_released', 'ack_delivery'], bindingId: 'binding-1', generation: 0, expiresAt: Date.now() + 60_000 },
      operationId: 'operation-123', matrixSession: session,
    });
    expect(active).toEqual({ kind: 'ready' });
    expect(first.fingerprint()).toBe('signed-ed25519-fingerprint');
    expect(opens[0]?.participantIdFor('@owner:example')).toBe(session.ownerParticipantId);
    expect(opens[0]?.participantIdFor('@stranger:example')).toBeNull();
    const credential = path.join(state, 'matrix-session.json');
    expect(JSON.parse(await readFile(credential, 'utf8'))).toEqual(session);
    expect((await stat(credential)).mode & 0o777).toBe(0o600);
    await first.close();
    const reopened = createMatrixBootstrapDevice(options);
    expect(await reopened.devices.reserve('operation-123')).toEqual(fixed);
    expect(await reopened.devices.status(fixed.deviceId)).toBe('ready');
    expect(opens).toHaveLength(2);
    expect(opens[1]?.accessToken).toBe(token);
    expect(await reopened.devices.activate({
      deviceId: fixed.deviceId, binding: binding(fixed.deviceId),
      capability: { token, scope: ['publish_own', 'receive_released', 'ack_delivery'], bindingId: 'binding-1', generation: 0, expiresAt: Date.now() + 60_000 },
      operationId: 'operation-123', matrixSession: { ...session, accessToken: 'c'.repeat(64) },
    })).toEqual({ kind: 'failed', reason: 'initialization_failed' });
    await reopened.close();
  });
});
