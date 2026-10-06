import type { HarnessAdapter } from './adapter';
import { copilotCodec } from './codecs/copilot';
import { hookMapSource } from './session-sources';
import { createTerminalWakeDriver } from '../wake/terminal/driver';

const emptyPrompt = { pattern: /^❯ ?$/u, cursorColumn: 2 };
const install: NonNullable<HarnessAdapter['install']> = async (flags, deps) =>
  (await import('../install/main')).runCopilotInstall(flags, deps);
export const copilot: HarnessAdapter = {
  id: 'copilot', sessionSources: [hookMapSource], codec: copilotCodec, restoreAtStartup: true,
  install, uninstall: (flags, deps) => install([...flags, '--uninstall'], deps),
  emptyPrompt, wakeLadder: [createTerminalWakeDriver(emptyPrompt)], wakeWarningName: 'copilot',
};
