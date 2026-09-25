// The neutral harness suite graded against the real Codex adapter (KHA-118) over its
// fake app-server, so downstream acceptance does not grade only the reference fake.

import { RECEIPT_KINDS } from '@khala/contracts/delivery/index';
import { describe, expect, it } from 'vitest';
import {
  codexNativeCapabilities, codexNativeEnvironment, codexNativeHarnessSubject,
} from './codex-native-subject';
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

describe('harness conformance: Codex native CLI notification plus local inbox', () => {
  it('passes every route-A check it claims and skips unsupported reconciliation/receipt facts', async () => {
    const capabilities = codexNativeCapabilities();
    const report = await runHarnessConformance(
      codexNativeHarnessSubject(), capabilities, codexNativeEnvironment(['b', 'c', 'a']),
    );
    expect(report.results.filter(result => result.outcome.status === 'fail')).toEqual([]);
    const unclaimed = RECEIPT_KINDS.filter(kind => !capabilities.receiptEvidence.includes(kind));
    for (const kind of unclaimed) {
      expect(outcomeOf(report, `receipt.${kind}`)).toEqual({
        status: 'skip', reason: `capabilities do not claim ${kind} receipts`,
      });
    }
    for (const check of ['fault.disconnect_after_write', 'fault.session_busy', 'payload.exact_digest']) {
      expect(outcomeOf(report, check)).toEqual({ status: 'pass' });
    }
    expect(outcomeOf(report, 'fault.session_exit')).toEqual({
      status: 'skip', reason: 'subject cannot inject session_exit',
    });
  });
});
