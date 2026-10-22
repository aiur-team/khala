import { STOP_NUDGE, type DeliverCodec } from '../adapter';

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
        ...(typeof input.cwd === 'string' ? { workspace: input.cwd } : {}),
        ...(typeof input.transcript_path === 'string' ? { transcriptPath: input.transcript_path } : {}),
        ...(typeof input.prompt === 'string' ? { promptText: input.prompt } : {}) };
    } catch { return null; }
  },
  noop: () => '',
  render(kind, frame, stopContext = false) {
    return JSON.stringify(kind === 'stop' && !stopContext
      ? { decision: 'block', reason: STOP_NUDGE }
      : { hookSpecificOutput: { hookEventName: names[kind], additionalContext: frame } }) + '\n';
  },
};

/** Claude shows a Stop block reason twice (as a user turn and as a system note). Stop additionalContext
 * arrives once and the turn continues, but that is verified only from this version (live, 2.1.307);
 * older or unknown versions keep the documented decision:block, which is always shown. A block reason is a
 * user turn, so it carries only STOP_NUDGE. */
export const claudeCodec: DeliverCodec = { ...claudeStyleCodec, stopContextFloor: '2.1.307' };
