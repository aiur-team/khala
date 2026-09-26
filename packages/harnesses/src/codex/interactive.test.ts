import { describe, expect, it } from 'vitest';
import { decodeHarnessCapabilities } from '@khala/contracts/delivery/index';
import { limits } from './fakes';
import {
  CODEX_INTERACTIVE_EVIDENCE_REVISION, CODEX_INTERACTIVE_VERSIONS, interactiveCodexCapabilities,
} from './interactive';

describe('interactive Codex capabilities', () => {
  it.each(CODEX_INTERACTIVE_VERSIONS)('claims every mode for trusted hooks on proven %s', version => {
    const capabilities = interactiveCodexCapabilities(version, limits, { state: 'trusted' });
    expect(decodeHarnessCapabilities(capabilities)).toEqual({ ok: true, value: capabilities });
    expect(capabilities).toMatchObject({
      support: 'tested',
      existingSession: 'native_hooks',
      acknowledgement: 'batch_token_next_call',
      immediateNotification: 'unknown',
    });
    for (const mode of ['steer', 'sync', 'async'] as const) {
      expect(capabilities.modes[mode]).toMatchObject({
        status: 'proven', testedVersion: version, evidenceRevision: CODEX_INTERACTIVE_EVIDENCE_REVISION,
      });
    }
    expect(capabilities.modes.steer.reason).toContain('next tool boundary');
    expect(capabilities.modes.steer.reason).toContain('Hard abort is disabled');
    expect(capabilities.modes.steer.reason).toContain('Idle agents receive messages only at their next turn.');
    expect(capabilities.modes.sync.reason).toContain('Idle agents receive messages only at their next turn.');
  });

  it('reports awaiting hook review, never ready, until the user trusts the hooks', () => {
    const capabilities = interactiveCodexCapabilities('0.156.1', limits, {
      state: 'awaiting_hook_review', reason: 'Codex has not trusted the Khala hook for Stop.',
    });
    expect(decodeHarnessCapabilities(capabilities).ok).toBe(true);
    expect(capabilities).toMatchObject({ support: 'unsupported', acknowledgement: 'unknown', existingSession: 'unknown' });
    for (const mode of ['steer', 'sync', 'async'] as const) {
      expect(capabilities.modes[mode].status).toBe('unknown');
      expect(capabilities.modes[mode].reason).toMatch(/^Awaiting hook review: Codex has not trusted/);
    }
    expect(interactiveCodexCapabilities('0.156.1', limits, { state: 'unknown', reason: 'Hooks are not installed.' })
      .modes.sync.reason).toMatch(/^Hook trust unknown:/);
  });

  it('claims nothing for an unproven version even with trusted hooks', () => {
    const capabilities = interactiveCodexCapabilities('0.155.0', limits, { state: 'trusted' });
    expect(decodeHarnessCapabilities(capabilities).ok).toBe(true);
    expect(capabilities.support).toBe('unsupported');
    expect(Object.values(capabilities.modes).map(mode => mode.status)).toEqual(['unknown', 'unknown', 'unknown']);
    expect(capabilities.modes.steer.reason).toContain('0.155.0 has no interactive hook proof');
  });
});
