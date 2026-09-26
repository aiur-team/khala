import { describe, expect, it } from 'vitest';
import { decodeDeliveryLimits, decodeHarnessCapabilities, resolveOpenCodeModes } from '@khala/contracts/delivery/index';
import { installedOpenCodeCapabilities } from './interactive';

const decoded = decodeDeliveryLimits({ maxPayloadBytes: 65_536, maxSelectionEvents: 32 });
if (!decoded.ok) throw new Error('limits');
const limits = decoded.value;

describe('installed OpenCode capabilities', () => {
  it('proves every recorded route for the exact tested version', () => {
    const claim = installedOpenCodeCapabilities('1.17.10', limits);
    expect(claim).toMatchObject({ support: 'tested', acknowledgement: 'batch_token_next_call' });
    expect(Object.values(resolveOpenCodeModes(claim)).map(row => row.status)).toEqual(['proven', 'proven', 'proven']);
  });

  it('labels any other inspected version experimental, never proven', () => {
    const claim = installedOpenCodeCapabilities('1.18.2', limits);
    expect(decodeHarnessCapabilities(claim).ok).toBe(true);
    expect(claim).toMatchObject({ support: 'experimental', version: '1.18.2', acknowledgement: 'batch_token_next_call' });
    for (const row of Object.values(claim.modes)) {
      expect(row).toMatchObject({ status: 'experimental', testedVersion: '1.18.2' });
      expect(row.reason).toContain('experimental');
    }
    expect(claim.modes.sync.reason).toContain('Idle agents receive messages only at their next turn.');
  });

  it('claims nothing for a version that was not inspected or is not a release version', () => {
    for (const version of [null, 'unknown', '1.17.10-dev', '']) {
      const claim = installedOpenCodeCapabilities(version, limits);
      expect(claim.support).toBe('unsupported');
      expect(Object.values(claim.modes).map(row => row.status)).toEqual(['unknown', 'unknown', 'unknown']);
    }
  });
});
