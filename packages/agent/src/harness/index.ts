import { HARNESS_REGISTRY, isHarnessId } from '@khala/contracts/m1/harness';
import type { HarnessAdapter } from './adapter';
import { claude } from './claude';
import { codex } from './codex';
import { cursor } from './cursor';
import { gemini } from './gemini';
import { antigravity } from './antigravity';
import { opencode } from './opencode';
import { generic, genericAdapter } from './generic';

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

export const ADAPTERS: readonly HarnessAdapter[] = Object.freeze([claude, codex, cursor, opencode, gemini, antigravity, generic]);
const registry = createAdapterRegistry(ADAPTERS);
export function adapterFor(id: string): HarnessAdapter | undefined {
  return registry.resolve(id) ?? (isHarnessId(id) ? genericAdapter(id) : undefined);
}
