import { describe, expect, it } from 'vitest';
import { decodeHarnessCapabilities } from '@khala/contracts/delivery/index';
import {
  CLAUDE_INTERACTIVE_PROVEN, CLAUDE_INTERACTIVE_ROUTE, interactiveClaudeCapabilities,
} from './interactive';
import { limits } from '../codex/fakes';

const proven = [{ version: '2.1.283', route: CLAUDE_INTERACTIVE_ROUTE }] as const;

describe('interactive Claude capabilities', () => {
  it('claims batch-token acknowledgement only for the exact proven version and route', () => {
    const capabilities = interactiveClaudeCapabilities('2.1.283', CLAUDE_INTERACTIVE_ROUTE, limits, proven);
    expect(decodeHarnessCapabilities(capabilities)).toEqual({ ok: true, value: capabilities });
    expect(capabilities).toMatchObject({ support: 'tested', acknowledgement: 'batch_token_next_call', version: '2.1.283' });
    // Receipt proof says nothing about mode delivery.
    expect(Object.values(capabilities.modes).map(mode => mode.status)).toEqual(['unknown', 'unknown', 'unknown']);
  });

  it.each([
    ['another version', '2.1.284', CLAUDE_INTERACTIVE_ROUTE],
    ['an older version', '2.1.282', CLAUDE_INTERACTIVE_ROUTE],
    ['another route', '2.1.283', 'claude-hosted-stream'],
  ])('stays unknown for %s', (_label, version, route) => {
    const capabilities = interactiveClaudeCapabilities(version, route, limits, proven);
    expect(decodeHarnessCapabilities(capabilities).ok).toBe(true);
    expect(capabilities).toMatchObject({ support: 'unsupported', acknowledgement: 'unknown', existingSession: 'unknown' });
    expect(capabilities.modes.sync.reason).toContain('no retained read-receipt proof');
  });

  it('ships with no proven pair until a live run is retained', () => {
    expect(CLAUDE_INTERACTIVE_PROVEN).toEqual([]);
    expect(interactiveClaudeCapabilities('2.1.283', CLAUDE_INTERACTIVE_ROUTE, limits).acknowledgement).toBe('unknown');
  });
});
