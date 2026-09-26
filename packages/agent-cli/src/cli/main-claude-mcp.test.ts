// The production composition in `main()`, run in process: the Claude plugin's MCP entry
// (`mcp-serve` with `KHALA_MCP_HARNESS=claude`) must never compose the default-descriptor
// internal client or delivery (#402 follow-up). Both factories load lazily, so a recorder
// stands in front of each and the test asserts it never runs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loaded = vi.hoisted(() => ({ client: [] as string[], delivery: [] as string[] }));

vi.mock('../composition/internal.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../composition/internal.js')>();
  return {
    ...actual,
    createInternalClient: (options: Parameters<typeof actual.createInternalClient>[0]) => {
      loaded.client.push(options.descriptorPath);
      return actual.createInternalClient(options);
    },
  };
});
vi.mock('../composition/internal-delivery.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../composition/internal-delivery.js')>();
  return {
    ...actual,
    createInternalDelivery: (options: Parameters<typeof actual.createInternalDelivery>[0]) => {
      loaded.delivery.push(options.descriptorPath);
      return actual.createInternalDelivery(options);
    },
  };
});

const { main } = await import('./main.js');

const INITIALIZE = `${JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
})}\n`;

let state: string;
let written: string;

beforeEach(() => {
  loaded.client.length = 0;
  loaded.delivery.length = 0;
  state = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-main-'));
  written = '';
  vi.stubEnv('XDG_STATE_HOME', state);
  vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'session-402');
  // One request, then EOF: the entry answers it and exits.
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from([INITIALIZE]) as typeof process.stdin);
  for (const stream of [process.stdout, process.stderr]) {
    vi.spyOn(stream, 'write').mockImplementation((chunk: unknown, ...rest: unknown[]) => {
      written += String(chunk);
      const callback = rest.find(value => typeof value === 'function') as (() => void) | undefined;
      callback?.();
      return true;
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(state, { recursive: true, force: true });
});

describe('main: the Claude plugin MCP entry', () => {
  it('serves without composing the default-descriptor internal client or delivery', async () => {
    vi.stubEnv('KHALA_MCP_HARNESS', 'claude');
    await main(['mcp-serve']);
    expect(written).toContain('"id":1');
    expect(loaded).toEqual({ client: [], delivery: [] });
  });

  it('still composes them for a bare Codex mcp-serve, over the calling session\'s own grant (positive control)', async () => {
    vi.stubEnv('KHALA_MCP_HARNESS', undefined);
    const call = JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { _meta: { threadId: 'thread-a' }, name: 'khala_send', arguments: { message: 'm' } },
    });
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from([INITIALIZE, `${call}\n`]) as typeof process.stdin);
    await main(['mcp-serve']);
    const grant = path.join(state, 'khala', 'internal', 'discovery', 'agent_YG_M2xayccGs_VhHoWWJry3F7eXPGAHA30zODavNjXA', 'grant.json');
    expect(loaded).toEqual({ client: [grant], delivery: [grant] });
    expect(written).toContain('not_connected');
  });
});
