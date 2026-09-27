import type { DeliveryReceipt, HarnessPort, ReleasedJob } from '../../../packages/contracts/src/delivery/index';

/** Metadata only: the supervisor never receives released or pending bytes. */
export type NativeAcceptance = Readonly<{
  kind: 'native_accepted';
  releaseId: string;
  bindingId: string;
  generation: number;
  sessionId: string;
  receiptKind: 'harness_queued';
  deviceFingerprint?: string;
  signerThumbprint?: string;
}>;

/**
 * The wrapped port must be the actual native adapter. This barrier executes
 * after its successful acceptance and before the dispatcher can persist the
 * receipt. The parent kills the process while submit remains unresolved.
 */
export function stopAfterNativeAcceptance(
  native: HarnessPort,
  notify: (observation: NativeAcceptance) => void,
): HarnessPort {
  return {
    inspect: binding => native.inspect(binding),
    notify: (binding, hint) => native.notify(binding, hint),
    async submit(input): Promise<DeliveryReceipt> {
      const receipt = await native.submit(input);
      if (receipt.kind !== 'harness_queued' || receipt.source !== 'harness'
        || receipt.releaseId !== input.job.releaseId
        || receipt.bindingId !== input.job.binding.bindingId
        || receipt.generation !== input.job.binding.generation) {
        throw new Error('native_acceptance_not_observed');
      }
      notify({
        kind: 'native_accepted',
        releaseId: input.job.releaseId,
        bindingId: input.job.binding.bindingId,
        generation: input.job.binding.generation,
        sessionId: input.job.binding.sessionId,
        receiptKind: 'harness_queued',
      });
      return new Promise<DeliveryReceipt>(() => undefined);
    },
    reconcile: (job: ReleasedJob) => native.reconcile(job),
    close: () => native.close(),
  };
}
