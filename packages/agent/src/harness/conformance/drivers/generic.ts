import type { FakeHarnessDriver } from '../driver';

export const genericDriver: FakeHarnessDriver = {
  newSession: () => ({ id: 'generic-session', mcpEnv: { KHALA_SESSION_ID: 'generic-session' } }),
  hookStdin: () => '{}',
  readHookStdout(stdout) {
    if (stdout) throw new Error('generic hooks must not emit output');
    return { kind: 'none' };
  },
};
