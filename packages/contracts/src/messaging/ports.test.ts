// Contract fakes showing the port semantics consumers rely on. The fakes are
// test-only; they document behaviour every adapter must reproduce.

import { describe, expect, it } from 'vitest';
import intro from '../../fixtures/messaging/exact-intro.json';
import type { Admission, AdmissionPort } from './admission';
import type { EventRef, MessageContent } from './events';
import type { IdentityPort, IdentityState } from './identity';
import type { DeviceId, RoomId } from './ids';
import { type Disposer, type OperationResult, isCurrentGeneration, ok, outcomeUnknown, rejected, unavailable } from './outcomes';
import type { RoomPort, RoomRejection, RoomSnapshot, SendState } from './rooms';

const roomDemo = 'room_demo' as RoomId;

describe('RoomPort.send', () => {
  // A transport that accepted the write remotely but whose response never arrived locally.
  function slowRoomPort(remote: Map<string, EventRef>): Pick<RoomPort, 'send'> {
    return {
      send: ({ clientTxnId }, options) => new Promise<OperationResult<SendState, RoomRejection>>(resolve => {
        remote.set(clientTxnId, intro.eventRef as EventRef);
        options?.signal?.addEventListener('abort', () => resolve(outcomeUnknown(clientTxnId)), { once: true });
      }),
    };
  }

  it('reports an aborted wait as outcome_unknown, not cancellation', async () => {
    const remote = new Map<string, EventRef>();
    const controller = new AbortController();
    const pending = slowRoomPort(remote).send(
      { roomId: roomDemo, clientTxnId: 'txn_intro_1', content: intro.content as MessageContent },
      { signal: controller.signal },
    );
    controller.abort();
    expect(await pending).toEqual({ kind: 'outcome_unknown', operationId: 'txn_intro_1' });
    expect(remote.has('txn_intro_1')).toBe(true);
  });
});

describe('RoomPort.observe', () => {
  it('lets consumers ignore snapshots from a stale lifecycle generation', () => {
    const listeners = new Set<(snapshot: RoomSnapshot) => void>();
    const observe = (_roomId: RoomId, listener: (snapshot: RoomSnapshot) => void): Disposer => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    const room = { roomId: roomDemo, title: null, membership: 'joined' as const, revision: 'rev_1' };
    const currentGeneration = 1;
    const applied: RoomSnapshot[] = [];
    const dispose = observe(roomDemo, snapshot => {
      if (isCurrentGeneration(currentGeneration, snapshot)) applied.push(snapshot);
    });
    for (const generation of [0, 1]) listeners.forEach(listener => listener({ room, items: [], snapshotRevision: `s${generation}`, generation }));
    dispose();
    dispose();
    listeners.forEach(listener => listener({ room, items: [], snapshotRevision: 's2', generation: 1 }));
    expect(applied.map(snapshot => snapshot.snapshotRevision)).toEqual(['s1']);
  });
});

describe('IdentityPort', () => {
  it('keeps unavailable distinct from signed out', async () => {
    const port: IdentityPort = {
      current: async () => ({ kind: 'unavailable', retryable: true }),
      beginSignIn: async () => rejected('invalid_return_path'),
      signOut: async () => ok(null),
    };
    const state: IdentityState = await port.current();
    expect(state.kind).toBe('unavailable');
    expect(state.kind).not.toBe('signed_out');
  });
});

describe('AdmissionPort.admit', () => {
  it('is stable on retry: a repeated admission reports already_joined for the same room', async () => {
    const joined = new Set<string>();
    const port: Pick<AdmissionPort, 'admit'> = {
      admit: async ({ deviceId }) => {
        const outcome: Admission['outcome'] = joined.has(deviceId) ? 'already_joined' : 'joined';
        joined.add(deviceId);
        return ok({ outcome, room: { roomId: roomDemo, title: null, membership: 'joined', revision: 'rev_2' } });
      },
    };
    const input = { operationId: 'op_admit_1', inviteRef: 'invite_7', deviceId: 'device_browser_b' as DeviceId };
    const first = await port.admit(input);
    const retry = await port.admit(input);
    expect(first.kind === 'ok' && first.value.outcome).toBe('joined');
    expect(retry.kind === 'ok' && retry.value).toEqual({ outcome: 'already_joined', room: { roomId: 'room_demo', title: null, membership: 'joined', revision: 'rev_2' } });
  });
});

describe('OperationResult', () => {
  it('distinguishes every outcome kind', () => {
    expect([ok(1), rejected('forbidden'), unavailable(), outcomeUnknown('op_1')].map(result => result.kind))
      .toEqual(['ok', 'rejected', 'unavailable', 'outcome_unknown']);
  });
});
