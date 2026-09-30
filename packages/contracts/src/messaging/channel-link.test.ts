import { describe, expect, it } from 'vitest';
import { decodeAgentChannelLinkResult, decodeHumanChannelLinkResult, decodePersonalChannelLinkResult } from './channel-link';

describe('channel-link result contract', () => {
  it('accepts only the versioned, grant-free outcomes', () => {
    expect(decodeHumanChannelLinkResult({ v: 1, kind: 'join_required' }).ok).toBe(true);
    expect(decodeAgentChannelLinkResult({ v: 1, kind: 'use_your_link', action: 'join_in_browser_then_copy_your_link' }).ok).toBe(true);
    expect(decodeAgentChannelLinkResult({ v: 1, kind: 'request', operationId: 'op_1', outcome: 'pending_owner' }).ok).toBe(true);
    expect(decodeAgentChannelLinkResult({ v: 1, kind: 'request', operationId: 'op_1', outcome: 'pending_owner', grant: 'secret' }).ok).toBe(false);
    expect(decodeAgentChannelLinkResult({ v: 2, kind: 'request', operationId: 'op_1', outcome: 'pending_owner' }).ok).toBe(false);
    expect(decodePersonalChannelLinkResult({ v: 1, kind: 'personal_link', shareUrl: 'https://khala.example/join/inv_12345678', expiresAt: null }).ok).toBe(true);
    expect(decodePersonalChannelLinkResult({ v: 1, kind: 'personal_link', shareUrl: 'https://evil.example/join/inv_12345678?grant=secret', expiresAt: null }).ok).toBe(false);
  });
});
