import { randomUUID } from 'node:crypto';
import { checkName, decodeOwnerAgents, defaultAgentName, isDefaultAgentName, nameKey, ownerAgentsKey } from '@khala/contracts/m1/names';
import { agentOwnerRecordKey, decodeAgentOwnerRecord } from '@khala/contracts/m1/participants';
import { decodeNameReservation } from '@khala/contracts/m1/profile';
import type { ControlRecord, ControlStore, OwnerId } from '@khala/contracts/messaging/index';
import { safeRead, writeAndResolve } from '../invitations/internal';
import { allocateAgentName } from './names';
import type { AgentProvisioner } from './provision';

export type AgentRenameDeps = Readonly<{
  store: ControlStore; clock: () => number; provisioner: Pick<AgentProvisioner, 'setDisplayName'>;
}>;
export type AgentRenameOutcome = 'ok' | 'invalid' | 'not_found' | 'not_owner' | 'taken' | 'unavailable';
const operationId = () => `agent-rename.${randomUUID()}`;
const heldBy = (value: unknown, userId: string): boolean => {
  const decoded = decodeNameReservation(value);
  return decoded.ok && decoded.value.kind === 'agent' && decoded.value.matrixUserId === userId;
};
async function release(deps: AgentRenameDeps, record: ControlRecord | null): Promise<void> {
  if (!record) return;
  await writeAndResolve(deps.store, { key: record.key, expectedRevision: record.revision, operationId: operationId(),
    next: { value: record.value, expiresAt: new Date(deps.clock()).toISOString() } });
}
async function ownReservation(deps: AgentRenameDeps, key: string, userId: string): Promise<ControlRecord | null> {
  const read = await safeRead(deps.store, key);
  return read.kind === 'record' && heldBy(read.record.value, userId) ? read.record : null;
}

/** Capture reservation revisions before the owner CAS so delayed cleanup cannot release a newer claim. */
export async function renameAgent(deps: AgentRenameDeps, ownerId: OwnerId, matrixUserId: string, input: string,
  expectedLabel?: string): Promise<AgentRenameOutcome> {
  try {
    let read = await safeRead(deps.store, agentOwnerRecordKey(matrixUserId));
    for (let attempt = 0; attempt < 2; attempt++) {
      if (read.kind === 'unavailable') return 'unavailable';
      if (read.kind === 'absent') return 'not_found';
      const decoded = decodeAgentOwnerRecord(read.record.value);
      if (!decoded.ok || decoded.value.matrixUserId !== matrixUserId) return 'unavailable';
      const owner = decoded.value;
      if (owner.ownerId !== ownerId) return 'not_owner';
      const checked = checkName(input, 'agent');
      if (!checked.ok) return 'invalid';
      const name = checked.name;
      // A cascade must not overwrite a custom rename that won after its index read.
      if (expectedLabel !== undefined && owner.label !== expectedLabel) return 'unavailable';
      if (name === owner.label) return 'ok';
      const key = nameKey(name), oldKey = nameKey(owner.label);
      const next = { value: { v: 1, kind: 'agent', ownerId, matrixUserId }, expiresAt: null } as const;
      let reserved = await writeAndResolve(deps.store, { key, expectedRevision: null, operationId: operationId(), next });
      if (reserved.kind === 'conflict') {
        if (!reserved.current || !heldBy(reserved.current.value, matrixUserId)) return 'taken';
        // Rotate an existing own claim to protect it from older cleanup.
        reserved = await writeAndResolve(deps.store, { key, expectedRevision: reserved.current.revision, operationId: operationId(), next });
      }
      if (reserved.kind !== 'applied') return 'unavailable';
      const previous = key !== oldKey ? await ownReservation(deps, oldKey, matrixUserId) : null;
      let displayed = false;
      try { displayed = await deps.provisioner.setDisplayName(matrixUserId, name); } catch { /* Treat adapter throws as unavailable. */ }
      if (!displayed) {
        if (key !== oldKey) await release(deps, reserved.record);
        return 'unavailable';
      }
      const written = await writeAndResolve(deps.store, { key: read.record.key, expectedRevision: read.record.revision,
        operationId: operationId(), next: { value: { ...owner, label: name }, expiresAt: null } });
      if (written.kind === 'conflict') {
        read = await safeRead(deps.store, agentOwnerRecordKey(matrixUserId));
        if (read.kind === 'record') {
          const latest = decodeAgentOwnerRecord(read.record.value);
          if (latest.ok && latest.value.matrixUserId === matrixUserId && latest.value.ownerId === ownerId) {
            if (nameKey(latest.value.label) !== key) await release(deps, reserved.record);
            try { await deps.provisioner.setDisplayName(matrixUserId, latest.value.label); } catch { /* Best-effort reconciliation. */ }
          }
        }
        continue;
      }
      // Keep the new reservation on ambiguous writes: the owner CAS may have committed.
      if (written.kind !== 'applied') return 'unavailable';
      await release(deps, previous);
      return 'ok';
    }
    return 'unavailable';
  } catch { return 'unavailable'; }
}

export async function renameDefaultAgents(deps: AgentRenameDeps, ownerId: OwnerId, previous: string | null, next: string): Promise<void> {
  if (previous === null) return;
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
      const name = defaultAgentName(next, owner.harness, n);
      const result = await renameAgent(deps, ownerId, userId, name, owner.label);
      if (result !== 'taken') continue;
      const allocated = await allocateAgentName(deps.store, { ownerId, matrixUserId: userId, username: next, harness: owner.harness });
      if (allocated) {
        const claim = await ownReservation(deps, nameKey(allocated), userId);
        const outcome = await renameAgent(deps, ownerId, userId, allocated, owner.label);
        if (outcome !== 'ok') {
          // CAS protects a reservation renewed by a successful concurrent rename.
          await release(deps, claim);
        }
      }
    } catch { /* One broken or unavailable agent must not stop the owner's cascade. */ }
  }
}
