import type { DeliverCodec } from '../adapter';
import { CURSOR_DEFAULT_SESSION, cursorSessionId } from '../../cursor';

const events = { beforeSubmitPrompt: 'prompt', postToolUse: 'tool', stop: 'stop' } as const;

/** Cursor prompt hooks only record activity; stop and tool hooks can inject context. */
export const cursorCodec: DeliverCodec = {
  promptDeliversWithoutWake: false,
  promptAcceptsContext: false,
  suppressOutputErrors: true,
  fallbackSession: CURSOR_DEFAULT_SESSION,
  parse(stdin) {
    try {
      const input = JSON.parse(stdin.replace(/^\uFEFF/u, ''));
      if (!input || typeof input.hook_event_name !== 'string' || !Object.hasOwn(events, input.hook_event_name)) return null;
      const workspace = Array.isArray(input.workspace_roots) && typeof input.workspace_roots[0] === 'string'
        ? input.workspace_roots[0] : undefined;
      return { sessionId: cursorSessionId(workspace), event: events[input.hook_event_name as keyof typeof events],
        continuation: typeof input.loop_count === 'number' && input.loop_count > 0,
        ...(typeof input.prompt === 'string' ? { promptText: input.prompt } : {}),
        ...(workspace !== undefined ? { workspace } : {}) };
    } catch { return null; }
  },
  noop: kind => JSON.stringify(kind === 'prompt' ? { continue: true } : {}) + '\n',
  render(kind, frame) {
    if (kind === 'prompt') return cursorCodec.noop(kind);
    return JSON.stringify(kind === 'stop' ? { followup_message: frame } : { additional_context: frame }) + '\n';
  },
};
