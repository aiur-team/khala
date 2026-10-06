import { cursorCodec } from './codecs/cursor';
import { CURSOR_DEFAULT_SESSION, CURSOR_WORKSPACE_ENV, cursorSessionId } from '../cursor';
import type { HarnessAdapter } from './adapter';

const install: NonNullable<HarnessAdapter['install']> = async (flags, deps) =>
  (await import('../install/main')).runCursorInstall(flags, deps);

export const cursor: HarnessAdapter = {
  id: 'cursor',
  sessionSources: [{ kind: 'workspace', resolve: (_meta, env) => cursorSessionId(env[CURSOR_WORKSPACE_ENV]),
    rejoinable: sessionId => sessionId !== CURSOR_DEFAULT_SESSION }],
  codec: cursorCodec,
  restoreAtStartup: false,
  install,
  uninstall: (flags, deps) => install([...flags, '--uninstall'], deps),
};
