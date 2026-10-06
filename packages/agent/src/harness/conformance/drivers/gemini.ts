import path from 'node:path';
import { writeJsonAtomic } from '../../../state';
import { createTerminalWakeDriver } from '../../../wake/terminal/driver';
import type { FakeHarnessDriver } from '../driver';

export const geminiDriver: FakeHarnessDriver = {
  syncGuard: 'cursor',
  newSession: () => ({ id: 'conformance-session', mcpEnv: { GEMINI_SESSION_ID: 'conformance-session' } }),
  hookStdin: (event, session) => JSON.stringify({ session_id: session.id,
    hook_event_name: { prompt: 'BeforeAgent', tool: 'AfterTool', stop: 'AfterAgent' }[event],
    stop_hook_active: session.continuation ?? false,
    ...(session.promptText !== undefined ? { prompt: session.promptText } : {}) }),
  readHookStdout(stdout) {
    const output = JSON.parse(stdout);
    if (output.decision === 'deny') return { kind: 'continue', frame: output.reason };
    if (output.hookSpecificOutput?.additionalContext) return { kind: 'context', frame: output.hookSpecificOutput.additionalContext };
    return { kind: 'none' };
  },
  wakeProbe(adapter) {
    let prompt: string | undefined;
    let line = '', column = 3;
    return {
      drivers: [createTerminalWakeDriver(adapter.emptyPrompt, {
        platform: 'linux', ownsTerminal: async () => true, delay: async () => {},
        readProcess: async pid => pid === 100 ? { pid, ppid: 0, command: 'gemini', startTime: 'harness' } : null,
        run: async (_command, argv) => {
          if (argv[0] === 'display-message') return `100|0|0|${column}|18|/dev/pts/1|0`;
          if (argv[0] === 'capture-pane') return line;
          if (argv.includes('-l')) { line = ` > ${argv.at(-1)}`; column = line.length; }
          if (argv.at(-1) === 'Enter') prompt = line.slice(3);
          return '';
        },
      })],
      prompt: () => prompt,
      async prepare(files) {
        prompt = undefined; line = ' >   Type your message or @path/to/file'; column = 3;
        await writeJsonAtomic(path.join(files.dir, 'pane.json'), { kind: 'tmux', paneId: '%7', agentPid: 100,
          agentStartTime: 'harness', capturedAt: '2026-10-05T12:00:00Z' });
      },
    };
  },
};
