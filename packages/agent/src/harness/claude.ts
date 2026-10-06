import { claudeStyleCodec } from './codecs/claude-style';
import type { HarnessAdapter } from './adapter';

export const claude: HarnessAdapter = {
  id: 'claude',
  sessionSources: [(_meta, env) => env.CLAUDE_CODE_SESSION_ID],
  codec: claudeStyleCodec,
  restoreAtStartup: true,
  rejoinable: () => true,
  watcherStatus: true,
};
