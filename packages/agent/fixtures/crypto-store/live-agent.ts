import { createKhalaAgentClient } from '../../src/client-impl';
import type { AgentCredentials } from '@khala/contracts/m1/agent-join';
process.once('message', async (input: { credentials: AgentCredentials; root: string; restore?: boolean }) => {
  try {
    let credentials = input.credentials;
    const client = createKhalaAgentClient({ harness: 'codex', sessionId: 'live-restart', rejoinable: true,
      env: { ...process.env, XDG_STATE_HOME: input.root, HOME: input.root },
      onInboxAppend: entry => process.send?.({ kind: 'message', message: entry }),
      joinApi: {
        requestJoin: async () => ({ origin: credentials.homeserver, joinId: 'fixture', pollSecret: 'fixture', confirmUrl: credentials.homeserver, expiresAt: new Date(Date.now() + 60_000).toISOString(), autoConfirmed: true }),
        pollJoin: async () => credentials,
        reportReady: async () => {},
      },
    });
    process.send?.({ kind: 'started' });
    if (input.restore) await client.resume();
    else await client.join(credentials.homeserver + '/join/fixture', 'Agent');
    const deadline = Date.now() + 60_000;
    while ((await client.status()).state !== 'connected') {
      if (Date.now() > deadline) throw new Error('connect_timeout');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    process.send?.({ kind: 'ready' });
    process.on('message', async (request: unknown) => {
      if (request === 'status') process.send?.({ kind: 'status', status: await client.status() });
      if (typeof request === 'object' && request !== null && 'rejoin' in request) {
        credentials = (request as { rejoin: AgentCredentials }).rejoin;
        await client.join(credentials.homeserver + '/join/reinvite', 'Agent');
        const deadline = Date.now() + 60_000;
        while ((await client.status()).state !== 'connected') {
          if (Date.now() > deadline) throw new Error('reinvite_timeout');
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        process.send?.({ kind: 'rejoined' });
      }
      if (request === 'history') process.send?.({ kind: 'history', page: await client.read(100) });
      if (request === 'mode') process.send?.({ kind: 'mode', command: { content: { mode: (await client.status()).listeningMode } } });
      if (request === 'close') { await client.close(); process.disconnect(); process.exit(0); }
    });
  } catch (error) { process.send?.({ kind: 'error', message: error instanceof Error ? error.message : 'failed' }); process.exit(1); }
});
