import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import { encodeInternalDescriptor, type InternalDescriptor } from '@khala/contracts/internal/descriptor';
import { internalSessionDigest } from './internal-session.js';
import { INTERNAL_TURN_END_PATH, readOpenCodeTerminalId, sendInternalTurnEnd } from './internal-turn-end.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const nativeSession = 'ses_bound_native';
const BINDING_CAPABILITY = `${'B'.repeat(42)}A`;
const binding = {
  v: 1, bindingId: 'binding-oc', ownerId: 'owner-1', agentParticipantId: 'agent-1', deviceId: 'device-1',
  harness: 'opencode', sessionId: internalSessionDigest('opencode', nativeSession), generation: 3,
} as SessionBinding;
const descriptor: InternalDescriptor = {
  v: 1, channelId: 'channel-one', origin: 'http://127.0.0.1:4100', transportCapability: 'A'.repeat(43),
  grantRef: 'grant-1', bindingId: 'binding-oc', bindingCapability: BINDING_CAPABILITY,
};

function file(value: InternalDescriptor = descriptor): string {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-turn-end-'));
  roots.push(root);
  const target = path.join(root, 'grant.json');
  fs.writeFileSync(target, encodeInternalDescriptor(value), { mode: 0o600 });
  return target;
}

describe('internal native turn-end report', () => {
  it('uses the exact private grant and channel without putting secrets into the body', async () => {
    const descriptorPath = file();
    const stateDirectory = path.dirname(descriptorPath);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const transport: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init! });
      return new Response('{"v":1}', { status: 200 });
    };
    expect(await sendInternalTurnEnd({ descriptorPath, stateDirectory, fetch: transport }, binding, nativeSession, 'native-message-7')).toBe(true);
    expect(readOpenCodeTerminalId(stateDirectory, binding)).toBe('native-message-7');
    expect(readOpenCodeTerminalId(stateDirectory, { ...binding, generation: 4 })).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${descriptor.origin}${INTERNAL_TURN_END_PATH}`);
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.redirect).toBe('error');
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe(`Bearer ${BINDING_CAPABILITY}`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ v: 1, sessionId: nativeSession, channelId: 'channel-one', terminalId: 'native-message-7' });
    expect(String(calls[0]!.init.body)).not.toContain('bindingCapability');
    // The bridge-local OpenCode overlay carries the raw ID; the server binding carries its digest.
    expect(await sendInternalTurnEnd({ descriptorPath, fetch: transport },
      { ...binding, sessionId: nativeSession }, nativeSession)).toBe(true);
    expect(readOpenCodeTerminalId(stateDirectory, { ...binding, sessionId: nativeSession })).toBeNull();
  });

  it('does not post for a foreign session, binding, or unsafe or ungranted descriptor', async () => {
    const descriptorPath = file();
    let calls = 0;
    const transport: typeof fetch = async () => { calls += 1; return new Response('{"v":1}', { status: 200 }); };
    expect(await sendInternalTurnEnd({ descriptorPath, fetch: transport }, binding, 'other-session')).toBe(false);
    expect(await sendInternalTurnEnd({ descriptorPath, fetch: transport }, binding, nativeSession, 'native-message-7')).toBe(false);
    expect(await sendInternalTurnEnd({ descriptorPath, fetch: transport },
      { ...binding, bindingId: 'other-binding' as SessionBinding['bindingId'] }, nativeSession)).toBe(false);
    expect(await sendInternalTurnEnd({ descriptorPath: file({ v: 1, channelId: 'channel-one', origin: descriptor.origin,
      transportCapability: 'A'.repeat(43) }), fetch: transport }, binding, nativeSession)).toBe(false);
    const symlink = path.join(path.dirname(descriptorPath), 'link.json');
    fs.symlinkSync(descriptorPath, symlink);
    expect(await sendInternalTurnEnd({ descriptorPath: symlink, fetch: transport }, binding, nativeSession)).toBe(false);
    expect(calls).toBe(0);
  });

  it('fails closed on server refusal, invalid reply, network failure, and rotated grants', async () => {
    const descriptorPath = file();
    const refusals: typeof fetch = async () => new Response('{}', { status: 403 });
    expect(await sendInternalTurnEnd({ descriptorPath, fetch: refusals }, binding, nativeSession)).toBe(false);
    expect(await sendInternalTurnEnd({ descriptorPath, fetch: async () => new Response('{"v":1,"extra":true}') }, binding, nativeSession)).toBe(false);
    expect(await sendInternalTurnEnd({ descriptorPath, fetch: async () => { throw new Error('offline'); } }, binding, nativeSession)).toBe(false);
    fs.writeFileSync(descriptorPath, encodeInternalDescriptor({ ...descriptor, bindingId: 'new-binding', bindingCapability: `${'C'.repeat(42)}A` }));
    let invoked = false;
    expect(await sendInternalTurnEnd({ descriptorPath, fetch: async () => { invoked = true; return new Response('{"v":1}'); } },
      binding, nativeSession)).toBe(false);
    expect(invoked).toBe(false);
  });

  it('reads only an owner-private exact-generation marker and refuses descriptor failures', async () => {
    const descriptorPath = file();
    const stateDirectory = path.dirname(descriptorPath);
    const transport: typeof fetch = async () => new Response('{"v":1}');
    expect(await sendInternalTurnEnd({ descriptorPath, stateDirectory, fetch: transport }, binding, nativeSession, 'assistant-1')).toBe(true);
    const marker = path.join(stateDirectory, 'opencode-turn-end', fs.readdirSync(path.join(stateDirectory, 'opencode-turn-end'))[0]!);
    expect(fs.statSync(marker).mode & 0o777).toBe(0o600);
    expect(readOpenCodeTerminalId(stateDirectory, binding)).toBe('assistant-1');
    fs.chmodSync(marker, 0o644);
    expect(readOpenCodeTerminalId(stateDirectory, binding)).toBeNull();
    fs.chmodSync(marker, 0o600);
    const moved = `${marker}.moved`;
    fs.renameSync(marker, moved);
    fs.symlinkSync(moved, marker);
    expect(readOpenCodeTerminalId(stateDirectory, binding)).toBeNull();
    expect(await sendInternalTurnEnd({ descriptorPath, fetch: transport,
      readDescriptor: () => { throw new Error('unreadable'); } }, binding, nativeSession)).toBe(false);
  });
});
