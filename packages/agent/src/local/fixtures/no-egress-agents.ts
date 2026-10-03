import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createKhalaAgentClient } from '../../client-impl';
import { sessionFiles } from '../../state';
import { createLocalSession } from '../session';
import type { AgentCredentials } from '@khala/contracts/m1/agent-join';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { selfLink, shareLink, nonce, hostile } = JSON.parse(input) as { selfLink: string; shareLink: string; nonce: string; hostile?: boolean };
if (hostile) {
  for (const homeserver of ['http://192.0.2.1:443', 'http://khala.invalid:443', 'http://0.0.0.0:443']) {
    const creds: AgentCredentials = { transport: 'local', homeserver, roomId: '!c7Kq2vXbT1nP0aZ9yW3eQw:local', userId: '@agent-a1b2c3d4:local', deviceId: 'KH_LOCAL_a1b2c3d4', accessToken: 'test-only' };
    await assert.rejects(createLocalSession(creds));
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
    for (const harness of ['claude', 'codex'] as const) {
      const creds = JSON.parse(await readFile(sessionFiles(harness, `egress-${nonce}`).session, 'utf8')) as AgentCredentials;
      assert.equal(creds.transport, 'local');
      assert.ok(['127.0.0.1', 'localhost'].includes(new URL(creds.homeserver).hostname));
    }
    const ping = `egress-ping-${nonce}`; const pong = `egress-pong-${nonce}`;
    const claudeId = (await claude.status()).agentUserId;
    const codexId = (await codex.status()).agentUserId;
    await claude.send(ping);
    await wait(async () => (await codex.read(100)).messages.some(message => message.body === ping && message.sender === claudeId));
    await codex.send(pong);
    await wait(async () => (await claude.read(100)).messages.some(message => message.body === pong && message.sender === codexId));
    console.log(JSON.stringify({ ok: true, claude: claudeId, codex: codexId, codexSaw: ping, claudeSaw: pong }));
  } finally { await Promise.all([claude.close(), codex.close()]); }
}
