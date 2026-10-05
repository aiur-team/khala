import type { HarnessAdapter } from './adapter';

export const claude: HarnessAdapter = {
  id: 'claude',
  sessionSources: [(_meta, env) => env.CLAUDE_CODE_SESSION_ID],
  codec: undefined,
  rejoinable: () => true,
  watcherStatus: true,
};
