import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeHarnessCapabilities } from '@khala/contracts/delivery/index';
import {
  CLAUDE_INTERACTIVE_MODE_EVIDENCE_REF, CLAUDE_INTERACTIVE_MODE_EVIDENCE_REVISION,
  CLAUDE_INTERACTIVE_MODE_PROVEN, CLAUDE_INTERACTIVE_PROVEN, CLAUDE_INTERACTIVE_ROUTE,
  installedClaudeCapabilities, interactiveClaudeCapabilities,
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
    expect(statuses(capabilities)).toEqual(['proven', 'experimental', 'proven']);
    expect(capabilities.immediateNotification).toBe('unknown');
    for (const mode of Object.values(capabilities.modes)) {
      expect(mode).toMatchObject({ evidenceRef: CLAUDE_INTERACTIVE_MODE_EVIDENCE_REF,
        evidenceRevision: CLAUDE_INTERACTIVE_MODE_EVIDENCE_REVISION, testedVersion: '2.1.283' });
    }
    expect(capabilities.modes.steer.reason).toContain('3000 seconds');
    expect(capabilities.modes.sync).toMatchObject({
      status: 'experimental', evidenceRef: CLAUDE_INTERACTIVE_MODE_EVIDENCE_REF,
      evidenceRevision: CLAUDE_INTERACTIVE_MODE_EVIDENCE_REVISION,
    });
    expect(capabilities.modes.sync.reason).toContain('after watcher timeout without a user prompt');
    expect(capabilities.modes.sync.reason).toContain('next native turn');
    expect(capabilities.modes.async.reason).toContain('hooks do not automatically deliver');
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

  it('ships only the retained exact version and route', () => {
    const evidence = JSON.parse(readFileSync(new URL('../../../../experiments/internal-mode/listening-modes/claude/evidence.json', import.meta.url), 'utf8')) as {
      claim: { version: string; route: string; immediateNotification: string; watchWindowSeconds: number };
      limitations: { unboundedIdleWakeProven: boolean; agentToAgentAutomaticWakeProven: boolean };
    };
    expect(CLAUDE_INTERACTIVE_PROVEN).toEqual(proven);
    expect(CLAUDE_INTERACTIVE_MODE_PROVEN).toEqual(['steer', 'async'].map(mode =>
      ({ version: evidence.claim.version, route: evidence.claim.route, mode })));
    expect(evidence.claim).toMatchObject({ immediateNotification: 'unknown', watchWindowSeconds: 3000 });
    expect(evidence.limitations).toMatchObject({ unboundedIdleWakeProven: false, agentToAgentAutomaticWakeProven: false });
    expect(interactiveClaudeCapabilities('2.1.283', CLAUDE_INTERACTIVE_ROUTE, limits).support).toBe('tested');
    expect(interactiveClaudeCapabilities('2.1.283', CLAUDE_INTERACTIVE_ROUTE, limits).modes.sync.status).toBe('experimental');
    expect(interactiveClaudeCapabilities('2.1.284', CLAUDE_INTERACTIVE_ROUTE, limits).support).toBe('experimental');
  });

  it('never promotes a mode from receipt evidence alone or extends one mode proof to another', () => {
    const receiptsOnly = interactiveClaudeCapabilities('2.1.283', CLAUDE_INTERACTIVE_ROUTE, limits, proven, []);
    expect(statuses(receiptsOnly)).toEqual(['experimental', 'experimental', 'experimental']);
    const syncOnly = interactiveClaudeCapabilities('2.1.283', CLAUDE_INTERACTIVE_ROUTE, limits, proven,
      [{ version: '2.1.283', route: CLAUDE_INTERACTIVE_ROUTE, mode: 'sync' }]);
    expect(statuses(syncOnly)).toEqual(['experimental', 'proven', 'experimental']);
    const noReceipt = interactiveClaudeCapabilities('2.1.283', CLAUDE_INTERACTIVE_ROUTE, limits, [], CLAUDE_INTERACTIVE_MODE_PROVEN);
    expect(statuses(noReceipt)).toEqual(['experimental', 'experimental', 'experimental']);
  });

  it('keeps an uninspected or uncarriable installed version unproven', () => {
    expect(installedClaudeCapabilities('2.1.283', limits)).toMatchObject({ support: 'tested', acknowledgement: 'batch_token_next_call' });
    for (const version of [null, 'not a version']) {
      const capabilities = installedClaudeCapabilities(version, limits);
      expect(capabilities).toMatchObject({ support: 'unsupported', acknowledgement: 'unknown', version: 'unknown' });
      expect(statuses(capabilities)).toEqual(['unknown', 'unknown', 'unknown']);
    }
  });
});
