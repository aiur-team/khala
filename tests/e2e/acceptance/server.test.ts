// The runner's server-side adapters against the real internal launcher: the owner
// session, the server's refusal of a stale or wrong Stop target, and the
// post-shutdown snapshot, which refuses to read a live store.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ownerSessionFor, reachable } from '../../../scripts/acceptance/adapters/launcher';
import { readChannelSnapshot } from '../../../scripts/acceptance/adapters/snapshot';
import { type KhalaProfile, type RunningLauncher, freePort, privateDirectory, startLauncher } from '../harness/internal';

let launcher: RunningLauncher | null = null;
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await launcher?.close();
  launcher = null;
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function profile(): Promise<KhalaProfile> {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-acceptance-server-'));
  directories.push(stateHome);
  privateDirectory(stateHome);
  return { stateHome, stateDirectory: privateDirectory(stateHome, 'khala'), port: await freePort() };
}

describe('runner server adapters over the real launcher', () => {
  it('requires the exact revoke operation and a new revision in the owner reply', async () => {
    const origin = 'http://127.0.0.1:4870';
    const channelId = 'channel_offline';
    const report = { origin, channelId, url: `${origin}/#credential=secret&channel=${channelId}` };
    const request = { requestHandle: 'request_123', revision: 'carev_2', createdAt: new Date().toISOString(),
      outcome: 'connecting', harness: 'codex', sessionFingerprint: 'digest' };
    const operationId = 'acc-revoke-0123456789ab-1001';
    let reply: Record<string, unknown> = { v: 1, requestHandle: request.requestHandle, channelId,
      outcome: 'revoked', revision: 'carev_3', operationId };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/__khala/session')) {
        return new Response(JSON.stringify({ requestSecret: 'csrf' }), {
          status: 200, headers: { 'set-cookie': 'session=test; Path=/' },
        });
      }
      return new Response(JSON.stringify(reply), { status: 200 });
    }));
    const owner = await ownerSessionFor(report);
    await expect(owner.revokeRequest(request, operationId)).resolves.toBeUndefined();
    for (const wrong of [
      { operationId: 'a-different-revoke' },
      { revision: request.revision },
      { requestHandle: 'request_other' },
      { channelId: 'channel_other' },
    ]) {
      reply = { ...reply, ...wrong };
      await expect(owner.revokeRequest(request, operationId)).rejects.toThrow(/request revoke unproven/);
      reply = { v: 1, requestHandle: request.requestHandle, channelId,
        outcome: 'revoked', revision: 'carev_3', operationId };
    }
  });

  it('acts as the owner, refuses a stale Stop target, and snapshots only after the launcher closes', async () => {
    const khala = await profile();
    const internalRoot = path.join(khala.stateHome, 'khala', 'internal');
    launcher = await startLauncher(khala);
    const { report } = launcher;
    const owner = await ownerSessionFor(report);
    expect(owner.channelUrl).toBe(`${report.origin}/channels/${report.channelId}`);

    const eventId = await owner.say('owner line', 'acc-owner-0001');
    const timeline = await owner.timeline();
    expect(timeline.map(event => [event.eventId, event.authorKind, event.body])).toEqual([[eventId, 'human', 'owner line']]);
    expect(await owner.accessRequests()).toEqual([]);
    expect(await owner.bindings()).toEqual([]);

    // A binding the server never issued, or an old generation of one, is refused before anything is revoked.
    const stale = await owner.stop([{ bindingId: 'binding_never_issued', generation: 1, agentParticipantId: 'participant_nobody' }]);
    expect(stale).toEqual({ kind: 'refused', status: 409, code: 'operation_mismatch' });
    expect(await owner.viewable()).toBe(true);

    // The live store is never opened while a launcher holds the internal root.
    expect(() => readChannelSnapshot(internalRoot, report.channelId)).toThrow(/launcher still holds/);

    expect(await launcher.close()).toBe(0);
    launcher = null;
    expect(await reachable(report.origin)).toBe(false);
    const snapshot = readChannelSnapshot(internalRoot, report.channelId);
    expect(snapshot.events.map(event => event.eventId)).toEqual([eventId]);
    expect(snapshot.events[0]!.clientTxnId).toBe('acc-owner-0001');
    expect(snapshot.bindings).toEqual([]);
    expect(snapshot.receipts).toEqual([]);
  }, 60_000);
});
