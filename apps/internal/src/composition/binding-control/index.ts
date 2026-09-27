// Composes the local server's binding Stop control over the launch store and
// the root runtime descriptor. Stop only revokes bindings and clears their
// descriptor grant; it never touches an agent process, and it is never how the
// server stops: launcher shutdown remains the only normal server stop.

import fs from 'node:fs';
import path from 'node:path';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { DeviceId, OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/index';
import {
  INTERNAL_ACTIVE_DESCRIPTOR_FILE, MAX_INTERNAL_DESCRIPTOR_BYTES, encodeInternalDescriptor, isGrantedDescriptor,
  parseInternalDescriptor,
} from '@khala/contracts/internal/descriptor';
import {
  INTERNAL_CLAUDE_GRANT_DESCRIPTOR_FILE, INTERNAL_DISCOVERY_DIRECTORY, INTERNAL_GRANT_DESCRIPTOR_FILE,
} from '@khala/contracts/internal/discovery-descriptor';
import { writePrivateFile } from '../../descriptor/write';
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
 * Rewrites every granted descriptor whose grant names one of `bindingIds` without that
 * grant: the root `active.json`, and each agent's own `grant.json` (and Claude session
 * grant) below `discovery/<principal>/`. A missing descriptor is never recreated: the
 * launcher removes `active.json` first on shutdown, and a Stop must not republish
 * discovery for a server that is going away. One failed file fails the clearing, but
 * every other file is still cleared.
 */
export function clearDescriptorGrant(root: string, bindingIds: ReadonlySet<string>): GrantClearing {
  let clearing: GrantClearing = 'absent';
  const merge = (next: GrantClearing) => {
    if (clearing === 'failed' || next === 'absent') return;
    clearing = next;
  };
  merge(clearGrantFile(root, INTERNAL_ACTIVE_DESCRIPTOR_FILE, bindingIds));
  const discovery = path.join(root, INTERNAL_DISCOVERY_DIRECTORY);
  let principals: fs.Dirent[];
  try {
    principals = fs.readdirSync(discovery, { withFileTypes: true });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? clearing : 'failed';
  }
  for (const principal of principals) {
    // A symlinked principal directory is never followed.
    if (!principal.isDirectory()) continue;
    for (const name of AGENT_GRANT_FILES) merge(clearGrantFile(path.join(discovery, principal.name), name, bindingIds));
  }
  return clearing;
}

/** Each agent's own granted descriptor names, beside its discovery descriptor. */
const AGENT_GRANT_FILES = [INTERNAL_GRANT_DESCRIPTOR_FILE, INTERNAL_CLAUDE_GRANT_DESCRIPTOR_FILE] as const;

function clearGrantFile(directory: string, name: string, bindingIds: ReadonlySet<string>): GrantClearing {
  try {
    const text = readDescriptorText(path.join(directory, name));
    if (text === null) return 'absent';
    const decoded = parseInternalDescriptor(text);
    if (!decoded.ok) return 'failed';
    const current = decoded.value;
    if (!isGrantedDescriptor(current) || !bindingIds.has(current.bindingId)) return 'absent';
    writePrivateFile(directory, name, encodeInternalDescriptor({
      v: 1, channelId: current.channelId, origin: current.origin, transportCapability: current.transportCapability,
    }));
    return 'cleared';
  } catch {
    return 'failed';
  }
}

export type BindingControl = BindingStopOptions & Readonly<{
  /** Called by the launcher before it removes the descriptor; later Stops leave it alone. */
  close(): void;
}>;

export function composeBindingControl(input: Readonly<{
  handle: InternalStoreHandle;
  root: string;
  /** Channel access's share of Stop: its approved requests that have not become bindings yet. */
  cancelApproved?: BindingStopOptions['cancelApproved'];
  /** Channel access's share of Stop once bindings are revoked: the requests that activated them. */
  closeStopped?: BindingStopOptions['closeStopped'];
}>): BindingControl {
  let open = true;
  return {
    ...(input.cancelApproved ? { cancelApproved: input.cancelApproved } : {}),
    ...(input.closeStopped ? { closeStopped: input.closeStopped } : {}),
    activatedBindings: channelId => readActivatedBindings(input.handle, channelId),
    clearGrant: bindingIds => (open ? clearDescriptorGrant(input.root, bindingIds) : 'absent'),
    close() {
      open = false;
    },
  };
}
