import type { HarnessAdapter } from './adapter';
import { walkAncestors, readProcess, readProcessArguments } from './proc';
import { antigravityCodec } from './codecs/antigravity';
import { createAntigravityWakeDriver, antigravityPromptText } from '../wake/antigravity';
import { createTerminalWakeDriver } from '../wake/terminal/driver';

// U28 captured the bare > prompt at column 2. Unmeasured host layouts fail closed.
const emptyPrompt = { pattern: /^>$/u, cursorColumn: 2 };
const install: NonNullable<HarnessAdapter['install']> = async (flags, deps) =>
  (await import('../install/main')).runAntigravityInstall(flags, deps);
export const antigravity: HarnessAdapter = {
  id: 'antigravity', restoreAtStartup: true, codec: antigravityCodec,
  sessionSources: [
    { kind: 'meta', resolve: meta => meta?.['antigravity.google/conversation_id'], rejoinable: () => true },
    { kind: 'env', resolve: (_meta, env) => env.ANTIGRAVITY_CONVERSATION_ID, rejoinable: () => true },
    {
      kind: 'process', rejoinable: () => true,
      async resolve(_meta, _env, context) {
        const read = context.readProcess ?? readProcess;
        for await (const parent of walkAncestors(context.pid ?? process.pid, read)) {
          if (!/^agy(?:\.exe)?$/iu.test(parent.command.split(/[\\/]/u).pop() ?? '')) continue;
          const args = await (context.readArguments ?? readProcessArguments)(parent.pid);
          if (!args || (await read(parent.pid))?.startTime !== parent.startTime) return null;
          // Only an explicit resumed conversation identifies startup intake. A fresh
          // CLI has no identity yet; never substitute the last workspace session.
          for (let i = 1; i < args.length; i++) {
            if (args[i] === '--') break;
            if (args[i] === '--conversation') return args[i + 1] ?? '';
            if (args[i]?.startsWith('--conversation=')) return args[i]!.slice('--conversation='.length);
          }
          return null;
        }
        return null;
      },
    },
  ],
  install, uninstall: (flags, deps) => install([...flags, '--uninstall'], deps), emptyPrompt,
  wakeLadder: [createAntigravityWakeDriver(), createTerminalWakeDriver(emptyPrompt)],
  wakeWarningName: 'antigravity', hookPromptText: antigravityPromptText,
};
