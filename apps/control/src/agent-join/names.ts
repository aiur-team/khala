import { randomUUID } from 'node:crypto';
import { decodeOwnerAgents, ownerAgentsKey } from '@khala/contracts/m1/names';
import type { ControlStore, OwnerId } from '@khala/contracts/messaging/index';
import { safeRead, writeAndResolve } from '../invitations/internal';

export async function indexOwnerAgent(store: ControlStore, ownerId: OwnerId, userId: string): Promise<void> {
  const key = ownerAgentsKey(ownerId);
  for (let attempt = 0; attempt < 3; attempt++) {
    const read = await safeRead(store, key);
    if (read.kind === 'unavailable') return;
    const decoded = read.kind === 'record' ? decodeOwnerAgents(read.record.value) : null;
    if (decoded && (!decoded.ok || decoded.value.ownerId !== ownerId)) return;
    const agents = decoded?.ok ? decoded.value.agents : [];
    if (agents.includes(userId) || agents.length >= 200) return;
    const result = await writeAndResolve(store, { key, expectedRevision: read.kind === 'record' ? read.record.revision : null,
      operationId: `owner-agents.${randomUUID()}`, next: { value: { v: 1, ownerId, agents: [...agents, userId] }, expiresAt: null } });
    if (result.kind !== 'conflict') return;
  }
}
