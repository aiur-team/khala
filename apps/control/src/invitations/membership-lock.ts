import { createHash, randomUUID } from 'node:crypto';
import type { ControlStore, OwnerId, RoomId } from '@khala/contracts/messaging/index';

type LeaseRecord = Readonly<{ v: 1; leaseId: string | null; expiresAt: number }>;
export type MembershipLease = Readonly<{ renew(): Promise<boolean> }>;
const LEASE_MS = 300_000;
/** Serializes admission/unban against removal for one human, including across function instances. */
export async function withMembershipLease<T extends { kind: string }>(store: ControlStore, roomId: RoomId, ownerId: OwnerId,
  work: (lease: MembershipLease) => Promise<T>): Promise<T | { kind: 'unavailable' }> {
  const key = `membership-lease.v1.${createHash('sha256').update(JSON.stringify([roomId, ownerId])).digest('hex')}`;
  const leaseId = randomUUID();
  const read = await store.read<LeaseRecord>(key);
  if (read.kind === 'unavailable') return { kind: 'unavailable' };
  if (read.kind === 'record' && (read.record.value.v !== 1 || read.record.value.leaseId !== null && read.record.value.expiresAt > Date.now())) return { kind: 'unavailable' };
  const claimed = await store.compareAndSet({ key, expectedRevision: read.kind === 'record' ? read.record.revision : null,
    operationId: `membership-lease.claim.${leaseId}`, next: { value: { v: 1, leaseId, expiresAt: Date.now() + LEASE_MS }, expiresAt: null } });
  if (claimed.kind !== 'applied') return { kind: 'unavailable' };
  const lease: MembershipLease = { async renew() {
    const current = await store.read<LeaseRecord>(key);
    if (current.kind !== 'record' || current.record.value.leaseId !== leaseId || current.record.value.expiresAt <= Date.now()) return false;
    const renewed = await store.compareAndSet({ key, expectedRevision: current.record.revision,
      operationId: `membership-lease.renew.${randomUUID()}`, next: { value: { v: 1, leaseId, expiresAt: Date.now() + LEASE_MS }, expiresAt: null } });
    return renewed.kind === 'applied';
  } };
  try { return await work(lease); }
  finally {
    try {
      const current = await store.read<LeaseRecord>(key);
      if (current.kind === 'record' && current.record.value.leaseId === leaseId) {
        await store.compareAndSet({ key, expectedRevision: current.record.revision, operationId: `membership-lease.release.${leaseId}`,
          next: { value: { v: 1, leaseId: null, expiresAt: 0 }, expiresAt: null } });
      }
    } catch { /* A failed release remains fail-closed until the bounded lease expires. */ }
  }
}
