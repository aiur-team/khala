// OpenCode harness adapter. Khala never launches, signals or aborts OpenCode: the
// user-started plugin reads the durable inbox itself, and this adapter can only
// store a release and send the plugin a content-free wake.

import {
  type BindingId, type Clock, type DeliveryLimits, type DeliveryReceipt, type HarnessPort, type ReleaseId,
  type SessionBinding, sameSessionBinding,
} from '@khala/contracts/delivery/index';
import { OPENCODE_HARNESS, openCodeCapabilities } from './capabilities';
import { openCodeReceipt } from './receipts';
import { type OpenCodeInboxPort, submitRelease } from './transport';

export {
  OPENCODE_ADAPTER_VERSION, OPENCODE_HARNESS, OPENCODE_RECEIPT_EVIDENCE, openCodeCapabilities,
} from './capabilities';
export type { OpenCodeInboxDelivery, OpenCodeInboxPort } from './transport';

export type OpenCodePluginInspection = Readonly<{
  version: string | null;
  bindingId: string | null;
  generation: number | null;
}>;

/** Reports what the user-started plugin says it is bound to. It never starts OpenCode. */
export interface OpenCodePluginProbe {
  inspect(sessionId: string): Promise<OpenCodePluginInspection>;
}

export type OpenCodeHarnessDeps = Readonly<{
  probe: OpenCodePluginProbe;
  /** Opens the inbox of exactly this binding generation; composition owns the path. */
  inbox(binding: SessionBinding): Promise<OpenCodeInboxPort>;
  clock: Clock;
  /** From configuration or the capability record; the adapter has no default. */
  limits: DeliveryLimits;
}>;

export interface OpenCodeHarness extends HarnessPort {
  /**
   * Sends one content-free wake to the exactly inspected binding generation, so a
   * plugin that stayed idle across a connector restart re-reads its durable batch.
   */
  catchUp(binding: SessionBinding): Promise<void>;
}

type OpenedInbox = Readonly<{ binding: SessionBinding; port: Promise<OpenCodeInboxPort> }>;

export function createOpenCodeHarness(deps: OpenCodeHarnessDeps): OpenCodeHarness {
  const { probe, clock, limits } = deps;
  // The binding each ID was last inspected at. Losing this map on restart only
  // forces a fresh inspection; it never permits a send.
  const inspected = new Map<BindingId, SessionBinding>();
  const inboxes = new Map<BindingId, OpenedInbox>();
  const submitting = new Map<ReleaseId, Promise<DeliveryReceipt>>();
  const inFlight = new Set<Promise<unknown>>();
  let closed = false;

  const track = <T>(work: Promise<T>): Promise<T> => {
    inFlight.add(work);
    return work.finally(() => inFlight.delete(work));
  };

  // One inbox per binding generation: a new generation never reuses the old one.
  const inboxFor = (binding: SessionBinding): Promise<OpenCodeInboxPort> => {
    const current = inboxes.get(binding.bindingId);
    if (current && sameSessionBinding(current.binding, binding)) return current.port;
    const port = deps.inbox(binding);
    port.catch(() => {
      if (inboxes.get(binding.bindingId)?.port === port) inboxes.delete(binding.bindingId);
    });
    inboxes.set(binding.bindingId, { binding, port });
    return port;
  };

  const exactlyInspected = (binding: SessionBinding): boolean => {
    const current = inspected.get(binding.bindingId);
    return current !== undefined && sameSessionBinding(current, binding);
  };

  async function catchUp(binding: SessionBinding): Promise<void> {
    if (closed || !exactlyInspected(binding)) return;
    await track(inboxFor(binding).then(port => port.notifyListener())).catch(() => undefined);
  }

  return {
    async inspect(binding) {
      if (closed) throw new Error('opencode adapter is closed');
      if (binding.harness !== OPENCODE_HARNESS) throw new Error('opencode adapter: binding names another harness');
      inspected.delete(binding.bindingId);
      const plugin = await track(probe.inspect(binding.sessionId));
      if (!closed && plugin.bindingId === binding.bindingId && plugin.generation === binding.generation) {
        inspected.set(binding.bindingId, binding);
      }
      return openCodeCapabilities(typeof plugin.version === 'string' ? plugin.version : null, limits);
    },

    // The hint's release ID is deliberately unused: the wake carries nothing, and
    // the plugin finds the release by re-reading its durable batch.
    async notify(binding) {
      await catchUp(binding);
    },

    catchUp,

    async submit({ job, payload }) {
      // A submission in flight is joined even if close() lands concurrently: its real
      // outcome, not a synthesized failure, is what every caller of the release sees.
      const pending = submitting.get(job.releaseId);
      if (pending) return pending;
      if (closed) return openCodeReceipt(job, 'failed', clock, 'harness_unavailable');
      const binding = inspected.get(job.binding.bindingId);
      const work = track(submitRelease({ clock, limits }, binding, () => inboxFor(job.binding), job, payload))
        .finally(() => submitting.delete(job.releaseId));
      submitting.set(job.releaseId, work);
      return work;
    },

    // Reconciliation by release ID is unsupported. `null` means "no evidence" and
    // never licenses a second submission.
    async reconcile() {
      return null;
    },

    async close() {
      closed = true;
      inspected.clear();
      await Promise.allSettled([...inFlight]);
      inboxes.clear();
    },
  };
}
