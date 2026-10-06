import type { DeliverCodec } from '../adapter';

const events = { SessionStart: 'start', UserPromptSubmit: 'prompt', PostToolUse: 'tool', Stop: 'stop' } as const;
const names = { prompt: 'UserPromptSubmit', tool: 'PostToolUse', stop: 'Stop' } as const;

/** Claude and Codex share the same hook payload and envelopes. */
export const claudeStyleCodec: DeliverCodec = {
  promptDeliversWithoutWake: true,
  promptAcceptsContext: true,
  suppressOutputErrors: false,
  parse(stdin) {
    try {
      const input = JSON.parse(stdin);
      if (!input || typeof input.session_id !== 'string'
        || typeof input.hook_event_name !== 'string' || !Object.hasOwn(events, input.hook_event_name)
        || (input.stop_hook_active !== undefined && typeof input.stop_hook_active !== 'boolean')) return null;
      return { sessionId: input.session_id, event: events[input.hook_event_name as keyof typeof events],
        continuation: input.stop_hook_active === true,
        ...(typeof input.cwd === 'string' ? { workspace: input.cwd } : {}) };
    } catch { return null; }
  },
  noop: () => '',
  render(kind, frame) {
    return JSON.stringify(kind === 'stop'
      ? { decision: 'block', reason: frame }
      : { hookSpecificOutput: { hookEventName: names[kind], additionalContext: frame } }) + '\n';
  },
};
