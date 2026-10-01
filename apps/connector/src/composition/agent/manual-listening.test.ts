import { describe, expect, it } from 'vitest';
import { decodeHarnessCapabilities } from '@khala/contracts/delivery/index';
import { manualListeningCapabilities } from './manual-listening';

describe('hosted manual listening capability', () => {
  it.each(['claude', 'codex'] as const)('keeps %s modes unavailable until route and receipt proof exists', harness => {
    const capability = manualListeningCapabilities(harness);
    expect(decodeHarnessCapabilities(capability)).toEqual({ ok: true, value: capability });
    expect(capability.acknowledgement).toBe('unknown');
    expect(capability.modes.steer).toMatchObject({ status: 'unsupported', reason: expect.stringContaining('delivery hook') });
    expect(capability.modes.sync).toMatchObject({ status: 'unsupported', reason: expect.stringContaining('delivery hook') });
    expect(capability.modes.async).toMatchObject({ status: 'unsupported', reason: expect.stringContaining('receipt proof') });
  });
});
