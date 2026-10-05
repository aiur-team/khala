import { randomUUID } from 'node:crypto';
import { checkName, decodeOwnerAgents, defaultAgentName, isDefaultAgentName, ownerAgentsKey } from '@khala/contracts/m1/names';
import { agentOwnerRecordKey, decodeAgentOwnerRecord } from '@khala/contracts/m1/participants';
import { decodeProfileRecord, profileRecordKey } from '@khala/contracts/m1/profile';
import type { ControlRecord, ControlStore, OwnerId, RoomId } from '@khala/contracts/messaging/index';
import { safeRead, writeAndResolve } from '../invitations/internal';
import type { AgentProvisioner } from './provision';

/** A joined member of one channel and the display name it holds there. */
export type RoomMemberName = Readonly<{ userId: string; name: string }>;
export type AgentRenameDeps = Readonly<{
  store: ControlStore; clock: () => number; provisioner: Pick<AgentProvisioner, 'setDisplayName'>;
  /** The channel's joined members, read as `ownerId`; `null` when unavailable. Needed only for a channel-scoped rename. */
  roomMembers?: (ownerId: OwnerId, roomId: RoomId) => Promise<readonly RoomMemberName[] | null>;
}>;
export type AgentRenameOutcome = 'ok' | 'invalid' | 'not_found' | 'not_owner' | 'taken' | 'unavailable';
export type AgentRenameOptions = Readonly<{
  /** A cascade must not overwrite a custom rename that won after its index read. */
  expectedLabel?: string;
  /** Keep names unique in this channel: refuse a name another member holds there. */
  roomId?: RoomId;
}>;
const operationId = () => `agent-rename.${randomUUID()}`;
async function release(deps: AgentRenameDeps, record: ControlRecord | null): Promise<boolean> {
  if (!record) return true;
  const result = await writeAndResolve(deps.store, { key: record.key, expectedRevision: record.revision, operationId: operationId(),
    next: { value: record.value, expiresAt: new Date(deps.clock()).toISOString() } });
  return result.kind === 'applied' || result.kind === 'conflict';
}

/** Serializes renames of one agent across callers so the Matrix name and the owner record agree. */
export const agentRenameLeaseKey = (matrixUserId: string): string => `agent-rename-lease/${encodeURIComponent(matrixUserId)}`;
const LEASE_MS = 300_000;
const MATRIX_BUDGET_MS = 35_000;

/**
 * Renames an agent its owner owns. Agent names are not unique across Khala: a
 * hosted agent is one Matrix user in one channel, so its name is its name in
 * that channel, and `options.roomId` keeps it unique there.
 */
export async function renameAgent(deps: AgentRenameDeps, ownerId: OwnerId, matrixUserId: string, input: string,
  options: AgentRenameOptions = {}): Promise<AgentRenameOutcome> {
  // Authorize before claiming a lease so strangers cannot block the owner's rename.
  const initial = await safeRead(deps.store, agentOwnerRecordKey(matrixUserId));
  if (initial.kind === 'unavailable') return 'unavailable';
  if (initial.kind === 'absent') return 'not_found';
  const owner = decodeAgentOwnerRecord(initial.record.value);
  if (!owner.ok || owner.value.matrixUserId !== matrixUserId) return 'unavailable';
  if (owner.value.ownerId !== ownerId) return 'not_owner';
  if (!checkName(input, 'agent').ok) return 'invalid';
  const deadline = deps.clock() + LEASE_MS;
  const lease = await writeAndResolve(deps.store, { key: agentRenameLeaseKey(matrixUserId), expectedRevision: null,
    operationId: operationId(), next: { value: { matrixUserId }, expiresAt: new Date(deadline).toISOString() } });
  if (lease.kind !== 'applied') return 'unavailable';
  try {
    return await renameUnderLease(deps, ownerId, matrixUserId, input, deadline, options);
  } finally {
    // Exact revision: delayed cleanup cannot unlock a lease acquired after expiry.
    await release(deps, lease.record);
  }
}

async function roomCheck(deps: AgentRenameDeps, ownerId: OwnerId, matrixUserId: string, roomId: RoomId, name: string):
  Promise<'ok' | 'not_found' | 'taken' | 'unavailable'> {
  const members = await deps.roomMembers?.(ownerId, roomId);
  if (!members) return 'unavailable';
  if (!members.some(member => member.userId === matrixUserId)) return 'not_found';
  const wanted = name.toLowerCase();
  return members.some(member => member.userId !== matrixUserId && member.name.toLowerCase() === wanted) ? 'taken' : 'ok';
}

