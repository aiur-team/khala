import { HARNESS_REGISTRY } from '@khala/contracts/m1/harness';
import type { HarnessAdapter } from './adapter';
import { claude } from './claude';
import { codex } from './codex';
import { cursor } from './cursor';

/** Never silently replaces an adapter or registers an id absent from the metadata registry. */
export function createAdapterRegistry(adapters: readonly HarnessAdapter[]) {
  const byId = new Map<string, HarnessAdapter>();
  for (const adapter of adapters) {
    if (byId.has(adapter.id)) throw new Error(`duplicate_adapter: ${adapter.id}`);
    if (!HARNESS_REGISTRY.some(row => row.id === adapter.id)) throw new Error(`unregistered_adapter: ${adapter.id}`);
    byId.set(adapter.id, adapter);
  }
  return Object.freeze({ resolve: (id: string) => byId.get(id) });
}

export const ADAPTERS: readonly HarnessAdapter[] = Object.freeze([claude, codex, cursor]);
const registry = createAdapterRegistry(ADAPTERS);
export const adapterFor = registry.resolve;
