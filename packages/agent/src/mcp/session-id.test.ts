import { describe, expect, it } from 'vitest';
import { resolveHarness, resolveSessionId } from './session-id';

describe('harness selection', () => {
  it('prioritizes flag, then recognized environment, then Claude presence', () => {
    expect(resolveHarness(['--harness', 'codex'], { KHALA_MCP_HARNESS: 'claude' })).toBe('codex');
    expect(resolveHarness([], { KHALA_MCP_HARNESS: 'claude' })).toBe('claude');
    expect(resolveHarness([], { KHALA_MCP_HARNESS: 'codex', CLAUDE_CODE_SESSION_ID: 'a' })).toBe('codex');
    expect(resolveHarness([], { KHALA_MCP_HARNESS: 'BAD', CLAUDE_CODE_SESSION_ID: '' })).toBe('claude');
    expect(resolveHarness([], {})).toBe('codex');
    expect(resolveHarness(['--harness', 'claude'], {})).toBe('claude');
  });
  it.each([['--harness'], ['--harness', '../unsafe']])('rejects invalid flag %j', (...argv) => {
    expect(resolveHarness(argv, {})).toBe('invalid');
  });
});

describe('session resolution', () => {
  it('uses Claude environment and Codex metadata with environment fallback', async () => {
    expect(await resolveSessionId('claude', { threadId: 'ignored' }, { CLAUDE_CODE_SESSION_ID: 'abc-123' })).toBe('abc-123');
    expect(await resolveSessionId('codex', { threadId: 't1' }, { CODEX_THREAD_ID: 't2' })).toBe('t1');
    expect(await resolveSessionId('codex', undefined, { CODEX_THREAD_ID: 't2' })).toBe('t2');
    expect(await resolveSessionId('codex', { threadId: 7 }, { CODEX_THREAD_ID: 't2' })).toBe('t2');
    expect(await resolveSessionId('codex', { threadId: '../x' }, { CODEX_THREAD_ID: 't2' })).toBeNull();
  });
  it.each([undefined, '../x', '', '.x', 'a'.repeat(129), 'a\n'])('rejects unsafe id %j', async value => {
    expect(await resolveSessionId('claude', undefined, { CLAUDE_CODE_SESSION_ID: value })).toBeNull();
    expect(await resolveSessionId('codex', undefined, { CODEX_THREAD_ID: value })).toBeNull();
  });
  it.each(['019a:thread.1', 'a'.repeat(128)])('accepts valid id %s', async threadId => {
    expect(await resolveSessionId('codex', { threadId }, {})).toBe(threadId);
  });
});
