import { claudeStyleCodec } from './codecs/claude-style';
import type { HarnessAdapter } from './adapter';

export const claude: HarnessAdapter = {
  id: 'claude',
  sessionSources: [{ kind: 'env', resolve: (_meta, env) => env.CLAUDE_CODE_SESSION_ID, rejoinable: () => true }],
  codec: claudeStyleCodec,
  restoreAtStartup: true,
  watcherStatus: true,
};
