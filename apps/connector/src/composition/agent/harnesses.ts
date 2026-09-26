import {
  decodeHarnessCapabilities,
  type HarnessCapabilities,
  type HarnessPort,
  type SessionBinding,
} from '@khala/contracts/delivery/index';
import type { HarnessSelectionStore } from '@khala/connector/storage/harness-selection';
import type { RuntimeHarnessInspection, RuntimeHarnessPort } from '../../runtime/create';
import { isDeliverableRoute } from '../../runtime/harness';

export {
  createHarnessSelectionStore,
  type HarnessSelectionStore,
} from '@khala/connector/storage/harness-selection';

export type HarnessCandidate = Readonly<{
  routeId: string;
  harness: HarnessPort;
  /** The generic installed-listener route, considered only after native candidates. */
  fallback?: boolean;
  /**
   * One content-free wake after this route is selected at startup or reconnect, so
   * a listener that stayed idle re-reads its durable batch. It carries no release
   * and never retries or replaces delivery.
   */
  catchUp?: (binding: SessionBinding) => Promise<void>;
}>;

export interface RuntimeHarnessSelection extends RuntimeHarnessPort {
  selected(): HarnessPort | null;
}

export type RuntimeHarnessSelectionOptions = Readonly<{
  /** Explicit operator opt-in for the unproven installed-listener fallback. */
  allowExperimentalAgentListener?: boolean;
}>;

function usable(capabilities: HarnessCapabilities, binding: SessionBinding, fallback: boolean): boolean {
  if (capabilities.harness !== binding.harness || !isDeliverableRoute(capabilities)) return false;
  if (fallback) {
    return capabilities.support === 'experimental'
      && capabilities.existingSession === 'agent_installed_listener';
  }
  return capabilities.support === 'tested';
}

/**
 * Chooses one exact evidence-backed route and fences that choice to the binding
 * generation. A route change is not applied in place: bootstrap must supply a new
 * generation before dispatch can resume.
 */
export function createRuntimeHarnessSelection(
  binding: SessionBinding,
  candidates: readonly HarnessCandidate[],
  selections: HarnessSelectionStore,
  options: RuntimeHarnessSelectionOptions = {},
): RuntimeHarnessSelection {
  let selected: HarnessPort | null = null;
  let closed = false;

  async function inspectCandidate(candidate: HarnessCandidate): Promise<RuntimeHarnessInspection | null> {
    let decoded: ReturnType<typeof decodeHarnessCapabilities>;
    try {
      decoded = decodeHarnessCapabilities(await candidate.harness.inspect(binding));
    } catch {
      return null;
    }
    if (!decoded.ok || !usable(decoded.value, binding, candidate.fallback === true)) return null;
    let recorded: Awaited<ReturnType<HarnessSelectionStore['record']>>;
    try {
      recorded = await selections.record({
        bindingId: binding.bindingId,
        generation: binding.generation,
        routeId: candidate.routeId,
      });
    } catch {
      selected = null;
      return {
        state: 'unknown',
        capabilities: decoded.value,
        routeId: candidate.routeId,
        reason: 'selection_unavailable',
      };
    }
    if (recorded === 'route_changed' || recorded === 'stale_generation') {
      selected = null;
      return {
        state: 'unknown',
        capabilities: decoded.value,
        routeId: candidate.routeId,
        reason: recorded,
      };
    }
    selected = candidate.harness;
    await candidate.catchUp?.(binding).catch(() => undefined);
    return {
      state: 'ready',
      capabilities: decoded.value,
      routeId: candidate.routeId,
    };
  }

  return {
    async inspect() {
      if (closed) return { state: 'unknown', capabilities: null, routeId: null, reason: 'closed' };
      selected = null;
      const allowed = options.allowExperimentalAgentListener === true
        ? candidates
        : candidates.filter(candidate => candidate.fallback !== true);
      const ordered = [
        ...allowed.filter(candidate => candidate.fallback !== true),
        ...allowed.filter(candidate => candidate.fallback === true),
      ];
      for (const candidate of ordered) {
        const result = await inspectCandidate(candidate);
        if (result) return result;
      }
      return { state: 'unsupported', capabilities: null, routeId: null };
    },
    selected: () => selected,
    async close() {
      if (closed) return;
      closed = true;
      selected = null;
      const unique = new Set(candidates.map(candidate => candidate.harness));
      const results = await Promise.allSettled([...unique].map(candidate => candidate.close()));
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'harness selection close failed');
    },
  };
}
