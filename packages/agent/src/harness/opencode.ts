import type { HarnessAdapter } from './adapter';
import { opencodeCodec } from './codecs/opencode';
import { hookMapSource } from './session-sources';
import { opencodeWakeDriver, pollOpenCodeWake } from '../wake/opencode';

const install: NonNullable<HarnessAdapter['install']> = async (flags, deps) =>
  (await import('../install/main')).runOpenCodeInstall(flags, deps);

export const opencode: HarnessAdapter = {
  id: 'opencode',
  sessionSources: [{ kind: 'meta', resolve: meta => meta?.khala_session, rejoinable: () => true }, hookMapSource],
  codec: opencodeCodec,
  restoreAtStartup: false,
  wakeLadder: [opencodeWakeDriver],
  pollIdleWake: pollOpenCodeWake,
  install,
  uninstall: (flags, deps) => install([...flags, '--uninstall'], deps),
};
