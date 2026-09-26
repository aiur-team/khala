// U2: what each server-side store and log holds. The hosted relay (encrypted
// messaging transport) is not wired in this repository, so relay ciphertext and
// relay logs cannot be inspected here; a tripwire fails as soon as a relay adapter
// appears, so this suite gains a real relay case before anyone reads the gap as a
// pass. What is wired is inspected: the internal-mode loopback server's store and
// logs, and the hosted connector's owner-local ledger.

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeLeaks, mintCanary, scanTree } from './fixtures';
import { closeHostedWorlds, runGatedRelease } from './hosted-world';
import { REPO_ROOT } from './inventory';
import { type InternalWorld, channelId, otherChannelId, startInternalWorld } from './internal-world';

const worlds: InternalWorld[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.close();
  await closeHostedWorlds();
});

async function world(): Promise<InternalWorld> {
  const started = await startInternalWorld();
  worlds.push(started);
  return started;
}

describe('server-side stores and logs', () => {
  it('internal mode keeps message plaintext in the host channel store: a documented non-guarantee', async () => {
    const w = await world();
    const own = mintCanary('own');
    const other = mintCanary('other');
    w.say(channelId, own.text);
    w.say(otherChannelId, other.text);
    // Local single-machine mode has no relay and no end-to-end encryption. Any process
    // running as the same OS user can read this store; the connector gate does not
    // cover it. If this stops holding, the evidence file must be updated.
    const found = scanTree(w.serverState, [own, other]).map(leak => leak.canary);
    expect(new Set(found)).toEqual(new Set(['own', 'other']));
  });

  it('internal-mode server logs and error responses never carry a message body', async () => {
    const w = await world();
    const canary = mintCanary('body');
    w.say(channelId, canary.text);
    const responses = [
      // Malformed, oversized and cross-channel sends that carry the canary in the request.
      await w.http('POST', `/api/v1/channels/${channelId}/messages`, { body: { clientTxnId: 'txn-bad', content: { v: 1, kind: 'html', body: canary.text } } }),
      await w.http('POST', `/api/v1/channels/${channelId}/messages`, { body: { clientTxnId: 'txn-big', content: { v: 1, kind: 'text', body: `${canary.text}${'x'.repeat(256 * 1024)}` } } }),
      await w.http('POST', `/api/v1/channels/${otherChannelId}/messages`, { body: { clientTxnId: 'txn-x', content: { v: 1, kind: 'text', body: canary.text } } }),
      await w.http('GET', `/api/v1/channels/${channelId}/timeline?cursor=${canary.core}`),
      await w.http('GET', `/api/v1/channels/${channelId}/timeline`, { bearer: 'A'.repeat(43) }),
    ];
    for (const response of responses) expect(response.status).toBeGreaterThanOrEqual(400);
    const echoed = responses.flatMap((response, index) => (response.body.includes(canary.core) ? [index] : []));
    expect(echoed, 'error responses that echo the body').toEqual([]);
    expect(JSON.stringify(w.logs)).not.toContain(canary.core);
    expect(w.logs.length).toBeGreaterThan(0);
  });

  it('the hosted connector keeps pending plaintext only in the owner-local ledger, never in the model session', async () => {
    const gated = await runGatedRelease();
    // The owner connector is a trusted endpoint that may hold pending plaintext (KTD3).
    const ledger = scanTree(gated.state.state, [gated.pending]);
    expect(ledger.map(leak => leak.where)).toEqual(expect.arrayContaining([expect.stringMatching(/^ledger\.sqlite/)]));
    const session = gated.capture.leaks([gated.pending]);
    expect(session, describeLeaks(session)).toEqual([]);
    // Nothing outside the owner state directory holds it: the session's working directory is clean.
    const workdir = path.dirname(gated.state.state);
    const outside = scanTree(workdir, [gated.pending]).filter(leak => !leak.where.startsWith('state/'));
    expect(outside, describeLeaks(outside)).toEqual([]);
  });

  it('tripwire: no encrypted relay adapter is wired, so relay confidentiality stays not-observed', () => {
    const manifests = ['packages/messaging/package.json', 'packages/connector/package.json', 'apps/connector/package.json', 'apps/control/package.json']
      .map(file => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')) as { dependencies?: Record<string, string> });
    const relayDependencies = manifests.flatMap(manifest => Object.keys(manifest.dependencies ?? {}))
      .filter(name => /matrix|megolm|olm|mls/i.test(name));
    // A relay SDK arriving means relay ciphertext and logs can be inspected: add that
    // case to this suite and update docs/evidence/security-acceptance.md.
    expect(relayDependencies).toEqual([]);
  });
});
