import { describe, expect, it } from 'vitest';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import { encodeMessageContent } from '@khala/contracts/messaging/events';
import { renameDelivery } from './rename-delivery';

const binding = { v: 1, bindingId: 'binding_mira', ownerId: 'owner_mira', agentParticipantId: 'agent_one',
  deviceId: 'device_one', harness: 'codex', sessionId: 'session_one', generation: 1 } as SessionBinding;

describe('rename metadata delivery', () => {
  it('keeps retry bytes and release identity exact while attributing the human device', () => {
    const content = { v: 1 as const, kind: 'agent_rename' as const,
      agentParticipantId: 'agent_one' as never, body: 'Dolan' };
    const event = { eventId: '$rename' as never, roomId: '!room:matrix.test' as never,
      actorParticipantId: 'human_mira' as never, actorDeviceId: 'browser_mira' as never,
      agentParticipantId: content.agentParticipantId, name: content.body,
      canonicalPayload: encodeMessageContent(content), receivedAt: '2026-09-29T05:00:00.000Z' };
    const first = renameDelivery(binding, event);
    const retry = renameDelivery(binding, event);
    expect(retry).toEqual(first);
    expect(first.releaseId).toMatch(/^rename_[0-9a-f]{64}$/u);
    expect(first.events[0]).toMatchObject({ authorParticipantId: 'human_mira', authorDeviceId: 'browser_mira' });
    expect(new TextDecoder().decode(first.payload)).toContain('Dolan');
  });
});
