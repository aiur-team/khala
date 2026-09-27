import { describe, expect, it, vi } from 'vitest';
import { connectTool } from './connect.js';
import { ConnectService } from '../cli/connect.js';
import { createUnavailableClient } from '../composition/unavailable.js';

describe('khala_connect', () => {
  it('has a one-link schema and never starts a bootstrap from a notification', async () => {
    expect(connectTool.definition().inputSchema).toEqual({
      type: 'object', required: ['url'], additionalProperties: false,
      properties: { url: { type: 'string', description: expect.any(String) } },
    });
    const connect = vi.fn(async () => ({ kind: 'unavailable' as const }));
    const context = { id: 1, notification: true,
      connect: new ConnectService({ ...createUnavailableClient(), connect }) } as never;
    expect(await connectTool.call({ url: 'https://khala.aiur.team/i/room' }, context)).toEqual({
      jsonrpc: '2.0', id: 1, result: {},
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it('rejects extra arguments and never echoes a link or raw transport error', async () => {
    const connect = vi.fn(async () => { throw new Error('secret transport detail'); });
    const context = { id: 2, notification: false,
      connect: new ConnectService({ ...createUnavailableClient(), connect }) } as never;
    const invalid = await connectTool.call({ url: 'https://khala.aiur.team/i/room', extra: true }, context);
    expect(invalid.error).toMatchObject({ code: -32602 });
    expect(connect).not.toHaveBeenCalled();
    const response = await connectTool.call({ url: 'https://khala.aiur.team/i/room' }, context);
    expect(response.result).toMatchObject({ structuredContent: { ok: false, error: 'unavailable' }, isError: true });
    expect(JSON.stringify(response)).not.toContain('secret transport detail');
    expect(JSON.stringify(response)).not.toContain('/i/room');
  });
});
