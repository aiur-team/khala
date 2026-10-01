import { describe, expect, it } from 'vitest';
import { hostedClaudeNativeModeEvidence } from './hosted-native';

describe('hosted Claude native hook evidence', () => {
  it('keeps the inspected saved-session route explicitly unsupported without a hosted receipt', () => {
    const evidence = hostedClaudeNativeModeEvidence('2.1.286');
    expect(evidence).toMatchObject({
      receipt: null, gap: 'no_authenticated_hosted_hook_receipt',
      modes: { steer: { status: 'unsupported' }, sync: { status: 'unsupported' } },
    });
    expect(evidence.modes.steer.reason).toContain('binding/generation receipt');
    expect(evidence.modes.sync.reason).toContain('binding/generation receipt');
  });

  it.each([null, '2.1.283', '2.1.287'])('does not promote another version from hook or interactive-route evidence: %s', version => {
    const evidence = hostedClaudeNativeModeEvidence(version);
    expect(evidence.receipt).toBeNull();
    expect(evidence.modes.steer.status).toBe('unknown');
    expect(evidence.modes.sync.status).toBe('unknown');
  });

  // An executable acceptance probe: it is expected to fail until an actual
  // owner-released hosted batch yields an authenticated model-visible receipt.
  it.fails('acceptance: hosted Steer and Sync have exact-session native receipts', () => {
    const evidence = hostedClaudeNativeModeEvidence('2.1.286');
    expect(evidence.receipt).not.toBeNull();
    expect(evidence.modes.steer.status).toBe('proven');
    expect(evidence.modes.sync.status).toBe('proven');
  });
});
