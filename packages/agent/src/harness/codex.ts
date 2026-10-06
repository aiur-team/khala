import { claudeStyleCodec } from './codecs/claude-style';
import { codexWakeDriver } from '../wake/codex';
import type { HarnessAdapter } from './adapter';

const install: NonNullable<HarnessAdapter['install']> = async (flags, deps) =>
  (await import('../install/main')).runCodexInstall(flags, deps);

export const codex: HarnessAdapter = {
  id: 'codex',
  // A string metadata id wins even when empty or invalid; validation happens after selection.
  sessionSources: [{ kind: 'meta', resolve: meta => typeof meta?.threadId === 'string' ? meta.threadId : undefined, rejoinable: () => true },
    { kind: 'env', resolve: (_meta, env) => env.CODEX_THREAD_ID, rejoinable: () => true }],
  codec: claudeStyleCodec,
  restoreAtStartup: true,
  install,
  uninstall: (flags, deps) => install([...flags, '--uninstall'], deps),
  wakeLadder: [codexWakeDriver],
  wakeWarningName: 'codex',
};
