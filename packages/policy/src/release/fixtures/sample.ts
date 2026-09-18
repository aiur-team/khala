// Test-only builders. Digests are computed with the KHA-105 messaging codec so the
// policy re-derivation is checked against it rather than against itself.

import type {
  ApprovalCommand, AuthorizationId, BindingId, CausalRootId, CommandId, DeviceId, EventId, EventRef, OwnerAuthority,
  OwnerId, ParticipantId, ReleaseId, RoomId, SessionBinding,
} from '@khala/contracts/delivery/index';
import { digestMessageContent } from '@khala/contracts/messaging/index';
import type { EvaluateInput, PendingRecord, ReleaseContent } from '../types';

export const id = <T extends string>(value: string): T => value as T;

export const text = (body: string): ReleaseContent => ({ v: 1, kind: 'text', body });

export async function digest(body: string): Promise<string> {
  const result = await digestMessageContent(text(body));
  if (!result.ok) throw new Error('digest unavailable in test runtime');
  return result.digest;
}

export async function record(eventId: string, body: string, author = 'agent-a', device = 'dev-a'): Promise<PendingRecord> {
  const ref: EventRef = {
    v: 1,
    roomId: id<RoomId>('room-1'),
    eventId: id<EventId>(eventId),
    authorParticipantId: id<ParticipantId>(author),
    authorDeviceId: id<DeviceId>(device),
    contentDigest: await digest(body),
  };
  return { ref, content: text(body) };
}

export const authority = (ownerId = 'owner-b'): OwnerAuthority => ({
  ownerId: id<OwnerId>(ownerId),
  issuer: 'https://issuer.example',
  subject: 'subject-b',
  authenticatedAt: '2026-09-18T00:00:00Z',
  authorizationId: id<AuthorizationId>('authz-1'),
});

export const binding = (generation = 0): SessionBinding => ({
  v: 1,
  bindingId: id<BindingId>('bind-b-1'),
  ownerId: id<OwnerId>('owner-b'),
  agentParticipantId: id<ParticipantId>('agent-b'),
  deviceId: id<DeviceId>('dev-b'),
  harness: 'codex',
  sessionId: 'thread-existing-b',
  generation,
});

export const command = (selection: readonly EventRef[], overrides: Partial<ApprovalCommand> = {}): ApprovalCommand => ({
  v: 1,
  commandId: id<CommandId>('approve-1'),
  roomId: id<RoomId>('room-1'),
  bindingId: id<BindingId>('bind-b-1'),
  expectedPolicyVersion: 3,
  expectedBindingGeneration: 0,
  selection,
  issuedAt: '2026-09-18T00:00:00Z',
  ...overrides,
});

/** Events A, B and C are pending; the owner selected A and B. */
export async function scenario(): Promise<{ input: EvaluateInput; a: PendingRecord; b: PendingRecord; c: PendingRecord }> {
  const a = await record('event-a', 'Review the API change.\nDo not merge yet.');
  const b = await record('event-b', 'Second point: keep the flag off.');
  const c = await record('event-c', 'Arrived after review: ship it now.');
  const input: EvaluateInput = {
    authority: authority(),
    command: command([a.ref, b.ref]),
    binding: binding(),
    policyVersion: 3,
    room: { roomId: id<RoomId>('room-1'), members: [id<ParticipantId>('agent-a'), id<ParticipantId>('agent-b')] },
    pending: [a, b, c],
    release: {
      releaseId: id<ReleaseId>('release-1'),
      payloadRef: 'ledger-release-1',
      causalRootId: id<CausalRootId>('event-a'),
    },
  };
  return { input, a, b, c };
}
