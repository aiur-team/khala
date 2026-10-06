import path from 'node:path';
import { writeJsonAtomic } from '../../../state';
import { createTerminalWakeDriver } from '../../../wake/terminal/driver';
import { claudeStyleDriver, type FakeHarnessDriver } from '../driver';

export const claudeDriver: FakeHarnessDriver = {
  ...claudeStyleDriver('CLAUDE_CODE_SESSION_ID'),
  wakeProbe(adapter) {
    let prompt: string | undefined;
    let composer: string | undefined;
    return {
      drivers: (adapter.wakeLadder ?? []).map(driver => driver.id === 'terminal'
        ? createTerminalWakeDriver(adapter.emptyPrompt, {
          platform: 'linux',
          readProcess: async pid => ({ pid, ppid: 0, startTime: 'agent-start', command: 'claude' }),
          ownsTerminal: async () => true,
          delay: async () => {},
          async run(_command, argv) {
            if (argv[0] === 'display-message') return `100\t0\t0\t${2 + (composer?.length ?? 0)}\t0\t/dev/pts/7`;
            if (argv[0] === 'show-window-options') return 'off';
            if (argv[0] === 'capture-pane') return composer ? `❯ ${composer}` : '❯ ';
            if (argv[0] === 'send-keys') {
              if (argv.includes('-l')) composer = argv[argv.indexOf('-l') + 1];
              else if (argv.at(-1) === 'Enter') { prompt = composer; composer = undefined; }
              return '';
            }
            throw new Error('unexpected_terminal_command');
          },
        }) : driver),
      prepare: async files => { await writeJsonAtomic(path.join(files.dir, 'pane.json'), {
        kind: 'tmux', paneId: '%7', agentPid: 100, agentStartTime: 'agent-start', capturedAt: '2026-10-05T12:00:00Z',
      }); },
      prompt: () => prompt,
    };
  },
};
