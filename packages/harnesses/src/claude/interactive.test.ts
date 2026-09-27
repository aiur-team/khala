import { describe, expect, it } from 'vitest';
import { decodeHarnessCapabilities } from '@khala/contracts/delivery/index';
import {
  CLAUDE_INTERACTIVE_PROVEN, CLAUDE_INTERACTIVE_ROUTE, installedClaudeCapabilities, interactiveClaudeCapabilities,
} from './interactive';
import { limits } from '../codex/fakes';

const proven = [{ version: '2.1.283', route: CLAUDE_INTERACTIVE_ROUTE }] as const;
const statuses = (capabilities: ReturnType<typeof interactiveClaudeCapabilities>) =>
  Object.values(capabilities.modes).map(mode => mode.status);

describe('interactive Claude capabilities', () => {
  it('claims tested support only for the exact proven version and route', () => {
    const capabilities = interactiveClaudeCapabilities('2.1.283', CLAUDE_INTERACTIVE_ROUTE, limits, proven);
    expect(decodeHarnessCapabilities(capabilities)).toEqual({ ok: true, value: capabilities });
    expect(capabilities).toMatchObject({ support: 'tested', acknowledgement: 'batch_token_next_call', version: '2.1.283' });
    // Receipt proof says nothing about mode delivery: the modes stay experimental.
    expect(statuses(capabilities)).toEqual(['experimental', 'experimental', 'experimental']);
  });

  it.each([
    ['another version', '2.1.284'],
    ['an older version', '2.1.282'],
  ])('labels %s experimental, never proven', (_label, version) => {
    const capabilities = interactiveClaudeCapabilities(version, CLAUDE_INTERACTIVE_ROUTE, limits, proven);
    expect(decodeHarnessCapabilities(capabilities)).toEqual({ ok: true, value: capabilities });
    expect(capabilities).toMatchObject({
      support: 'experimental', acknowledgement: 'batch_token_next_call', existingSession: 'native_hooks', version,
    });
    expect(statuses(capabilities)).toEqual(['experimental', 'experimental', 'experimental']);
    // The owner's experimental-route grant is pinned to this exact version.
    expect(capabilities.modes.sync).toMatchObject({ route: `${CLAUDE_INTERACTIVE_ROUTE}-sync`, testedVersion: version });
    expect(capabilities.modes.sync.reason).toContain('no retained read-receipt proof');
    expect(capabilities.modes.sync.reason).toContain('only at their next turn');
  });

  it('claims nothing for another route', () => {
    const capabilities = interactiveClaudeCapabilities('2.1.283', 'claude-hosted-stream', limits, proven);
    expect(decodeHarnessCapabilities(capabilities).ok).toBe(true);
    expect(capabilities).toMatchObject({ support: 'unsupported', acknowledgement: 'unknown', existingSession: 'unknown' });
    expect(statuses(capabilities)).toEqual(['unknown', 'unknown', 'unknown']);
  });

  it('ships with no proven pair, so an installed version is experimental until a live run is retained', () => {
    expect(CLAUDE_INTERACTIVE_PROVEN).toEqual([]);
    expect(interactiveClaudeCapabilities('2.1.283', CLAUDE_INTERACTIVE_ROUTE, limits).support).toBe('experimental');
  });

  it('keeps an uninspected or uncarriable installed version unproven', () => {
    expect(installedClaudeCapabilities('2.1.283', limits)).toMatchObject({ support: 'experimental', acknowledgement: 'batch_token_next_call' });
    for (const version of [null, 'not a version']) {
      const capabilities = installedClaudeCapabilities(version, limits);
      expect(capabilities).toMatchObject({ support: 'unsupported', acknowledgement: 'unknown', version: 'unknown' });
      expect(statuses(capabilities)).toEqual(['unknown', 'unknown', 'unknown']);
    }
  });
});
