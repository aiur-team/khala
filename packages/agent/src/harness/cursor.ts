import { CURSOR_DEFAULT_SESSION, CURSOR_WORKSPACE_ENV, cursorSessionId } from '../cursor';
import type { HarnessAdapter } from './adapter';

const install: NonNullable<HarnessAdapter['install']> = async (flags, deps) =>
  (await import('../install/main')).runCursorInstall(flags, deps);

export const cursor: HarnessAdapter = {
  id: 'cursor',
  sessionSources: [(_meta, env) => cursorSessionId(env[CURSOR_WORKSPACE_ENV])],
  codec: undefined,
  install,
  uninstall: (flags, deps) => install([...flags, '--uninstall'], deps),
  rejoinable: source => source !== CURSOR_DEFAULT_SESSION,
};
