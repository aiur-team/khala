import type { HarnessAdapter } from './adapter';
import { geminiCodec } from './codecs/gemini';
import { hookMapSource } from './session-sources';
import { createTerminalWakeDriver } from '../wake/terminal/driver';

// U38's Gemini CLI 0.62.0 capture: the input starts at column 3.
const emptyPrompt = { pattern: /^ >(?: {3}Type your message or @path\/to\/file)?$/u, cursorColumn: 3 };
const install: NonNullable<HarnessAdapter['install']> = async (flags, deps) =>
  (await import('../install/main')).runGeminiInstall(flags, deps);

export const gemini: HarnessAdapter = {
  id: 'gemini',
  sessionSources: [{ kind: 'env', resolve: (_meta, env) => env.GEMINI_SESSION_ID, rejoinable: () => true }, hookMapSource],
  codec: geminiCodec,
  restoreAtStartup: false,
  install,
  uninstall: (flags, deps) => install([...flags, '--uninstall'], deps),
  emptyPrompt,
  wakeLadder: [createTerminalWakeDriver(emptyPrompt)],
  wakeWarningName: 'gemini',
};
