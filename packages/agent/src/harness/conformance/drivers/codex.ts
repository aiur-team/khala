import { createCodexWakeDriver } from '../../../wake/codex';
import { claudeStyleDriver, type FakeHarnessDriver } from '../driver';

export const codexDriver: FakeHarnessDriver = {
  ...claudeStyleDriver('CODEX_THREAD_ID'),
  newSession: () => ({ id: 'conformance-session', mcpEnv: { CODEX_THREAD_ID: 'conformance-session' },
    mcpMeta: { threadId: 'conformance-session' } }),
  wakeProbe(adapter) {
    let prompt: string | undefined;
    return {
      drivers: (adapter.wakeLadder ?? []).map(driver => driver.id === 'queue'
        ? createCodexWakeDriver({ probe: async () => ({ available: true, command: 'codex' }), port: { async run(argv) {
          prompt = argv[argv.indexOf('--message') + 1];
          return { status: 'queued' };
        } } }) : driver),
      prompt: () => prompt,
    };
  },
};
