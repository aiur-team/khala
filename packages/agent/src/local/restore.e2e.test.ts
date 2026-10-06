import { describe, expect, it } from 'vitest';
import type { LocalChannelCreated } from '@khala/contracts/m1/local';
import { createWorld, cleanupWorld, cli, admin, deliver, inbox, armClaudeWake, startAgent } from './fixtures/e2e-harness';
import { eventually, readEgressLog } from './fixtures/egress';

// Real helper, MCP process, inbox, hooks and wake path; the egress guard records
// the Codex queue attempt without running an external harness.
describe.skipIf(process.env.KHALA_LOCAL_E2E !== '1')('MCP restore delivery', () => {
  it.each(['codex', 'claude'] as const)('%s catches a mention posted after SIGKILL, counts it unread and attempts a wake', async harness => {
    const world = await createWorld();
    try {
      const created = await cli(world, 'create', 'restore-gap');
      expect(created.code).toBe(0);
      const channel = created.data as LocalChannelCreated;
      let transaction = 0;
      const send = (body: string) => admin(world, 'POST', `/api/local/rooms/${encodeURIComponent(channel.roomId)}/send`, {
        txnId: `restore-${++transaction}`, type: 'm.room.message', content: { msgtype: 'm.text', body },
      });
      expect((await send('before-original-join')).status).toBe(200);
      const agent = world[harness];
      const joined = await agent.call('khala_join', { link: channel.selfLink });
      expect(joined.structuredContent.state).toBe('connected');
      await deliver(agent, 'UserPromptSubmit');
      expect(await deliver(agent, 'Stop')).toBeNull();
      const watcher = harness === 'claude' ? await armClaudeWake(agent) : undefined;
      agent.child.kill('SIGKILL');
      await agent.closed;
      const body = `@kevin-${harness === 'codex' ? 'Codex' : 'Claude'} missed-during-MCP-gap`;
      expect((await send(body)).status).toBe(200);
      expect((await inbox(agent)).some(entry => entry.body === body)).toBe(false);
      const restarted = await startAgent(world, harness, agent.sessionId);
      world[harness] = restarted;
      if (harness === 'codex') await restarted.call('khala_status');
      await eventually(async () => (await inbox(restarted)).some(entry => entry.body === body));
      const status = await restarted.call('khala_status');
      expect(status.structuredContent.unread).toBeGreaterThanOrEqual(1);
      expect((await inbox(restarted)).some(entry => entry.body === 'before-original-join')).toBe(false);
      if (watcher) expect((await watcher.exited).code).toBe(2);
      else await eventually(async () => (await readEgressLog(world.log)).some(record =>
        record.kind === 'exec' && record.pid === restarted.pid && record.file === 'codex' && !record.allowed));
      expect(JSON.stringify(await deliver(restarted, 'UserPromptSubmit'))).toContain(body);
      expect(await deliver(restarted, 'Stop')).toBeNull();
    } finally { await cleanupWorld(world); }
  }, 120_000);
});
