import { randomUUID } from 'node:crypto';
import type { Harness } from '@khala/contracts/m1/agent-join';
import { defaultAgentName, decodeOwnerAgents, nameKey, ownerAgentsKey } from '@khala/contracts/m1/names';
import { decodeNameReservation, type NameReservation } from '@khala/contracts/m1/profile';
import type { ControlStore, OwnerId } from '@khala/contracts/messaging/index';
import { safeRead, writeAndResolve } from '../invitations/internal';

export async function allocateAgentName(store: ControlStore, input: {
  ownerId: OwnerId; matrixUserId: string; username: string; harness: Harness; expiresAt?: string;
}): Promise<string | null> {
  for (let n = 1; n <= 20; n++) {
    const candidate = defaultAgentName(input.username, input.harness, n);
    const reservation: NameReservation = { v: 1, kind: 'agent', ownerId: input.ownerId, matrixUserId: input.matrixUserId };
    const result = await writeAndResolve(store, { key: nameKey(candidate), expectedRevision: null,
      operationId: `agent-name.${randomUUID()}`, next: { value: reservation, expiresAt: input.expiresAt ?? null } });
    if (result.kind === 'applied') return candidate;
    if (result.kind !== 'conflict') return null;
    const current = decodeNameReservation(result.current?.value);
    if (current.ok && current.value.kind === 'agent' && current.value.matrixUserId === input.matrixUserId) return candidate;
  }
  return null;
}

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

/** Promote a staged join's own reservation before publishing confirmation. */
export async function retainAgentName(store: ControlStore, name: string, ownerId: string, matrixUserId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const read = await safeRead(store, nameKey(name));
    if (read.kind !== 'record') return false;
    const decoded = decodeNameReservation(read.record.value);
    if (!decoded.ok || decoded.value.kind !== 'agent' || decoded.value.ownerId !== ownerId
      || decoded.value.matrixUserId !== matrixUserId) return false;
    if (read.record.expiresAt === null) return true;
    const result = await writeAndResolve(store, { key: read.record.key, expectedRevision: read.record.revision,
      operationId: `agent-name.${randomUUID()}`, next: { value: read.record.value, expiresAt: null } });
    if (result.kind === 'applied') return true;
    if (result.kind !== 'conflict') return false;
  }
  return false;
}
