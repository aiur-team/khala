import { describe, expect, it } from 'vitest';
import { decodeHarnessCapabilities } from '@khala/contracts/delivery/index';
import { initialListeningModeControl, listeningModeView } from '../../../policy/src/listening-mode/store';
import { limits } from './fakes';
import { type CodexReceiptProof } from './receipt-conformance';
import {
  CODEX_INTERACTIVE_EVIDENCE_REVISION, CODEX_INTERACTIVE_0157_EVIDENCE_REVISION,
  CODEX_INTERACTIVE_VERSIONS, interactiveCodexCapabilities,
} from './interactive';

describe('interactive Codex capabilities', () => {
  it.each(CODEX_INTERACTIVE_VERSIONS)('claims every mode for trusted hooks on proven %s', version => {
    const proof: CodexReceiptProof = { proven: true, route: 'hook', version };
    const capabilities = interactiveCodexCapabilities(version, limits, { state: 'trusted' }, proof);
    expect(decodeHarnessCapabilities(capabilities)).toEqual({ ok: true, value: capabilities });
    expect(capabilities).toMatchObject({
      support: 'tested',
      existingSession: 'native_hooks',
      acknowledgement: 'batch_token_next_call',
      immediateNotification: 'unknown',
    });
    for (const mode of ['steer', 'sync', 'async'] as const) {
      expect(capabilities.modes[mode]).toMatchObject({
        status: 'proven', testedVersion: version,
        evidenceRevision: version === '0.157.1' ? CODEX_INTERACTIVE_0157_EVIDENCE_REVISION
          : CODEX_INTERACTIVE_EVIDENCE_REVISION,
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

  it('delivers steer and sync but claims no acknowledgement or async without a conformance proof', () => {
    const capabilities = interactiveCodexCapabilities('0.156.1', limits, { state: 'trusted' });
    expect(decodeHarnessCapabilities(capabilities).ok).toBe(true);
    expect(capabilities.support).toBe('tested');
    expect(capabilities.modes.steer.status).toBe('proven');
    expect(capabilities.modes.sync.status).toBe('proven');
    expect(capabilities.modes.async.status).toBe('unknown');
    expect(capabilities.acknowledgement).toBe('unknown');
  });

  it('never leaves async effective while acknowledgement is unknown', () => {
    const control = {
      ...initialListeningModeControl({ bindingId: 'b' as never, generation: 1 }, null), requested: 'async' as const,
    };
    const unproven = interactiveCodexCapabilities('0.156.1', limits, { state: 'trusted' });
    expect(listeningModeView(control, unproven).effective).toBeNull();
    const proven = interactiveCodexCapabilities('0.156.1', limits, { state: 'trusted' },
      { proven: true, route: 'hook', version: '0.156.1' });
    expect(listeningModeView(control, proven).effective).toBe('async');
  });

  it.each<[string, CodexReceiptProof]>([
    ['another route', { proven: true, route: 'native_inbox', version: '0.156.1' }],
    ['another version', { proven: true, route: 'hook', version: '0.154.0' }],
    ['a failed proof', { proven: false, gaps: ['token_not_returned'] }],
  ])('does not advertise acknowledgement from %s', (_name, proof) => {
    expect(interactiveCodexCapabilities('0.156.1', limits, { state: 'trusted' }, proof).acknowledgement)
      .toBe('unknown');
  });

  it('never advertises acknowledgement for an untrusted or unproven-version route, even with a proof', () => {
    expect(interactiveCodexCapabilities('0.156.1', limits, { state: 'unknown', reason: 'x' },
      { proven: true, route: 'hook', version: '0.156.1' }).acknowledgement).toBe('unknown');
    expect(interactiveCodexCapabilities('0.155.0', limits, { state: 'trusted' },
      { proven: true, route: 'hook', version: '0.155.0' }).acknowledgement).toBe('unknown');
  });

  it('does not carry the old-version receipt proof into the new native session', () => {
    const capabilities = interactiveCodexCapabilities('0.157.1', limits, { state: 'trusted' },
      { proven: true, route: 'hook', version: '0.156.1' });
    expect(capabilities.acknowledgement).toBe('unknown');
    expect(capabilities.modes.steer.status).toBe('unknown');
    expect(capabilities.modes.async.status).toBe('unknown');
    expect(capabilities.modes.sync).toMatchObject({
      status: 'proven', evidenceRevision: CODEX_INTERACTIVE_0157_EVIDENCE_REVISION,
    });
  });

  it('limits 0.157.1 to trusted sync with the observed queue wake and exact receipt proof', () => {
    const capabilities = interactiveCodexCapabilities('0.157.1', limits, { state: 'trusted' },
      { proven: true, route: 'hook', version: '0.157.1' }, 'available');
    expect(capabilities).toMatchObject({
      support: 'tested', acknowledgement: 'batch_token_next_call', immediateNotification: 'native_cli_queue',
      evidenceRef: 'docs/evidence/codex-0157-native-cli.md#sync-hook',
    });
    expect(capabilities.modes.steer.status).toBe('unknown');
    expect(capabilities.modes.sync.status).toBe('proven');
    expect(capabilities.modes.async.status).toBe('unknown');
    expect(capabilities.modes.sync.reason).toContain('content-free queue notice');
    expect(interactiveCodexCapabilities('0.157.1', limits, { state: 'trusted' }, undefined, 'unavailable')
      .immediateNotification).toBe('unknown');
    expect(interactiveCodexCapabilities('0.157.1', limits, { state: 'unknown', reason: 'hook review absent' },
      undefined, 'available').immediateNotification).toBe('unknown');
  });

  it.each([
    { platform: 'darwin', arch: 'x64' },
    { platform: 'linux', arch: 'arm64' },
    { platform: 'win32', arch: 'x64' },
  ])('keeps 0.157.1 unproven on $platform/$arch', runtime => {
    const capabilities = interactiveCodexCapabilities('0.157.1', limits, { state: 'trusted' },
      { proven: true, route: 'hook', version: '0.157.1' }, 'available', runtime);
    expect(capabilities.support).toBe('unsupported');
    expect(capabilities.immediateNotification).toBe('unknown');
    expect(Object.values(capabilities.modes).map(mode => mode.status)).toEqual(['unknown', 'unknown', 'unknown']);
    expect(capabilities.modes.sync.reason).toContain('Linux x64 only');
    expect(interactiveCodexCapabilities('0.156.1', limits, { state: 'trusted' },
      undefined, 'unavailable', runtime).modes.sync.status).toBe('proven');
  });

  it('claims nothing for an unproven version even with trusted hooks', () => {
    const capabilities = interactiveCodexCapabilities('0.155.0', limits, { state: 'trusted' });
    expect(decodeHarnessCapabilities(capabilities).ok).toBe(true);
    expect(capabilities.support).toBe('unsupported');
    expect(Object.values(capabilities.modes).map(mode => mode.status)).toEqual(['unknown', 'unknown', 'unknown']);
    expect(capabilities.modes.steer.reason).toContain('0.155.0 has no interactive hook proof');
  });

  it('limits 0.159.3 to the normally trusted Linux x64 Sync witness', () => {
    const proven = interactiveCodexCapabilities('0.159.3', limits, { state: 'trusted' },
      { proven: true, route: 'hook', version: '0.159.3' }, 'available',
      { platform: 'linux', arch: 'x64' });
    expect(proven).toMatchObject({ support: 'tested', acknowledgement: 'batch_token_next_call',
      immediateNotification: 'native_cli_queue', evidenceRef: 'docs/evidence/codex-0159-3-native-sync.md' });
    expect(Object.values(proven.modes).map(mode => mode.status)).toEqual(['unknown', 'proven', 'unknown']);
    const untrusted = interactiveCodexCapabilities('0.159.3', limits,
      { state: 'awaiting_hook_review', reason: 'not trusted' }, undefined, 'available');
    expect(untrusted.support).toBe('unsupported');
    expect(interactiveCodexCapabilities('0.159.3', limits, { state: 'trusted' },
      { proven: true, route: 'hook', version: '0.156.1' }).acknowledgement).toBe('unknown');
    expect(interactiveCodexCapabilities('0.159.3', limits, { state: 'trusted' },
      undefined, 'available', { platform: 'linux', arch: 'arm64' }).support).toBe('unsupported');
    expect(interactiveCodexCapabilities('0.159.2', limits, { state: 'trusted' }).support).toBe('unsupported');
  });

  it('claims the native queue notification only while the idle wake works', () => {
    const woken = interactiveCodexCapabilities('0.154.0', limits, { state: 'trusted' }, undefined, 'available');
    expect(decodeHarnessCapabilities(woken)).toEqual({ ok: true, value: woken });
    expect(woken.immediateNotification).toBe('native_cli_queue');
    expect(woken.modes.sync.reason).toContain('content-free queue notice');
    expect(woken.modes.sync.reason).not.toContain('only at their next turn');
    const failed = interactiveCodexCapabilities('0.154.0', limits, { state: 'trusted' }, undefined, 'unavailable');
    expect(failed.immediateNotification).toBe('unknown');
    expect(failed.modes.steer.reason).toContain('Idle agents receive messages only at their next turn.');
  });
});
