import { claudeCodec } from './codecs/claude-style';
import type { HarnessAdapter } from './adapter';
import { claudeAgentId } from '../folder-agent';
import { createClaudeWatcherDriver, createTerminalWakeDriver } from '../wake/terminal/driver';

const emptyPrompt = { pattern: /^❯[\u00a0 ]?(Try ".*")?$/u, cursorColumn: 2 };

export const claude: HarnessAdapter = {
  id: 'claude',
  // The agent is the folder, not the conversation: every session started there resolves to one id.
  sessionSources: [{ kind: 'env', resolve: async (_meta, env) => env.CLAUDE_CODE_SESSION_ID === undefined ? undefined
    : await claudeAgentId(env, env.CLAUDE_CODE_SESSION_ID), rejoinable: () => true }],
  codec: claudeCodec,
  restoreAtStartup: true,
  watcherStatus: true,
  emptyPrompt,
  wakeLadder: [createClaudeWatcherDriver(), createTerminalWakeDriver(emptyPrompt)],
};
