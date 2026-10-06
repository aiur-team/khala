import type { HarnessAdapter } from './adapter';
import { antigravityCodec } from './codecs/antigravity';
import { createAntigravityWakeDriver, antigravityPromptText } from '../wake/antigravity';
import { createTerminalWakeDriver } from '../wake/terminal/driver';

// U28 captured the bare > prompt at column 2. Unmeasured host layouts fail closed.
const emptyPrompt = { pattern: /^>$/u, cursorColumn: 2 };
const install: NonNullable<HarnessAdapter['install']> = async (flags, deps) =>
  (await import('../install/main')).runAntigravityInstall(flags, deps);
export const antigravity: HarnessAdapter = {
  id: 'antigravity', restoreAtStartup: false, codec: antigravityCodec,
  sessionSources: [
    { kind: 'meta', resolve: meta => meta?.['antigravity.google/conversation_id'], rejoinable: () => true },
    { kind: 'env', resolve: (_meta, env) => env.ANTIGRAVITY_CONVERSATION_ID, rejoinable: () => true },
  ],
  install, uninstall: (flags, deps) => install([...flags, '--uninstall'], deps), emptyPrompt,
  wakeLadder: [createAntigravityWakeDriver(), createTerminalWakeDriver(emptyPrompt)],
  wakeWarningName: 'antigravity', hookPromptText: antigravityPromptText,
};
