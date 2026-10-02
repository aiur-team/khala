import { describe, expect, it } from 'vitest';
import { resolveHarness, resolveSessionId } from './session-id';

describe('harness selection', () => {
  it('prioritizes flag, then recognized environment, then Claude presence', () => {
    expect(resolveHarness(['--harness', 'codex'], { KHALA_MCP_HARNESS: 'claude' })).toBe('codex');
    expect(resolveHarness([], { KHALA_MCP_HARNESS: 'claude' })).toBe('claude');
    expect(resolveHarness([], { KHALA_MCP_HARNESS: 'codex', CLAUDE_CODE_SESSION_ID: 'a' })).toBe('codex');
    expect(resolveHarness([], { KHALA_MCP_HARNESS: 'bad', CLAUDE_CODE_SESSION_ID: '' })).toBe('claude');
    expect(resolveHarness([], {})).toBe('codex');
    expect(resolveHarness(['--harness', 'claude'], {})).toBe('claude');
  });
  it.each([['--harness'], ['--harness', 'gemini']])('rejects invalid flag %j', (...argv) => {
    expect(resolveHarness(argv, {})).toBe('invalid');
  });
});

describe('session resolution', () => {
  it('uses Claude environment and Codex metadata with environment fallback', () => {
    expect(resolveSessionId('claude', { threadId: 'ignored' }, { CLAUDE_CODE_SESSION_ID: 'abc-123' })).toBe('abc-123');
    expect(resolveSessionId('codex', { threadId: 't1' }, { CODEX_THREAD_ID: 't2' })).toBe('t1');
    expect(resolveSessionId('codex', undefined, { CODEX_THREAD_ID: 't2' })).toBe('t2');
    expect(resolveSessionId('codex', { threadId: 7 }, { CODEX_THREAD_ID: 't2' })).toBe('t2');
    expect(resolveSessionId('codex', { threadId: '../x' }, { CODEX_THREAD_ID: 't2' })).toBeNull();
  });
  it.each([undefined, '../x', '', '.x', 'a'.repeat(129), 'a\n'])('rejects unsafe id %j', value => {
    expect(resolveSessionId('claude', undefined, { CLAUDE_CODE_SESSION_ID: value })).toBeNull();
    expect(resolveSessionId('codex', undefined, { CODEX_THREAD_ID: value })).toBeNull();
  });
  it.each(['019a:thread.1', 'a'.repeat(128)])('accepts valid id %s', threadId => {
    expect(resolveSessionId('codex', { threadId }, {})).toBe(threadId);
  });
});
