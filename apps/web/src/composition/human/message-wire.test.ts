import { describe, expect, it } from 'vitest';
import { decodeContentLimits, type MessageContent, type ParticipantView } from '@khala/contracts/messaging/index';
import { encodeMessageContent, projectWireEvent } from './message-wire';

const decodedLimits = decodeContentLimits({ maxBodyBytes: 32768, maxDisplayNameBytes: 255, maxRoomTitleBytes: 255 });
if (!decodedLimits.ok) throw new Error('invalid test limits');
const limits = decodedLimits.value;
const participant: ParticipantView = { participantId: 'human_one' as never, ownerId: 'owner_one' as never,
  kind: 'human', displayName: 'Maya', deviceIds: [] };
const base = { type: 'm.room.message', eventId: '$name' as never, participant,
  authorDeviceId: 'DEVICE_ONE' as never, clientTxnId: 'txn_one', receivedAt: '1970-01-01T00:00:00.000Z' };

describe('shared message wire content', () => {
  it('encodes text and rename notices with the hosted wire shape', () => {
    expect(encodeMessageContent({ v: 1, kind: 'text', body: 'hello' })).toEqual({ msgtype: 'm.text', body: 'hello' });
    expect(encodeMessageContent({ v: 1, kind: 'agent_rename', body: 'Dolan', agentParticipantId: 'agent_one' as never }))
      .toEqual({ msgtype: 'm.notice', body: 'Dolan', 'com.khala.agent_participant_id': 'agent_one' });
    expect(encodeMessageContent({ v: 1, kind: 'agent_name_snapshot', body: 'Dolan',
      agentParticipantId: 'agent_one' as never, sourceEventId: null })).toEqual({
      msgtype: 'm.notice', body: 'Dolan', 'com.khala.agent_participant_id': 'agent_one',
      'com.khala.name_snapshot': true, 'com.khala.name_source_event_id': null,
    });
  });

  it.each(['agent_rename', 'agent_name_snapshot'] as const)('preserves %s metadata and the client transaction', kind => {
    const content = { v: 1, kind, body: 'Dolan', agentParticipantId: 'agent_one',
      ...(kind === 'agent_name_snapshot' ? { sourceEventId: '$prior' } : {}) } as MessageContent;
    expect(projectWireEvent({ ...base, content: encodeMessageContent(content) }, limits)).toEqual({
      kind: 'message', eventId: base.eventId, authorDeviceId: base.authorDeviceId, participant,
      content, clientTxnId: 'txn_one', receivedAt: base.receivedAt,
    });
  });

  it.each([undefined, 1, ''])('rejects malformed notice targets %j', target => {
    expect(projectWireEvent({ ...base, content: { msgtype: 'm.notice', body: 'Dolan',
      'com.khala.agent_participant_id': target } }, limits)).toBeNull();
  });

  it('decodes channel events without message device attribution', () => {
    const content = { v: 1, body: 'review requested', kind: 'pr.ready_for_review', summary: 'review requested' };
    expect(projectWireEvent({ ...base, type: 'com.khala.event.v1', content, authorDeviceId: null }, limits)).toEqual({
      kind: 'channel_event', eventId: base.eventId, participant, content, receivedAt: base.receivedAt,
    });
  });

  it.each([{}, { v: 1, kind: 'pr.ready_for_review', body: 'ready', summary: '' },
    { v: 1, kind: 'pr.ready_for_review', body: 'ready', summary: 'ready', url: 'javascript:alert(1)' }])
  ('rejects malformed channel content %j', content => {
    expect(projectWireEvent({ ...base, type: 'com.khala.event.v1', content, authorDeviceId: null }, limits)).toBeNull();
  });

  it('ignores member events and text without device attribution', () => {
    expect(projectWireEvent({ ...base, type: 'm.room.member', content: {} }, limits)).toBeNull();
    expect(projectWireEvent({ ...base, content: { msgtype: 'm.text', body: 'hello' }, authorDeviceId: null }, limits)).toBeNull();
  });

  it('projects a join-to-join name change as an event pill and ignores other membership changes', () => {
    const member = { user: '@a:x', membership: 'join', displayname: 'Dolan', kind: 'agent' };
    const rename = projectWireEvent({ ...base, type: 'm.room.member', content: { ...member, displayname: 'Zed' }, previousContent: member }, limits);
    expect(rename).toMatchObject({ kind: 'channel_event', eventId: base.eventId, participant, content: { summary: 'Dolan is now Zed' } });
    expect(projectWireEvent({ ...base, type: 'm.room.member', content: { ...member, displayname: 'Zed' } }, limits)).toBeNull();
    expect(projectWireEvent({ ...base, type: 'm.room.member', content: member, previousContent: { ...member, membership: 'invite' } }, limits)).toBeNull();
  });

  it('projects text and rejects unsupported or invalid message content', () => {
    expect(projectWireEvent({ ...base, content: { msgtype: 'm.text', body: 'hello' } }, limits)).toEqual({
      kind: 'message', eventId: base.eventId, authorDeviceId: base.authorDeviceId, participant,
      content: { v: 1, kind: 'text', body: 'hello' }, clientTxnId: base.clientTxnId, receivedAt: base.receivedAt,
    });
    expect(projectWireEvent({ ...base, content: { msgtype: 'm.image', body: 'hello' } }, limits)).toBeNull();
    expect(projectWireEvent({ ...base, content: { msgtype: 'm.text', body: 1 } }, limits)).toBeNull();
  });
});
