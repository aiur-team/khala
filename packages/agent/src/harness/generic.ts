import type { HarnessAdapter } from './adapter';
import { processSource } from './session-sources';

/** MCP-only clients have no hook dialect or wake integration. */
export const generic: HarnessAdapter = {
  id: 'generic',
  sessionSources: [
    { kind: 'env', resolve: (_meta, env) => env.KHALA_SESSION_ID, rejoinable: () => true },
    processSource,
  ],
  codec: undefined,
  restoreAtStartup: true,
};

export function genericAdapter(id: string): HarnessAdapter {
  return { ...generic, id };
}
