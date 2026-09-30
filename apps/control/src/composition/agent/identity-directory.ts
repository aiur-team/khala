import { createHash } from 'node:crypto';
import type { ControlStore, OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/index';

type AgentIdentity = Readonly<{ v: 1; roomId: RoomId; matrixUserId: string;
  participantId: ParticipantId; ownerId: OwnerId; harness: string }>;

function key(roomId: RoomId, userId: string): string {
  return `matrix.agent-identity.v1.${createHash('sha256').update(JSON.stringify([roomId, userId])).digest('hex')}`;
}

function participantKey(roomId: RoomId, participantId: ParticipantId): string {
  return `matrix.agent-participant.v1.${createHash('sha256').update(JSON.stringify([roomId, participantId])).digest('hex')}`;
}

/** The admission record lets an authorized room reader attribute departed agents after reload. */
export function createAgentIdentityDirectory(store: ControlStore) {
  return {
    async remember(identity: AgentIdentity): Promise<boolean> {
      const address = key(identity.roomId, identity.matrixUserId);
      const existing = await store.read<AgentIdentity>(address);
      if (existing.kind !== 'absent' && (existing.kind !== 'record'
        || JSON.stringify(existing.record.value) !== JSON.stringify(identity))) return false;
      if (existing.kind === 'absent') {
        const written = await store.compareAndSet({ key: address, expectedRevision: null,
          operationId: `matrix-agent-identity-${createHash('sha256').update(JSON.stringify(identity)).digest('base64url')}`,
          next: { value: identity, expiresAt: null } });
        if (written.kind !== 'applied') {
          const retry = await store.read<AgentIdentity>(address);
          if (retry.kind !== 'record' || JSON.stringify(retry.record.value) !== JSON.stringify(identity)) return false;
        }
      }
      const reverseAddress = participantKey(identity.roomId, identity.participantId);
      const reverse = await store.read<AgentIdentity>(reverseAddress);
      if (reverse.kind === 'record') return JSON.stringify(reverse.record.value) === JSON.stringify(identity);
      if (reverse.kind !== 'absent') return false;
      const written = await store.compareAndSet({ key: reverseAddress, expectedRevision: null,
        operationId: `matrix-agent-participant-${createHash('sha256').update(JSON.stringify(identity)).digest('base64url')}`,
        next: { value: identity, expiresAt: null } });
      if (written.kind === 'applied') return true;
      const retry = await store.read<AgentIdentity>(reverseAddress);
      return retry.kind === 'record' && JSON.stringify(retry.record.value) === JSON.stringify(identity);
    },
    async lookup(roomId: RoomId, userId: string): Promise<AgentIdentity | null> {
      const found = await store.read<AgentIdentity>(key(roomId, userId));
      if (found.kind !== 'record') return null;
      const value = found.record.value;
      return value.v === 1 && value.roomId === roomId && value.matrixUserId === userId ? value : null;
    },
    async lookupParticipant(roomId: RoomId, participantId: ParticipantId): Promise<AgentIdentity | null> {
      const found = await store.read<AgentIdentity>(participantKey(roomId, participantId));
      if (found.kind !== 'record') return null;
      const value = found.record.value;
      return value.v === 1 && value.roomId === roomId && value.participantId === participantId ? value : null;
    },
  };
}
