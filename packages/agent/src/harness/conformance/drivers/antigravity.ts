import * as fs from 'node:fs';
import path from 'node:path';
import { registerAntigravityWake, createAntigravityWakeDriver } from '../../../wake/antigravity';
import type { FakeHarnessDriver } from '../driver';
import { createTerminalWakeDriver } from '../../../wake/terminal/driver';
import { writeJsonAtomic } from '../../../state';

export function createAntigravityConformanceDriver(transport: 'native' | 'terminal' | 'rejected-native' = 'native'): FakeHarnessDriver {
  let wakeTransport: 'native' | 'terminal' = 'native';
  let appendTranscript: (() => void) | undefined;
  return {
    syncGuard: 'cursor',
    newSession: workspace => ({ ...(workspace ? { workspace } : {}), id: 'conformance-session', mcpEnv: { ANTIGRAVITY_CONVERSATION_ID: 'conformance-session' },
      mcpMeta: { 'antigravity.google/conversation_id': 'conformance-session' } }),
    hookStdin(event, session) {
      // agy appends the wake step after PreInvocation returns, not before it runs.
      const transcript = session.workspace ? path.join(session.workspace, 'transcript.jsonl') : undefined;
      if (transcript && session.promptText) appendTranscript = () => fs.writeFileSync(transcript, JSON.stringify(wakeTransport === 'native'
        ? { source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: `[Message] sender=system content=${session.promptText}` }
        : { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: session.promptText }) + '\n');
      return JSON.stringify({ conversationId: session.id, khalaHookEvent: event === 'stop' ? 'Stop' : 'PreInvocation',
        invocationNum: event === 'tool' ? 1 : 0, ...(transcript ? { transcriptPath: transcript } : {}) });
    },
    readHookStdout(stdout) {
      const output = JSON.parse(stdout);
      if (output.decision === 'continue') return { kind: 'continue', frame: output.reason };
      if (output.injectSteps?.[0]?.ephemeralMessage) return { kind: 'context', frame: output.injectSteps[0].ephemeralMessage };
      return { kind: 'none' };
    },
    wakeProbe(adapter) {
      let prompt: string | undefined;
      let terminalLine = '>', column = 2;
      const terminal = createTerminalWakeDriver(adapter.emptyPrompt, {
        platform: 'linux', ownsTerminal: async () => true, delay: async () => {},
        readProcess: async pid => pid === 100 ? { pid, ppid: 0, command: 'agy', startTime: 'harness' } : null,
        run: async (_command, argv) => {
          if (argv[0] === 'display-message') return `100|0|0|${column}|18|/dev/pts/1|0`;
          if (argv[0] === 'capture-pane') return terminalLine;
          if (argv.includes('-l')) { terminalLine = `> ${argv.at(-1)}`; column = terminalLine.length; }
          if (argv.at(-1) === 'Enter') { wakeTransport = 'terminal'; prompt = terminalLine.slice(2); }
          return '';
        },
      });
      return {
        drivers: [createAntigravityWakeDriver(async (_command, argv) => {
          if (transport === 'rejected-native') return false;
          wakeTransport = 'native'; prompt = argv.at(-1); return true;
        }), terminal],
        prompt: () => prompt,
        async afterPrompt() { appendTranscript?.(); appendTranscript = undefined; },
        async prepare(files) {
          prompt = undefined; terminalLine = '>'; column = 2;
          await writeJsonAtomic(path.join(files.dir, 'pane.json'), { kind: 'tmux', paneId: '%7', agentPid: 100,
            agentStartTime: 'harness', capturedAt: '2026-10-05T12:00:00Z' });
          if (transport !== 'terminal') await registerAntigravityWake({ XDG_STATE_HOME: path.resolve(files.dir, '../../..'),
            ANTIGRAVITY_CONVERSATION_ID: path.basename(files.dir), ANTIGRAVITY_LS_ADDRESS: 'localhost:1234', ANTIGRAVITY_CSRF_TOKEN: 'fixture-secret' });
        },
      };
    },
  };
}
export const antigravityDriver = createAntigravityConformanceDriver();
