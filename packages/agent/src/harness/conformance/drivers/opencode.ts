import type { FakeHarnessDriver } from '../driver';
import path from 'node:path';
import { readJson } from '../../../state';

export const opencodeDriver: FakeHarnessDriver = {
  newSession: () => ({ id: 'conformance-session', mcpEnv: {}, mcpMeta: { khala_session: 'conformance-session' } }),
  hookStdin: (event, session) => JSON.stringify({ session_id: session.id,
    event: { prompt: 'prompt', tool: 'post-tool', stop: 'idle' }[event],
    continuation: session.continuation ?? false,
    ...(session.promptText !== undefined ? { prompt: session.promptText } : {}) }),
  readHookStdout(stdout) {
    if (!stdout) return { kind: 'none' };
    const wake = stdout.startsWith('Khala: channel messages are waiting.');
    return { kind: wake ? 'continue' : 'context', frame: wake ? stdout.slice(stdout.indexOf('\n') + 1) : stdout };
  },
  wakeProbe(adapter) {
    let prompt: string | undefined;
    return {
      drivers: (adapter.wakeLadder ?? []).map(driver => ({ ...driver, async wake(ctx, line) {
        const result = await driver.wake(ctx, line);
        if (result !== 'skipped') {
          const pending = await readJson<{ line: string }>(path.join(ctx.files.dir, 'opencode-wake.json'));
          prompt = pending?.line;
        }
        return result;
      } })),
      prompt: () => prompt,
    };
  },
};
