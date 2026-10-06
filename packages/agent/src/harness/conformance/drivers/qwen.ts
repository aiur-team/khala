import path from 'node:path';
import * as fs from 'node:fs/promises';
import { claudeStyleDriver, type FakeHarnessDriver } from '../driver';
import { createQwenSocketDriver } from '../../../wake/qwen-socket';

export const qwenDriver: FakeHarnessDriver = (() => {
  let prompt: string | undefined;
  let transcript: string | undefined;
  const base = claudeStyleDriver('unused');
  return {
    ...base,
    newSession: () => ({ id: 'conformance-session', mcpEnv: {}, mcpMeta: { khala_session: 'conformance-session' } }),
    async prepareSession(session, env) {
      env.QWEN_HOME = path.join(env.XDG_STATE_HOME!, 'qwen-config');
      env.QWEN_CODE_MESSAGING_SOCKET = '/fake';
      await fs.mkdir(path.join(env.QWEN_HOME, 'sessions'), { recursive: true });
      await fs.writeFile(path.join(env.QWEN_HOME, 'sessions', '123.json'), JSON.stringify({ ipcPath: '/fake', sessionId: session.id }));
    },
    hookStdin: (event, session) => JSON.stringify({ ...JSON.parse(base.hookStdin(event, session)),
      ...(event === 'stop' && transcript ? { transcript_path: transcript } : {}) }),
    wakeProbe() {
      prompt = undefined;
      return {
        verificationEvent: 'stop',
        drivers: [createQwenSocketDriver({ platform: 'linux', resolve: async () => ({ socket: '/fake', sessionId: 'conformance-session', token: 'not-logged' }),
          send: async (_target, line) => {
            prompt = line;
            await fs.writeFile(transcript!, JSON.stringify({ type: 'user', provenance: 'system', subtype: 'notification', deliveredTurn: true,
              message: { role: 'user', parts: [{ text: line }] } }) + '\n');
            return 'delivered';
          } })],
        prepare: async files => { transcript = path.join(files.dir, 'qwen-transcript.jsonl'); },
        prompt: () => prompt,
      };
    },
  };
})();
