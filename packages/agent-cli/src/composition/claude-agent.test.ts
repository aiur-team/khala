import { describe, expect, it, vi } from 'vitest';
import { createClaudeAgentEntry } from './claude-agent.js';
import type { ClaudeSessionClient } from './claude-session-http.js';

function client() {
  return {
    pull: vi.fn(async () => ({ kind: 'empty' as const })),
    read: vi.fn(async () => ({ kind: 'empty' as const })),
    send: vi.fn(async () => ({ kind: 'accepted' as const, clientTxnId: 'txn-12345678', eventId: null })),
    status: vi.fn(async () => ({ kind: 'status' as const, acknowledged: 1 })),
    mode: vi.fn(async () => ({ kind: 'refused' as const, code: 'unproven' as const })),
    setMode: vi.fn(async () => ({ kind: 'refused' as const, code: 'unproven' as const })),
    pending: vi.fn(async () => ({ kind: 'idle' as const })),
  } satisfies ClaudeSessionClient;
}

const MODE_SET = { commandId: 'command-1', expectedVersion: 1, requested: 'async', issuedAt: '2026-09-25T00:00:00Z' } as const;

describe('Claude agent entry point', () => {
  it('selects the session only from the MCP server’s CLAUDE_CODE_SESSION_ID, for every agent call', async () => {
    const composed = client();
    const agent = createClaudeAgentEntry(composed, { CLAUDE_CODE_SESSION_ID: 'session-from-env' });

    await agent.read();
    await agent.send('hello');
    await expect(agent.status()).resolves.toEqual({ kind: 'status', acknowledged: 1 });
    await agent.mode();
    await agent.setMode(MODE_SET);

    expect(composed.read).toHaveBeenCalledWith('session-from-env', undefined);
    expect(composed.send).toHaveBeenCalledWith('session-from-env', 'hello', undefined);
    expect(composed.status).toHaveBeenCalledWith('session-from-env', undefined);
    expect(composed.mode).toHaveBeenCalledWith('session-from-env', undefined);
    expect(composed.setMode).toHaveBeenCalledWith('session-from-env', MODE_SET, undefined);
    // Agent calls acknowledge; they never take the hook-only, non-acknowledging pull.
    expect(composed.pull).not.toHaveBeenCalled();
    expect(composed.pending).not.toHaveBeenCalled();
    expect(Object.keys(agent).sort()).toEqual(['mode', 'read', 'send', 'setMode', 'status']);
  });

  it('fails closed before any call when the session ID is missing or malformed', async () => {
    for (const env of [{}, { CLAUDE_CODE_SESSION_ID: '' }, { CLAUDE_CODE_SESSION_ID: 'bad\u0000id' }]) {
      const composed = client();
      const agent = createClaudeAgentEntry(composed, env);
      const outcomes = [await agent.read(), await agent.send('x'), await agent.status(), await agent.mode(), await agent.setMode(MODE_SET)];
      for (const outcome of outcomes) expect(outcome).toEqual({ kind: 'refused', code: 'session_missing' });
      for (const call of Object.values(composed)) expect(call).not.toHaveBeenCalled();
    }
  });
});
