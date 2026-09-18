// The neutral harness suite graded against the real Codex adapter (KHA-118) over its
// fake app-server, so downstream acceptance does not grade only the reference fake.

import { RECEIPT_KINDS } from '@khala/contracts/delivery/index';
import { describe, expect, it } from 'vitest';
import { codexCapabilities, codexEnvironment, codexHarnessSubject } from './codex-subject';
import { outcomeOf, runHarnessConformance } from './suites';

describe('harness conformance: Codex adapter over the fake app-server', () => {
  it('passes every check it claims, enacts every fault natively, and skips only unclaimed receipts', async () => {
    const report = await runHarnessConformance(codexHarnessSubject(), codexCapabilities(), codexEnvironment(['b', 'c', 'a']));
    expect(report.results.filter(result => result.outcome.status === 'fail')).toEqual([]);
    const unclaimed = RECEIPT_KINDS.filter(kind => !codexCapabilities().receiptEvidence.includes(kind));
    expect(report.results.filter(result => result.outcome.status === 'skip')).toEqual(unclaimed.map(kind => ({
      check: `receipt.${kind}`, outcome: { status: 'skip', reason: `capabilities do not claim ${kind} receipts` },
    })));
    for (const check of ['fault.disconnect_after_write', 'fault.session_exit', 'fault.session_busy', 'receipt.consumption_is_observed']) {
      expect(outcomeOf(report, check)).toEqual({ status: 'pass' });
    }
  });

  it('reads consumption from the receipt stream: Codex never reports it from submit', async () => {
    const real = codexHarnessSubject();
    const streamless: typeof real = async (scenario, owner) => ({ ...(await real(scenario, owner)), receipts: async () => [] });
    const report = await runHarnessConformance(streamless, codexCapabilities(), codexEnvironment(['b', 'c']));
    expect(outcomeOf(report, 'receipt.consumption_is_observed')).toEqual({
      status: 'fail', reason: 'capabilities claim context_consumed but no submission produced one',
    });
  });
});
