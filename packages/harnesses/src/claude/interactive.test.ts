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

  it.each(['2.1.286', '2.1.287'])('fails closed for current version %s without native receipt proof', version => {
    const capabilities = interactiveClaudeCapabilities(version, CLAUDE_INTERACTIVE_ROUTE, limits);
    expect(decodeHarnessCapabilities(capabilities)).toEqual({ ok: true, value: capabilities });
    expect(capabilities).toMatchObject({ support: 'unsupported', acknowledgement: 'unknown', existingSession: 'unknown' });
    expect(statuses(capabilities)).toEqual(['unknown', 'unknown', 'unknown']);
    expect(capabilities.modes.steer.reason).toContain('session-bound delivery receipt');
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

  it('requires live provider-process version evidence instead of a PATH version or local session label', () => {
    const scope = { sessionId: 'live-session', bindingId: 'live-binding', generation: 2 };
    const processEvidence = (version: string) => ({
      source: 'provider_process' as const, version, ...scope, processId: 8133,
    });
    for (const version of [null, 'not a version']) {
      const capabilities = installedClaudeCapabilities(version, limits);
      expect(capabilities).toMatchObject({ support: 'unsupported', acknowledgement: 'unknown', version: 'unknown' });
      expect(statuses(capabilities)).toEqual(['unknown', 'unknown', 'unknown']);
    }
    expect(installedClaudeCapabilities('2.1.283', limits)).toMatchObject({ support: 'experimental' });
    for (const version of ['2.1.286', '2.1.287']) {
      expect(installedClaudeCapabilities(version, limits)).toMatchObject({ support: 'unsupported', version: 'unknown' });
    }
    expect(installedClaudeCapabilities('2.1.287', limits, processEvidence('2.1.286'), scope))
      .toMatchObject({ version: '2.1.286', support: 'unsupported' });
    expect(installedClaudeCapabilities('2.1.286', limits, processEvidence('2.1.287'), scope))
      .toMatchObject({ version: '2.1.287', support: 'unsupported' });
    expect(installedClaudeCapabilities('2.1.287', limits, processEvidence('2.1.283'), scope))
      .toMatchObject({ version: '2.1.283', support: 'tested' });
    const firstScope = { ...scope, generation: 0 };
    expect(installedClaudeCapabilities('2.1.287', limits, {
      ...processEvidence('2.1.283'), generation: 0,
    }, firstScope)).toMatchObject({ version: '2.1.283', support: 'tested' });
    expect(installedClaudeCapabilities('2.1.287', limits, {
      ...processEvidence('2.1.283'), generation: 1,
    }, firstScope)).toMatchObject({ version: 'unknown', support: 'unsupported' });
    for (const wrongScope of [
      { ...scope, sessionId: 'other-session' },
      { ...scope, bindingId: 'other-binding' },
      { ...scope, generation: 3 },
    ]) {
      expect(installedClaudeCapabilities('2.1.287', limits, processEvidence('2.1.283'), wrongScope))
        .toMatchObject({ version: 'unknown', support: 'unsupported' });
    }
    expect(installedClaudeCapabilities('2.1.287', limits, processEvidence('2.1.283')))
      .toMatchObject({ version: 'unknown', support: 'unsupported' });
  });
});
