import { it } from 'vitest';
import { startInternalWorld, channelId, otherChannelId } from './internal-world';
it('debug', async () => {
  const w = await startInternalWorld();
  const tries: [string, string, any][] = [
    ['GET', '/__khala/bootstrap', { bearer: null }], ['GET', '/__khala/bootstrap.js', { bearer: null }],
    ['POST', '/__khala/session', { bearer: null, body: { credential: w.bearer, channelId: otherChannelId } }],
    ['GET', '/api/v1/session', {}], ['POST', '/api/v1/channels', { body: { operationId: 'op-x', title: 'a' } }],
    ['GET', `/api/v1/channels/${channelId}/timeline`, {}],
    ['GET', `/api/v1/channels/${channelId}/../${otherChannelId}/timeline`, {}],
    ['GET', `/api/v1/channels/${otherChannelId}%2F/timeline`, {}],
    ['POST', `/api/v1/channels/${otherChannelId}/messages`, { body: { a: 1 } }],
    ['GET', `/channels/${channelId}`, { bearer: null }],
  ];
  for (const [m, r, o] of tries) {
    const t = Date.now();
    const res = await Promise.race([w.http(m, r, o), new Promise(res => setTimeout(() => res('TIMEOUT'), 1500))]);
    console.log(m, r, Date.now() - t, JSON.stringify(res).slice(0, 150));
  }
  await w.close();
}, 30000);