async function renameUnderLease(deps: AgentRenameDeps, ownerId: OwnerId, matrixUserId: string, input: string,
  deadline: number, options: AgentRenameOptions): Promise<AgentRenameOutcome> {
  try {
    let read = await safeRead(deps.store, agentOwnerRecordKey(matrixUserId));
    for (let attempt = 0; attempt < 2; attempt++) {
      if (deps.clock() + MATRIX_BUDGET_MS >= deadline) return 'unavailable';
      if (read.kind === 'unavailable') return 'unavailable';
      if (read.kind === 'absent') return 'not_found';
      const decoded = decodeAgentOwnerRecord(read.record.value);
      if (!decoded.ok || decoded.value.matrixUserId !== matrixUserId) return 'unavailable';
      const owner = decoded.value;
      if (owner.ownerId !== ownerId) return 'not_owner';
      const checked = checkName(input, 'agent');
      if (!checked.ok) return 'invalid';
      const name = checked.name;
      if (options.expectedLabel !== undefined && owner.label !== options.expectedLabel) return 'unavailable';
      if (name === owner.label) return 'ok';
      if (options.roomId !== undefined) {
        const room = await roomCheck(deps, ownerId, matrixUserId, options.roomId, name);
        if (room !== 'ok') return room;
      }
      if (deps.clock() + MATRIX_BUDGET_MS >= deadline) return 'unavailable';
      let displayed = false;
      try { displayed = await deps.provisioner.setDisplayName(matrixUserId, name); } catch { /* Treat adapter throws as unavailable. */ }
      if (!displayed) return 'unavailable';
      if (deps.clock() >= deadline) return 'unavailable';
      const written = await writeAndResolve(deps.store, { key: read.record.key, expectedRevision: read.record.revision,
        operationId: operationId(), next: { value: { ...owner, label: name }, expiresAt: null } });
      if (written.kind === 'conflict') {
        read = await safeRead(deps.store, agentOwnerRecordKey(matrixUserId));
        if (read.kind === 'record') {
          const latest = decodeAgentOwnerRecord(read.record.value);
          if (latest.ok && latest.value.matrixUserId === matrixUserId && latest.value.ownerId === ownerId) {
            try { if (deps.clock() + MATRIX_BUDGET_MS < deadline) await deps.provisioner.setDisplayName(matrixUserId, latest.value.label); } catch { /* Best-effort reconciliation. */ }
          }
        }
        continue;
      }
      if (written.kind !== 'applied') {
        // Repair Matrix only after a definite rejection: an ambiguous write may have committed.
        if (written.kind === 'unavailable' && deps.clock() + MATRIX_BUDGET_MS < deadline) {
          try { await deps.provisioner.setDisplayName(matrixUserId, owner.label); } catch { /* Best-effort repair after definite rejection. */ }
        }
        return 'unavailable';
      }
      return 'ok';
    }
    return 'unavailable';
  } catch { return 'unavailable'; }
}

export async function renameDefaultAgents(deps: AgentRenameDeps, ownerId: OwnerId, previous: string | null, next: string): Promise<void> {
  if (previous === null) return;
  let from = previous, target = next;
  for (let attempt = 0; attempt < 3; attempt++) {
    const profile = await safeRead(deps.store, profileRecordKey(ownerId));
    const decoded = profile.kind === 'record' ? decodeProfileRecord(profile.record.value) : null;
    if (decoded?.ok && decoded.value.ownerId === ownerId) target = decoded.value.username;
    await cascadeDefaultAgents(deps, ownerId, from, target);
    const latest = await safeRead(deps.store, profileRecordKey(ownerId));
    const current = latest.kind === 'record' ? decodeProfileRecord(latest.record.value) : null;
    if (!current?.ok || current.value.ownerId !== ownerId || current.value.username === target) return;
    from = target; target = current.value.username;
  }
}

async function cascadeDefaultAgents(deps: AgentRenameDeps, ownerId: OwnerId, previous: string, next: string): Promise<void> {
  const read = await safeRead(deps.store, ownerAgentsKey(ownerId));
  if (read.kind !== 'record') return;
  const index = decodeOwnerAgents(read.record.value);
  if (!index.ok || index.value.ownerId !== ownerId) return;
  for (const userId of index.value.agents.slice(0, 50)) {
    try {
      const readOwner = await safeRead(deps.store, agentOwnerRecordKey(userId));
      if (readOwner.kind !== 'record') continue;
      const decoded = decodeAgentOwnerRecord(readOwner.record.value);
      if (!decoded.ok || decoded.value.ownerId !== ownerId || decoded.value.matrixUserId !== userId) continue;
      const owner = decoded.value;
      if (!isDefaultAgentName(owner.label, previous, owner.harness)) continue;
      const suffix = /-(\d+)$/u.exec(owner.label)?.[1];
      const n = suffix ? Number(suffix) : 1;
      if (!Number.isSafeInteger(n) || n < 1) continue;
      // The channel suffix carries over. A rename that now collides in its channel
      // shows the owner the channel-name prompt there rather than failing here.
      await renameAgent(deps, ownerId, userId, defaultAgentName(next, owner.harness, n), { expectedLabel: owner.label });
    } catch { /* One broken or unavailable agent must not stop the owner's cascade. */ }
  }
}
