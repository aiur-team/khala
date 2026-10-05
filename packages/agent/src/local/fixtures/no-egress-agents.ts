import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createKhalaAgentClient } from '../../client-impl';
import { KhalaClientError } from '../../client';
import { channelFiles, sessionFiles } from '../../state';
import { createLocalSession } from '../session';
import { helperPaths } from '../lifecycle';
import { readEntries } from '../../inbox';
import type { AgentCredentials } from '@khala/contracts/m1/agent-join';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { roomId, selfLink, shareLink, nonce, hostile, accessToken } = JSON.parse(input) as { roomId: string; selfLink: string; shareLink: string; nonce: string; hostile?: boolean; accessToken?: string };
if (hostile) {
  assert.ok(accessToken);
  for (const homeserver of [
    'http://192.0.2.1:443', 'http://khala.invalid:443', 'http://0.0.0.0:443',
    'https://khala.invalid:443', 'https://127.0.0.1:443',
    'http://test-only@127.0.0.1:443', 'http://127.0.0.1:443/test-only',
    'http://127.0.0.1:443?token=test-only', 'http://127.0.0.1:443#test-only',
  ]) {
    const creds: AgentCredentials = { transport: 'local', homeserver, roomId: '!c7Kq2vXbT1nP0aZ9yW3eQw:local', userId: '@agent-a1b2c3d4:local', deviceId: 'KH_LOCAL_a1b2c3d4', accessToken };
    await assert.rejects(createLocalSession(creds), (error: unknown) => {
      assert.ok(error instanceof KhalaClientError);
      assert.equal(error.code, 'internal_error');
      assert.equal(error.message, 'invalid_local_origin');
      assert.ok(![String(error), error.stack ?? '', JSON.stringify(error)].some(value => value.includes(accessToken)));
      return true;
    });
  }
  console.log(JSON.stringify({ ok: true }));
} else {
  const claude = createKhalaAgentClient({ harness: 'claude', sessionId: `egress-${nonce}`, env: process.env });
  const codex = createKhalaAgentClient({ harness: 'codex', sessionId: `egress-${nonce}`, env: process.env });
  async function wait(check: () => Promise<boolean>): Promise<void> {
    const end = Date.now() + 10_000;
    do { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); } while (Date.now() < end);
    throw new Error('receipt_timeout');
  }
  try {
    await claude.join(selfLink, 'claude');
    await codex.join(shareLink, 'codex');
    await wait(async () => (await claude.status()).state === 'connected' && (await codex.status()).state === 'connected');
    const claudeFiles = channelFiles(sessionFiles('claude', `egress-${nonce}`), (await claude.status()).channels![0]!.roomId);
    const codexFiles = channelFiles(sessionFiles('codex', `egress-${nonce}`), (await codex.status()).channels![0]!.roomId);
    for (const harness of ['claude', 'codex'] as const) {
      const creds = JSON.parse(await readFile((harness === 'claude' ? claudeFiles : codexFiles).session, 'utf8')) as AgentCredentials;
      assert.equal(creds.transport, 'local');
      assert.ok(['127.0.0.1', 'localhost'].includes(new URL(creds.homeserver).hostname));
    }
    const ping = `egress-ping-${nonce}`; const pong = `egress-pong-${nonce}`;
    const claudeId = (await claude.status()).agentUserId;
    const codexId = (await codex.status()).agentUserId;
    await claude.send(ping);
    await wait(async () => (await codex.status()).unread >= 1
      && (await readEntries(codexFiles)).some(message => message.body === ping && message.sender === claudeId));
    await wait(async () => (await codex.read(100)).messages.some(message => message.body === ping && message.sender === claudeId));
    await codex.send(pong);
    await wait(async () => (await claude.status()).unread >= 1
      && (await readEntries(claudeFiles)).some(message => message.body === pong && message.sender === codexId));
    await wait(async () => (await claude.read(100)).messages.some(message => message.body === pong && message.sender === codexId));
    const helper = JSON.parse(await readFile(helperPaths(process.env).helperFile, 'utf8')) as { origin: string; adminToken: string };
    const channelPath = '/api/local/channels/' + encodeURIComponent(roomId);
    const modeResponse = await fetch(helper.origin + channelPath + '/mode', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + helper.adminToken, 'content-type': 'application/json' },
      body: JSON.stringify({ agent: codexId, mode: 'steer', txnId: 'egress_' + nonce }),
    });
    assert.equal(modeResponse.status, 200);
    assert.equal(typeof ((await modeResponse.json()) as { eventId: string }).eventId, 'string');
    await wait(async () => (await codex.status()).listeningMode === 'steer');
    const index = await fetch(helper.origin + '/');
    assert.equal(index.status, 200);
    assert.ok((await index.text()).includes('/assets/egress.js'));
    const asset = await fetch(helper.origin + '/assets/egress.js');
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), '/* no-egress static fixture */');
    const removal = await fetch(helper.origin + channelPath + '/members/' + encodeURIComponent(codexId!), {
      method: 'DELETE', headers: { authorization: 'Bearer ' + helper.adminToken },
    });
    assert.equal(removal.status, 204);
    await wait(async () => {
      const status = await codex.status();
      return status.state === 'disconnected' && status.detail === 'removed';
    });
    console.log(JSON.stringify({ ok: true, claude: claudeId, codex: codexId, codexSaw: ping, claudeSaw: pong,
      liveReceipts: true, mode: 'steer', removed: true, web: true }));
  } finally { await Promise.all([claude.close(), codex.close()]); }
}
