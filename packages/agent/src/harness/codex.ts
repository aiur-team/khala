import { claudeStyleCodec } from './codecs/claude-style';
import { codexWakeDriver } from '../wake/codex';
import type { HarnessAdapter } from './adapter';

const install: NonNullable<HarnessAdapter['install']> = async (flags, deps) =>
  (await import('../install/main')).runCodexInstall(flags, deps);

export const codex: HarnessAdapter = {
  id: 'codex',
  // A string metadata id wins even when empty or invalid; validation happens after selection.
  sessionSources: [(meta, env) => typeof meta?.threadId === 'string' ? meta.threadId : env.CODEX_THREAD_ID],
  codec: claudeStyleCodec,
  restoreAtStartup: true,
  install,
  uninstall: (flags, deps) => install([...flags, '--uninstall'], deps),
  wakeLadder: [codexWakeDriver],
  wakeConsentDrivers: [{ id: 'terminal', rung: 4, optIn: true }],
  rejoinable: () => true,
};
