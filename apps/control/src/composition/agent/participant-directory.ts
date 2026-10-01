import { decodeParticipantId, decodeRoomId, type ControlStore } from '@khala/contracts/messaging/index';
import type { AdapterCapabilities } from '../../agent-bootstrap/handler';
import { createAgentBindingStore } from '../../agent-bootstrap/store';
import { createAgentIdentityDirectory } from './identity-directory';
import type { RouteRegistration } from '../../runtime/handler';
import type { MatrixSessionIssuer } from '../human/matrix';
import type { SessionBinding } from '@khala/contracts/messaging/index';

export const AGENT_PARTICIPANTS_PATH = '/api/agent/messaging/participants';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  } });
}

/** Current binding and room membership fence around the private participant directory. */
export function createAgentParticipantDirectoryRoute(input: Readonly<{
  store: ControlStore;
  capabilities: Pick<AdapterCapabilities, 'authorize' | 'lookupBinding'>;
  sessions: Pick<MatrixSessionIssuer, 'resolveRoomParticipants'>;
  lookupAgentDevice(binding: SessionBinding): Promise<{ deviceId: string; fingerprint: string } | null>;
}>): RouteRegistration {
  const bindings = createAgentBindingStore({ store: input.store });
  return { path: AGENT_PARTICIPANTS_PATH, methods: ['POST'], async handle(request) {
    const authority = await input.capabilities.authorize(request, 'receive_released');
    if (authority.kind === 'unavailable') return json(503, { code: 'unavailable' });
    if (authority.kind !== 'authorized') return json(authority.status, { code: authority.code });
    let body: unknown;
    try { body = await request.json(); } catch { return json(400, { code: 'invalid_request' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { code: 'invalid_request' });
    const value = body as Record<string, unknown>;
    if (Object.keys(value).sort().join(',') !== 'roomId,targetParticipantIds,userIds' || !Array.isArray(value.userIds)
      || value.userIds.length > 100 || value.userIds.some(item => typeof item !== 'string' || item.length > 255)
      || new Set(value.userIds).size !== value.userIds.length
      || !Array.isArray(value.targetParticipantIds) || value.targetParticipantIds.length > 100
      || value.targetParticipantIds.some(item => typeof item !== 'string' || item.length > 255)
      || new Set(value.targetParticipantIds).size !== value.targetParticipantIds.length)
      return json(400, { code: 'invalid_request' });
    const roomId = decodeRoomId(value.roomId);
    if (!roomId.ok) return json(400, { code: 'invalid_request' });
    const current = await input.capabilities.lookupBinding(authority.binding.bindingId);
    const located = await bindings.locateBinding(authority.binding.bindingId);
    if (current.kind !== 'found' || current.status !== 'active' || current.generation !== authority.binding.generation
      || current.deviceId !== authority.binding.deviceId || current.ownerId !== authority.ownerId
      || located.kind !== 'found' || located.address.roomId !== roomId.value
      || located.record.revokedGeneration !== null
      || located.record.binding.generation !== authority.binding.generation)
      return json(403, { code: 'forbidden' });
    const result = await input.sessions.resolveRoomParticipants(authority.ownerId, roomId.value, value.userIds as string[]);
    if (result.kind !== 'ok') return json(result.kind === 'forbidden' ? 403 : 503, { code: result.kind });
    const identities = createAgentIdentityDirectory(input.store);
    const participants = [...result.participants];
    for (const participantId of value.targetParticipantIds as string[]) {
      if (participants.some(item => item.participantId === participantId)) continue;
      const targetId = decodeParticipantId(participantId);
      if (!targetId.ok) return json(400, { code: 'invalid_request' });
      const agent = await identities.lookupParticipant(roomId.value, targetId.value);
      if (!agent) return json(503, { code: 'unavailable' });
      participants.push({ matrixUserId: agent.matrixUserId, participantId: agent.participantId,
        ownerId: agent.ownerId, displayName: `${agent.harness[0]?.toUpperCase()}${agent.harness.slice(1)} #${agent.participantId.slice(-4)}`,
        kind: 'agent' });
    }
    const pinned = [];
    for (const participant of participants) {
      if (participant.kind !== 'agent' || !(value.userIds as string[]).includes(participant.matrixUserId)) {
        pinned.push(participant);
        continue;
      }
      if (participant.ownerId !== authority.ownerId) return json(403, { code: 'forbidden' });
      const found = await bindings.findParticipant({ ownerId: participant.ownerId, roomId: roomId.value,
        agentParticipantId: participant.participantId });
      if (found.kind === 'unavailable') return json(503, { code: 'unavailable' });
      if (found.kind !== 'found' || found.record.revokedGeneration !== null
        || found.record.binding.agentParticipantId !== participant.participantId) {
        pinned.push(participant);
        continue;
      }
      const device = await input.lookupAgentDevice(found.record.binding);
      if (!device) {
        pinned.push(participant);
        continue;
      }
      if (device.deviceId !== found.record.binding.deviceId) return json(503, { code: 'unavailable' });
      pinned.push({ ...participant, deviceId: device.deviceId, fingerprint: device.fingerprint });
    }
    return json(200, { participants: pinned });
  } };
}
