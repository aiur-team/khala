import { createHash, randomUUID } from 'node:crypto';
import type { ControlStore, RoomId } from '@khala/contracts/messaging/index';

// The channel's "Approve joins" setting. Absent means off. Only the creator writes it (see matrix.ts).
const key = (roomId: RoomId) => `channel.approve-joins.v1.${createHash('sha256').update(roomId).digest('hex')}`;
type Setting = Readonly<{ v: 1; on: boolean }>;

export async function readApproveJoins(store: ControlStore, roomId: RoomId): Promise<boolean | 'unavailable'> {
  try {
    const read = await store.read<Setting>(key(roomId));
    if (read.kind === 'absent') return false;
    if (read.kind !== 'record') return 'unavailable';
    const value = read.record.value;
    return value?.v === 1 && typeof value.on === 'boolean' ? value.on : 'unavailable';
  } catch { return 'unavailable'; }
}

export async function writeApproveJoins(store: ControlStore, roomId: RoomId, on: boolean): Promise<boolean> {
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const read = await store.read<Setting>(key(roomId));
      if (read.kind === 'unavailable') return false;
      const written = await store.compareAndSet({ key: key(roomId), expectedRevision: read.kind === 'record' ? read.record.revision : null,
        operationId: `channel.approve-joins.${randomUUID()}`, next: { value: { v: 1, on }, expiresAt: null } });
      if (written.kind === 'applied') return true;
      if (written.kind !== 'conflict') return false;
    }
  } catch { /* falls through */ }
  return false;
}
