import { LEGACY_HARNESSES } from '@khala/contracts/m1/harness';
import { LISTENING_MODE_MEMBER_KEY } from '@khala/contracts/m1/listening-mode';

/** Old clients reject unknown harness ids; never mutate the store's projection. */
export function legacyHarnessView<T extends object>(content: T): T {
  if (!('harness' in content) || content.harness === undefined || (LEGACY_HARNESSES as readonly unknown[]).includes(content.harness)) return content;
  const legacy = { ...content };
  delete (legacy as { harness?: unknown }).harness;
  return legacy;
}

/** The member shape a client asked for: new harness ids need `wire=2`; the `mute` mode needs `mute=1`, and
 * reads as the quiet `async` to older strict decoders (which would otherwise reject the whole page forever). */
export function memberView<T extends object>(content: T, query: URLSearchParams): T {
  let view = query.get('wire') === '2' ? content : legacyHarnessView(content);
  if (query.get('mute') === '1') return view;
  for (const key of ['listeningMode', LISTENING_MODE_MEMBER_KEY]) {
    if ((view as Record<string, unknown>)[key] === 'mute') view = { ...view, [key]: 'async' };
  }
  return view;
}
