import { describe, expect, it } from 'vitest';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { GrantedDescriptor } from '@khala/contracts/internal/descriptor';
import { CODEX_IDLE_WAKE_PATH, createInstalledCodexWake } from './codex-installed-wake.js';
import { internalSessionDigest } from './internal-session.js';

const sessionId = 'native-thread-one';
const binding = {
  v: 1, bindingId: 'binding-one', ownerId: 'owner-one', agentParticipantId: 'agent-one',
  deviceId: 'device-one', harness: 'codex', sessionId: internalSessionDigest('codex', sessionId), generation: 3,
} as SessionBinding;
const descriptor = {
  v: 1, channelId: 'channel-one', origin: 'http://127.0.0.1:4100', transportCapability: 'A'.repeat(43),
  grantRef: 'grant-one', bindingId: binding.bindingId, bindingCapability: 'B'.repeat(43),
} as GrantedDescriptor;

describe('installed Codex wake request', () => {
  it('sends only the raw native thread under its own binding grant', async () => {
    const calls: Array<{ url: string; body: unknown; authorization: string | null }> = [];
    const wake = createInstalledCodexWake({ sessionId, binding, descriptorPath: '/private/grant.json',
      readDescriptor: () => ({ ok: true, value: descriptor }),
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as unknown,
          authorization: new Headers(init?.headers).get('authorization') });
        return new Response('{}');
      },
    });
    await wake();
    expect(calls).toEqual([{ url: `${descriptor.origin}${CODEX_IDLE_WAKE_PATH}`,
      body: { v: 1, sessionId }, authorization: `Bearer ${descriptor.bindingCapability}` }]);
  });

  it('sends nothing for a foreign native thread or a cleared grant', async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => { calls += 1; return new Response('{}'); };
    await createInstalledCodexWake({ sessionId: 'foreign-thread', binding, descriptorPath: '/unused',
      readDescriptor: () => ({ ok: true, value: descriptor }), fetch })();
    await createInstalledCodexWake({ sessionId, binding, descriptorPath: '/unused',
      readDescriptor: () => ({ ok: true, value: { v: 1, channelId: 'channel-one',
        origin: descriptor.origin, transportCapability: 'A'.repeat(43) } }), fetch })();
    expect(calls).toBe(0);
  });
});
