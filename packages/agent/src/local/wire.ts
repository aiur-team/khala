import { LEGACY_HARNESSES } from '@khala/contracts/m1/harness';

/** Old clients reject unknown harness ids; never mutate the store's projection. */
export function legacyHarnessView<T extends object>(content: T): T {
  if (!('harness' in content) || content.harness === undefined || (LEGACY_HARNESSES as readonly unknown[]).includes(content.harness)) return content;
  const legacy = { ...content };
  delete (legacy as { harness?: unknown }).harness;
  return legacy;
}
