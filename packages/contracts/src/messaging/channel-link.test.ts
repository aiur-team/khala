import { describe, expect, it } from 'vitest';
import { decodeAgentChannelLinkRequest, decodeAgentChannelLinkResult, decodeHumanChannelLinkResolveRequest,
  decodeHumanChannelLinkResult, decodePersonalChannelLinkRequest, decodePersonalChannelLinkResult } from './channel-link';

describe('channel-link result contract', () => {
  it('accepts only the canonical shared URL at both entry points', () => {
    const origin = 'https://khala.example';
    const url = `${origin}/join/invite_12345678`;
    expect(decodeHumanChannelLinkResolveRequest({ v: 1, channelUrl: url }, origin).ok).toBe(true);
    expect(decodeAgentChannelLinkRequest({ v: 1, kind: 'channel_url', operationId: 'op',
      credentialRef: 'cred', channelUrl: url }, origin).ok).toBe(true);
    for (const channelUrl of [`${origin}/join/invite_12345678?owner=A`,
      `${origin}/join/%69nvite_12345678`, 'https://evil.example/join/invite_12345678',
      `${origin}/room/invite_12345678`]) {
      expect(decodeHumanChannelLinkResolveRequest({ v: 1, channelUrl }, origin).ok).toBe(false);
      expect(decodeAgentChannelLinkRequest({ v: 1, kind: 'channel_url', operationId: 'op',
        credentialRef: 'cred', channelUrl }, origin).ok).toBe(false);
    }
  });
  it('accepts only the versioned, grant-free outcomes', () => {
    expect(decodeHumanChannelLinkResult({ v: 1, kind: 'join_required' }).ok).toBe(true);
    expect(decodeAgentChannelLinkResult({ v: 1, kind: 'use_your_link', action: 'join_in_browser_then_copy_your_link' }).ok).toBe(true);
    expect(decodeAgentChannelLinkResult({ v: 1, kind: 'request', operationId: 'op_1', outcome: 'pending_owner' }).ok).toBe(true);
    expect(decodeAgentChannelLinkResult({ v: 1, kind: 'request', operationId: 'op_1', outcome: 'pending_owner', grant: 'secret' }).ok).toBe(false);
    expect(decodeAgentChannelLinkResult({ v: 2, kind: 'request', operationId: 'op_1', outcome: 'pending_owner' }).ok).toBe(false);
    expect(decodePersonalChannelLinkResult({ v: 1, kind: 'personal_link', shareUrl: 'https://khala.example/join/inv_12345678', expiresAt: null }).ok).toBe(true);
    expect(decodePersonalChannelLinkResult({ v: 1, kind: 'personal_link', shareUrl: 'https://evil.example/join/inv_12345678?grant=secret', expiresAt: null }).ok).toBe(false);
  });
  it('requires a versioned personal-link request with a room ID', () => {
    expect(decodePersonalChannelLinkRequest({ v: 1, roomId: '!room:example.test' }).ok).toBe(true);
    expect(decodePersonalChannelLinkRequest({ v: 1, roomId: '!room:example.test', ownerId: 'owner_a' }).ok).toBe(false);
  });
});
