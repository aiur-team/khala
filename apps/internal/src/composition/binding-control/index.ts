// Composes the local server's binding Stop control over the launch store and
// the root runtime descriptor. Stop only revokes bindings and clears their
// descriptor grant; it never touches an agent process, and it is never how the
// server stops: launcher shutdown remains the only normal server stop.

import fs from 'node:fs';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { DeviceId, OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/index';
import { isGrantedDescriptor, parseInternalDescriptor, MAX_INTERNAL_DESCRIPTOR_BYTES } from '@khala/contracts/internal/descriptor';
import { activeDescriptorPath, writeActiveDescriptor } from '../../descriptor/write';
import type { BindingStopOptions } from '../../server/channel-server';
import type { GrantClearing } from '../../server/stop/service';
import type { InternalStoreHandle } from '../../store/open';

type ActivatedRow = Readonly<{
  binding_id: string;
  generation: number;
  owner_id: string;
  participant_id: string;
  device_id: string;
  harness: string;
  session_id: string;
}>;

/** Every binding generation that channel access activated for the channel, whatever its status. */
export function readActivatedBindings(handle: InternalStoreHandle, channelId: RoomId): readonly SessionBinding[] | 'unavailable' {
  try {
    const rows = handle.read(db => db.prepare(`
      SELECT b.binding_id, b.generation, b.owner_id, b.participant_id, b.device_id, b.harness, b.session_id
      FROM discovery_activations a JOIN bindings b ON b.binding_id = a.binding_id AND b.generation = a.generation
      WHERE a.channel_id = ?
      ORDER BY b.binding_id, b.generation
    `).all(channelId) as ActivatedRow[]);
    return rows.map(row => ({
      v: 1,
      bindingId: row.binding_id as SessionBinding['bindingId'],
      ownerId: row.owner_id as OwnerId,
      agentParticipantId: row.participant_id as ParticipantId,
      deviceId: row.device_id as DeviceId,
      harness: row.harness,
      sessionId: row.session_id,
      generation: row.generation,
    }));
  } catch {
    return 'unavailable';
  }
}

function readDescriptorText(file: string): string | null {
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || stats.size > MAX_INTERNAL_DESCRIPTOR_BYTES) throw new Error('descriptor: unreadable');
    return fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Rewrites `active.json` without its grant when the grant names one of
 * `bindingIds`. A missing descriptor is never recreated: the launcher removes it
 * first on shutdown, and a Stop must not republish discovery for a server that is going away.
 */
export function clearDescriptorGrant(root: string, bindingIds: ReadonlySet<string>): GrantClearing {
  try {
    const text = readDescriptorText(activeDescriptorPath(root));
    if (text === null) return 'absent';
    const decoded = parseInternalDescriptor(text);
    if (!decoded.ok) return 'failed';
    const current = decoded.value;
    if (!isGrantedDescriptor(current) || !bindingIds.has(current.bindingId)) return 'absent';
    writeActiveDescriptor(root, {
      v: 1, channelId: current.channelId, origin: current.origin, transportCapability: current.transportCapability,
    });
    return 'cleared';
  } catch {
    return 'failed';
  }
}

export type BindingControl = BindingStopOptions & Readonly<{
  /** Called by the launcher before it removes the descriptor; later Stops leave it alone. */
  close(): void;
}>;

export function composeBindingControl(input: Readonly<{ handle: InternalStoreHandle; root: string }>): BindingControl {
  let open = true;
  return {
    activatedBindings: channelId => readActivatedBindings(input.handle, channelId),
    clearGrant: bindingIds => (open ? clearDescriptorGrant(input.root, bindingIds) : 'absent'),
    close() {
      open = false;
    },
  };
}
