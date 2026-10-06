import { describe, expect, it } from 'vitest';
import { defaultAgentName } from '@khala/contracts/m1/names';
import { harnessInfo } from '@khala/contracts/m1/harness';
import { adapterFor } from './index';
import { resolveHarness, resolveSession } from '../mcp/session-id';
import { genericDriver } from './conformance/drivers/generic';
import { runConformance } from './conformance/run';

describe('generic MCP adapter', () => {
  it.each(['generic', 'cline', 'custom-agent'])('keeps the %s id and uses environment before process', async id => {
    const adapter = adapterFor(id)!;
    expect(adapter.id).toBe(id);
    expect(adapter.codec).toBeUndefined();
    expect(adapter.sessionSources.map(source => source.kind)).toEqual(['env', 'process']);
    expect(resolveHarness(['--harness', id], {})).toBe(id);
    expect(resolveHarness([], { KHALA_MCP_HARNESS: id })).toBe(id);
    expect(await resolveSession(id, { threadId: 'ignored' }, { KHALA_SESSION_ID: 'stable' }))
      .toEqual({ sessionId: 'stable', rejoinable: true });
    expect(await resolveSession(id, undefined, {}, { pid: 200,
      readProcess: async pid => ({ pid, ppid: pid === 200 ? 100 : 0, command: 'mcp', startTime: 'start' }) }))
      .toEqual({ sessionId: 'proc-100-start', rejoinable: false });
    expect(await resolveSession(id, undefined, { KHALA_SESSION_ID: '../invalid' })).toBeNull();
  });
  it('keeps Cline identity and passes MCP rows while hook rows are unsupported', async () => {
    expect(defaultAgentName('kevin', 'cline')).toBe('kevin-Agent');
    expect(harnessInfo('cline').displayName).toBe('Cline');
    const result = await runConformance(adapterFor('cline')!, genericDriver);
    for (const feature of ['read', 'send', 'you=', 'async']) {
      expect(result.rows.find(row => row.feature === feature)?.status).toBe('pass');
    }
    for (const feature of ['steer', 'sync', 'idle wake']) {
      expect(result.rows.find(row => row.feature === feature)?.status).toBe('absent');
    }
  });
});
