import { claudeStyleCodec } from './codecs/claude-style';
import type { HarnessAdapter } from './adapter';
import { createClaudeWatcherDriver, createTerminalWakeDriver } from '../wake/terminal/driver';

const emptyPrompt = { pattern: /^❯[\u00a0 ]?(Try ".*")?$/u, cursorColumn: 2 };

export const claude: HarnessAdapter = {
  id: 'claude',
  sessionSources: [{ kind: 'env', resolve: (_meta, env) => env.CLAUDE_CODE_SESSION_ID, rejoinable: () => true }],
  codec: claudeStyleCodec,
  restoreAtStartup: true,
  watcherStatus: true,
  emptyPrompt,
  wakeLadder: [createClaudeWatcherDriver(), createTerminalWakeDriver(emptyPrompt)],
};
