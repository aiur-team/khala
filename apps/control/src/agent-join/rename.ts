import { randomUUID } from 'node:crypto';
import { checkName, decodeOwnerAgents, defaultAgentName, isDefaultAgentName, nameKey, ownerAgentsKey } from '@khala/contracts/m1/names';
import { agentOwnerRecordKey, decodeAgentOwnerRecord } from '@khala/contracts/m1/participants';
import { decodeNameReservation, decodeProfileRecord, profileRecordKey } from '@khala/contracts/m1/profile';
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
async function release(deps: AgentRenameDeps, record: ControlRecord | null): Promise<boolean> {
  if (!record) return true;
  const result = await writeAndResolve(deps.store, { key: record.key, expectedRevision: record.revision, operationId: operationId(),
    next: { value: record.value, expiresAt: new Date(deps.clock()).toISOString() } });
  return result.kind === 'applied' || result.kind === 'conflict';
}
async function ownReservation(deps: AgentRenameDeps, key: string, userId: string): Promise<ControlRecord | null> {
  const read = await safeRead(deps.store, key);
  return read.kind === 'record' && heldBy(read.record.value, userId) ? read.record : null;
}

type CleanupEntry = { key: string; revision: string };
const cleanupKey = (userId: string) => `agent-name-cleanup/${encodeURIComponent(userId)}`;
async function cleanupJournal(deps: AgentRenameDeps, userId: string, currentKey: string, append?: ControlRecord | null): Promise<boolean> {
  const key = cleanupKey(userId);
  const read = await safeRead(deps.store, key);
  if (read.kind === 'unavailable') return false;
  const entries: CleanupEntry[] = [];
  if (read.kind === 'record') {
    const value = read.record.value as { matrixUserId?: unknown; entries?: unknown };
    if (value.matrixUserId !== userId || !Array.isArray(value.entries) || value.entries.length > 200) return false;
    for (const entry of value.entries) {
      if (typeof entry !== 'object' || entry === null || typeof entry.key !== 'string' || !entry.key.startsWith('names/v1/')
        || typeof entry.revision !== 'string') return false;
      entries.push({ key: entry.key, revision: entry.revision });
    }
  }
  if (append && !entries.some(entry => entry.key === append.key && entry.revision === append.revision)) {
    if (entries.length >= 200) return false;
    entries.push({ key: append.key, revision: append.revision });
    // Save before owner CAS: recovery still knows the old claim if the process stops.
    const saved = await writeAndResolve(deps.store, { key, expectedRevision: read.kind === 'record' ? read.record.revision : null,
      operationId: operationId(), next: { value: { matrixUserId: userId, entries }, expiresAt: null } });
    return saved.kind === 'applied';
  }
  if (entries.length === 0) return true;
  const remaining: CleanupEntry[] = [];
  let complete = true;
  for (const entry of entries) {
    if (entry.key === currentKey) { remaining.push(entry); continue; }
    const reservation = await safeRead(deps.store, entry.key);
    if (reservation.kind === 'unavailable') { remaining.push(entry); complete = false; continue; }
    if (reservation.kind === 'record' && reservation.record.revision === entry.revision
      && heldBy(reservation.record.value, userId) && !await release(deps, reservation.record)) {
      remaining.push(entry); complete = false;
    }
  }
  const saved = await writeAndResolve(deps.store, { key, expectedRevision: read.kind === 'record' ? read.record.revision : null,
    operationId: operationId(), next: { value: { matrixUserId: userId, entries: remaining }, expiresAt: null } });
  return complete && saved.kind === 'applied';
}

/** Capture reservation revisions before the owner CAS so delayed cleanup cannot release a newer claim. */
export const agentRenameLeaseKey = (matrixUserId: string): string => `agent-rename-lease/${encodeURIComponent(matrixUserId)}`;
const LEASE_MS = 300_000;
const MATRIX_BUDGET_MS = 35_000;

export async function renameAgent(deps: AgentRenameDeps, ownerId: OwnerId, matrixUserId: string, input: string,
  expectedLabel?: string): Promise<AgentRenameOutcome> {
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
    return await renameUnderLease(deps, ownerId, matrixUserId, input, deadline, expectedLabel);
  } finally {
    // Exact revision: delayed cleanup cannot unlock a lease acquired after expiry.
    await release(deps, lease.record);
  }
}

async function renameUnderLease(deps: AgentRenameDeps, ownerId: OwnerId, matrixUserId: string, input: string,
  deadline: number, expectedLabel?: string): Promise<AgentRenameOutcome> {
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
      // A cascade must not overwrite a custom rename that won after its index read.
      if (expectedLabel !== undefined && owner.label !== expectedLabel) return 'unavailable';
      if (!await cleanupJournal(deps, matrixUserId, nameKey(owner.label))) return 'unavailable';
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
      const oldReservation = key !== oldKey ? await safeRead(deps.store, oldKey) : null;
      if (oldReservation?.kind === 'unavailable') { await release(deps, reserved.record); return 'unavailable'; }
      const previous = oldReservation?.kind === 'record' && heldBy(oldReservation.record.value, matrixUserId) ? oldReservation.record : null;
      if (previous && !await cleanupJournal(deps, matrixUserId, oldKey, previous)) {
        if (key !== oldKey) await release(deps, reserved.record);
        return 'unavailable';
      }
      if (deps.clock() + MATRIX_BUDGET_MS >= deadline) return 'unavailable';
      let displayed = false;
      try { displayed = await deps.provisioner.setDisplayName(matrixUserId, name); } catch { /* Treat adapter throws as unavailable. */ }
      if (!displayed) {
        if (key !== oldKey && !await release(deps, reserved.record)) await cleanupJournal(deps, matrixUserId, oldKey, reserved.record);
        return 'unavailable';
      }
      if (deps.clock() >= deadline) return 'unavailable';
      const written = await writeAndResolve(deps.store, { key: read.record.key, expectedRevision: read.record.revision,
        operationId: operationId(), next: { value: { ...owner, label: name }, expiresAt: null } });
      if (written.kind === 'conflict') {
        read = await safeRead(deps.store, agentOwnerRecordKey(matrixUserId));
        if (read.kind === 'record') {
          const latest = decodeAgentOwnerRecord(read.record.value);
          if (latest.ok && latest.value.matrixUserId === matrixUserId && latest.value.ownerId === ownerId) {
            if (nameKey(latest.value.label) !== key) await release(deps, reserved.record);
            try { if (deps.clock() + MATRIX_BUDGET_MS < deadline) await deps.provisioner.setDisplayName(matrixUserId, latest.value.label); } catch { /* Best-effort reconciliation. */ }
          }
        }
        continue;
      }
      // Keep the new reservation on ambiguous writes: the owner CAS may have committed.
      if (written.kind !== 'applied') {
        if (written.kind === 'unavailable' && key !== oldKey && !await release(deps, reserved.record)) {
          await cleanupJournal(deps, matrixUserId, oldKey, reserved.record);
        }
        if (written.kind === 'unavailable' && deps.clock() + MATRIX_BUDGET_MS < deadline) {
          try { await deps.provisioner.setDisplayName(matrixUserId, owner.label); } catch { /* Best-effort repair after definite rejection. */ }
        }
        return 'unavailable';
      }
      return await cleanupJournal(deps, matrixUserId, key) ? 'ok' : 'unavailable';
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
