import { LISTENING_MODES, RECEIPT_KINDS } from '@khala/contracts/delivery/index';
import { describe, expect, it } from 'vitest';
import { cursorCapabilities, cursorEnvironment, cursorHarnessSubject } from './cursor-subject';
import { outcomeOf, runHarnessConformance } from './suites';

describe('harness conformance: fail-closed Cursor app adapter', () => {
  it('passes safety checks with every mode unknown and delivery skipped', async () => {
    const capabilities = cursorCapabilities();
    expect(capabilities.support).toBe('unsupported');
    expect(capabilities.acknowledgement).toBe('unknown');
    for (const mode of LISTENING_MODES) expect(capabilities.modes[mode].status).toBe('unknown');

    const report = await runHarnessConformance(cursorHarnessSubject(), capabilities, cursorEnvironment(['b', 'c', 'a']));
    expect(report.results.filter(result => result.outcome.status === 'fail')).toEqual([]);
    expect(outcomeOf(report, 'capabilities.declared')).toEqual({ status: 'pass' });
    expect(outcomeOf(report, 'support.fail_closed')).toEqual({ status: 'pass' });
    expect(outcomeOf(report, 'notify.no_pending_hint')).toEqual({ status: 'pass' });
    expect(outcomeOf(report, 'receipt.consumption_is_observed')).toEqual({
      status: 'skip', reason: 'native delivery support is unsupported',
    });
    for (const kind of RECEIPT_KINDS.filter(kind => kind !== 'failed')) {
      expect(outcomeOf(report, `receipt.${kind}`)).toEqual({ status: 'skip', reason: `capabilities do not claim ${kind} receipts` });
    }
  });

  it('rejects an adapter that pushes a release into the chat', async () => {
    const report = await runHarnessConformance(
      cursorHarnessSubject('push_into_chat'), cursorCapabilities(), cursorEnvironment(['b', 'c', 'a']),
    );
    expect(outcomeOf(report, 'support.fail_closed')).toMatchObject({ status: 'fail' });
  });
});
