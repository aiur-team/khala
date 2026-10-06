import * as fs from 'node:fs';
import path from 'node:path';
import { registerAntigravityWake, createAntigravityWakeDriver } from '../../../wake/antigravity';
import type { FakeHarnessDriver } from '../driver';
import { geminiDriver } from './gemini';

export const antigravityDriver: FakeHarnessDriver = {
  syncGuard: 'cursor',
  newSession: () => ({ id: 'conformance-session', mcpEnv: { ANTIGRAVITY_CONVERSATION_ID: 'conformance-session' },
    mcpMeta: { 'antigravity.google/conversation_id': 'conformance-session' } }),
  hookStdin(event, session) {
    // The hook stdin has no prompt field. Materialize the SYSTEM_MESSAGE capture used by native wake.
    const transcript = session.workspace ? path.join(session.workspace, 'transcript.jsonl') : undefined;
    if (transcript && session.promptText) fs.writeFileSync(transcript, JSON.stringify({ source: 'SYSTEM', type: 'SYSTEM_MESSAGE',
      content: `[Message] sender=system content=${session.promptText}` }) + '\n');
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
    const terminal = geminiDriver.wakeProbe!(adapter);
    return {
      drivers: [createAntigravityWakeDriver(async (_command, argv) => { prompt = argv.at(-1); return true; }), ...terminal.drivers],
      prompt: () => prompt ?? terminal.prompt(),
      async prepare(files) {
        prompt = undefined;
        await registerAntigravityWake({ XDG_STATE_HOME: path.resolve(files.dir, '../../..'),
          ANTIGRAVITY_CONVERSATION_ID: path.basename(files.dir), ANTIGRAVITY_LS_ADDRESS: 'localhost:1234', ANTIGRAVITY_CSRF_TOKEN: 'fixture-secret' });
      },
    };
  },
};
