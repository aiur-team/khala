// U2: what each server-side store and log holds. The encrypted relay (Synapse) is
// reached only from the human browser flow, and only a disposable live deployment
// can show its records and logs; this suite had none, so relay confidentiality is
// not observed here. A tripwire fails when a new relay path appears. What runs
// in-process is inspected: the internal-mode loopback server's store and logs, and
// the hosted connector's owner-local ledger.

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeLeaks, mintCanary, scanTree } from './fixtures';
import { closeHostedWorlds, runGatedRelease } from './hosted-world';
import { REPO_ROOT, relayAdapterEvidence } from './inventory';
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

  it('the relay is reached only from the human browser flow, which creates encrypted rooms', () => {
    // KHA-132 wires the browser to Synapse; no connector or agent path reaches the relay. A new
    // relay path (for example a connector Matrix adapter) fails here, so its ciphertext, logs and
    // keys get a case in this suite before anyone reads the gap as a pass.
    expect(relayAdapterEvidence()).toEqual([
      'apps/web: matrix-js-sdk',
      'apps/control/src/composition/human/matrix.ts',
      'apps/web/src/composition/human/matrix-browser.ts',
    ]);
    // Configuration only, not proof of confidentiality: rooms are created with Megolm enabled
    // and the client initialises Rust crypto. Relay records and logs were not inspected here.
    const browser = fs.readFileSync(path.join(REPO_ROOT, 'apps/web/src/composition/human/matrix-browser.ts'), 'utf8');
    expect(browser).toMatch(/type: EventType\.RoomEncryption, state_key: '', content: \{ algorithm: 'm\.megolm\.v1\.aes-sha2' \}/);
    expect(browser).toContain('initRustCrypto(');
  });
});
