import { describe, expect, it } from 'vitest';
import {
  type CodexReceiptObservation, assessCodexReceiptConformance,
} from './receipt-conformance';

const expected = { version: '0.156.1', route: 'hook' } as const;
const good: CodexReceiptObservation = {
  subject: 'user_cli', route: 'hook', version: '0.156.1', sharedInbox: true, batchDelivered: true,
  authenticatedBinding: true, tokenReturned: true, receiptCorrelated: true, contentionSafe: true,
};

describe('Codex receipt conformance', () => {
  it('proves the exact interactive CLI hook route', () => {
    expect(assessCodexReceiptConformance(good, expected)).toEqual({ proven: true, route: 'hook', version: '0.156.1' });
  });

  it('treats no observation, and so no later call, as neutral', () => {
    expect(assessCodexReceiptConformance(null, expected)).toEqual({ proven: false, gaps: ['no_observation'] });
  });

  it.each<[string, Partial<CodexReceiptObservation>, string]>([
    ['a hosted-only pass', { subject: 'hosted_app_server' }, 'not_user_cli'],
    ['a queue or batch-return-only path with no shared inbox', { sharedInbox: false }, 'no_shared_inbox'],
    ['no batch delivery', { batchDelivered: false }, 'no_batch_delivery'],
    ['an unauthenticated binding', { authenticatedBinding: false }, 'binding_unauthenticated'],
    ['a lost, overwritten or omitted token', { tokenReturned: false }, 'token_not_returned'],
    ['a receipt that was not correlated', { receiptCorrelated: false }, 'receipt_not_correlated'],
    ['contention that loses the token', { contentionSafe: false }, 'contention_unsafe'],
    ['another version', { version: '0.154.0' }, 'version_mismatch'],
    ['another route', { route: 'native_inbox' }, 'route_mismatch'],
  ])('rejects %s', (_name, override, gap) => {
    const proof = assessCodexReceiptConformance({ ...good, ...override }, expected);
    expect(proof.proven).toBe(false);
    expect(proof).toMatchObject({ gaps: [gap] });
  });
});
