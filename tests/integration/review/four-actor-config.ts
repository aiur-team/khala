import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { ReviewControls } from './selected-only-flow';
import type { NativeReviewConfig } from './native-witness';

function fail(): never { throw new Error('four_actor_descriptor_unavailable'); }
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export type AuthenticatedOwner = Readonly<{ status: number; ownerId: unknown }>;

/** Two credential sets count as two humans only when the server names two owners. */
export function distinctAuthenticatedOwners(first: AuthenticatedOwner, second: AuthenticatedOwner): boolean {
  return first.status === 200 && second.status === 200
    && nonempty(first.ownerId) && nonempty(second.ownerId)
    && first.ownerId !== second.ownerId;
}

/**
 * The second owner has a separate real connector/binding in the same room.
 * The native reader independently checks its process, rollout, inbox and cursor.
 */
export function readReviewPeerControls(primary: ReviewControls): ReviewControls {
  const filename = process.env.KHALA_E2E_DISPOSABLE_ENV;
  if (!filename || !isAbsolute(filename)) fail();
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(filename, 'utf8')) as unknown; }
  catch { return fail(); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail();
  const peer = (raw as { reviewPeer?: unknown }).reviewPeer;
  if (!peer || typeof peer !== 'object' || Array.isArray(peer)) fail();
  const value = peer as Record<string, unknown>;
  const control = value.connectorControl;
  if (!control || typeof control !== 'object' || Array.isArray(control)) fail();
  const connector = control as Record<string, unknown>;
  if (!nonempty(value.roomId) || !nonempty(value.bindingId) || !nonempty(value.agentParticipantId)
    || !nonempty(connector.executable) || !isAbsolute(connector.executable)
    || !Array.isArray(connector.args) || !connector.args.every(arg => typeof arg === 'string')
    || !nonempty(connector.processExecutable) || !isAbsolute(connector.processExecutable)
    || !nonempty(connector.processCwd) || !isAbsolute(connector.processCwd)
    || !nonempty(connector.processCgroup) || !connector.processCgroup.startsWith('/')) fail();
  const result: ReviewControls = {
    roomId: value.roomId, bindingId: value.bindingId,
    agentParticipantId: value.agentParticipantId,
    connectorControl: {
      executable: connector.executable, args: connector.args as string[],
      processExecutable: connector.processExecutable,
      processCwd: connector.processCwd, processCgroup: connector.processCgroup,
    },
  };
  if (result.roomId !== primary.roomId || result.bindingId === primary.bindingId
    || result.agentParticipantId === primary.agentParticipantId) fail();
  return result;
}

export function distinctNativeAgents(primary: NativeReviewConfig, peer: NativeReviewConfig,
  first: Readonly<{ pid: number; sessionId: string }>, second: Readonly<{ pid: number; sessionId: string }>): boolean {
  return first.pid !== second.pid && first.sessionId !== second.sessionId
    && primary.pid !== peer.pid && primary.rolloutFile !== peer.rolloutFile
    && primary.codexHome !== peer.codexHome && primary.xdgStateHome !== peer.xdgStateHome
    && primary.xdgDataHome !== peer.xdgDataHome;
}
