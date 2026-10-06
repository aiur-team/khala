import type { DeliverCodec } from '../adapter';

const events = { SessionStart: 'start', BeforeAgent: 'prompt', AfterTool: 'tool', AfterAgent: 'stop' } as const;
const names = { prompt: 'BeforeAgent', tool: 'AfterTool' } as const;

/** Gemini retries are guarded by the delivered cursor, not an unverified retry flag. */
export const geminiCodec: DeliverCodec = {
  promptDeliversWithoutWake: false,
  promptAcceptsContext: false,
  suppressOutputErrors: false,
  parse(stdin) {
    try {
      const input = JSON.parse(stdin.replace(/^\uFEFF/u, ''));
      if (!input || typeof input.session_id !== 'string' || typeof input.hook_event_name !== 'string'
        || !Object.hasOwn(events, input.hook_event_name)) return null;
      return { sessionId: input.session_id, event: events[input.hook_event_name as keyof typeof events], continuation: false,
        ...(typeof input.cwd === 'string' ? { workspace: input.cwd } : {}),
        ...(typeof input.prompt === 'string' ? { promptText: input.prompt } : {}) };
    } catch { return null; }
  },
  noop: kind => JSON.stringify(kind === 'stop' ? { decision: 'allow' } : {}) + '\n',
  render(kind, frame) {
    return JSON.stringify(kind === 'stop' ? { decision: 'deny', reason: frame }
      : { hookSpecificOutput: { hookEventName: names[kind], additionalContext: frame } }) + '\n';
  },
};
