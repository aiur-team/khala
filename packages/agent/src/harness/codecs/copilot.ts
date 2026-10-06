import type { DeliverCodec } from '../adapter';

const events = { sessionStart: 'start', userPromptSubmitted: 'prompt', postToolUse: 'tool', agentStop: 'stop',
  SessionStart: 'start', UserPromptSubmit: 'prompt', PostToolUse: 'tool', Stop: 'stop' } as const;

/** CLI camelCase payloads omit the event; installed commands supply it explicitly. */
export function createCopilotCodec(event?: string): DeliverCodec {
  return {
    promptDeliversWithoutWake: false, promptAcceptsContext: false, suppressOutputErrors: false,
    parse(stdin) {
      try {
        const input = JSON.parse(stdin.replace(/^\uFEFF/u, ''));
        if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
        const name = event ?? input.hook_event_name ?? input.hookEventName;
        const sessionId = input.sessionId ?? input.session_id;
        const continuation = input.stop_hook_active ?? input.stopHookActive;
        if (typeof name !== 'string' || !Object.hasOwn(events, name) || typeof sessionId !== 'string'
          || (continuation !== undefined && typeof continuation !== 'boolean')) return null;
        return { sessionId, event: events[name as keyof typeof events], continuation: continuation === true,
          ...(typeof input.cwd === 'string' ? { workspace: input.cwd } : {}),
          ...(typeof input.prompt === 'string' ? { promptText: input.prompt } : {}) };
      } catch { return null; }
    },
    noop: () => '{}\n',
    render(kind, frame) {
      return JSON.stringify(kind === 'stop' ? { decision: 'block', reason: frame }
        : kind === 'tool' ? { additionalContext: frame } : {}) + '\n';
    },
  };
}
export const copilotCodec = createCopilotCodec();
