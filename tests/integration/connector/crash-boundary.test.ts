import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { HarnessPort } from '../../../packages/contracts/src/delivery/index';
import { stopAfterNativeAcceptance, type NativeAcceptance } from './crash-boundary';

describe('native acceptance barrier mechanics (not live acceptance)', () => {
  const job = { releaseId: 'release-test', binding: {
    bindingId: 'binding-test', generation: 0, sessionId: 'session-test',
  } } as never;
  const payload = new Uint8Array([1, 2, 3]);

  it('emits metadata only after the native adapter returns a matching queue receipt', async () => {
    const accepted: NativeAcceptance[] = [];
    const native = {
      async submit() {
        return {
          releaseId: 'release-test', bindingId: 'binding-test', generation: 0,
          kind: 'harness_queued', source: 'harness',
        };
      },
    } as unknown as HarnessPort;
    const wrapped = stopAfterNativeAcceptance(native, observation => accepted.push(observation));
    const pending = wrapped.submit({ job, payload });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(accepted, [{
      kind: 'native_accepted', releaseId: 'release-test', bindingId: 'binding-test',
      generation: 0, sessionId: 'session-test', receiptKind: 'harness_queued',
    }]);
    let settled = false;
    void pending.then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'dispatcher cannot persist the receipt before parent kill');
  });

  it('does not signal native acceptance for an ambiguous connector receipt', async () => {
    const accepted: NativeAcceptance[] = [];
    const native = { async submit() {
      return { releaseId: 'release-test', bindingId: 'binding-test', generation: 0,
        kind: 'outcome_unknown', source: 'connector' };
    } } as unknown as HarnessPort;
    const wrapped = stopAfterNativeAcceptance(native, observation => accepted.push(observation));
    await assert.rejects(wrapped.submit({ job, payload }), /native_acceptance_not_observed/u);
    assert.deepEqual(accepted, []);
  });

  it('does not signal native acceptance for a queued receipt from the connector', async () => {
    const accepted: NativeAcceptance[] = [];
    const native = { async submit() {
      return { releaseId: 'release-test', bindingId: 'binding-test', generation: 0,
        kind: 'harness_queued', source: 'connector' };
    } } as unknown as HarnessPort;
    const wrapped = stopAfterNativeAcceptance(native, observation => accepted.push(observation));
    await assert.rejects(Promise.race([
      wrapped.submit({ job, payload }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('source_guard_bypassed')), 100)),
    ]), /native_acceptance_not_observed/u);
    assert.deepEqual(accepted, []);
  });
});
