import { RECEIPT_KINDS } from '@khala/contracts/delivery/index';
import { describe, expect, it } from 'vitest';
import { claudeCapabilities, claudeEnvironment, claudeHarnessSubject } from './claude-subject';
import { outcomeOf, runHarnessConformance } from './suites';

describe('harness conformance: unsupported Claude native adapter', () => {
  it('passes safety checks and skips delivery behavior the evidence rejected', async () => {
    const capabilities = claudeCapabilities();
    const report = await runHarnessConformance(
      claudeHarnessSubject(), capabilities, claudeEnvironment(['b', 'c', 'a']),
    );
    expect(report.results.filter(result => result.outcome.status === 'fail')).toEqual([]);
    expect(outcomeOf(report, 'capabilities.declared')).toEqual({ status: 'pass' });
    expect(outcomeOf(report, 'support.fail_closed')).toEqual({ status: 'pass' });
    expect(outcomeOf(report, 'session.identity_preserved')).toEqual({
      status: 'skip', reason: 'native delivery support is unsupported',
    });
    expect(outcomeOf(report, 'payload.exact_digest')).toEqual({
      status: 'skip', reason: 'native delivery support is unsupported',
    });
    expect(outcomeOf(report, 'receipt.consumption_is_observed')).toEqual({
      status: 'skip', reason: 'native delivery support is unsupported',
    });
    const unclaimed = RECEIPT_KINDS.filter(kind => !capabilities.receiptEvidence.includes(kind));
    for (const kind of unclaimed) {
      expect(outcomeOf(report, `receipt.${kind}`)).toEqual({
        status: 'skip', reason: `capabilities do not claim ${kind} receipts`,
      });
    }
  });
});
