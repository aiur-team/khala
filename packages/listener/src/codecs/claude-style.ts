/** Hook dialect parsing and stdout, separate from shared delivery state. */
export type DeliverCodec = Readonly<{
  parse(stdin: string): { sessionId?: string; event: 'start' | 'prompt' | 'tool' | 'stop' | 'limit'; continuation: boolean; promptText?: string; workspace?: string; replay?: boolean; transcriptPath?: string } | null;
  /** stopContext: the running harness is known to honour Stop additionalContext (see stopContextFloor). */
  render(kind: 'prompt' | 'tool' | 'stop', frame: string, stopContext?: boolean): string;
  /** Lowest harness version verified to show Stop additionalContext once and continue the turn. */
  stopContextFloor?: string;
  noop(kind?: 'start' | 'prompt' | 'tool' | 'stop' | 'limit'): string;
  /** Some prompt hooks can only record activity, without injecting context. */
  promptAcceptsContext: boolean;
  /** Cursor silently tolerates a closed stdout pipe; Claude-style reports it. */
  suppressOutputErrors: boolean;
  promptDeliversWithoutWake: boolean;
  fallbackSession?: string;
}>;

const events = { SessionStart: 'start', UserPromptSubmit: 'prompt', PostToolUse: 'tool', Stop: 'stop', StopFailure: 'limit' } as const;
/** StopFailure error types that leave the agent unable to work until the limit resets. */
const LIMIT_ERRORS = ['rate_limit', 'billing_error'];
const names = { prompt: 'UserPromptSubmit', tool: 'PostToolUse', stop: 'Stop' } as const;

/** Claude and Codex share the same hook payload and envelopes. */
export function createClaudeStyleCodec(stopNudge: string): DeliverCodec {
  return {
    promptDeliversWithoutWake: true,
    promptAcceptsContext: true,
    suppressOutputErrors: false,
    parse(stdin) {
      try {
        const input = JSON.parse(stdin);
        if (!input || typeof input.session_id !== 'string'
          || typeof input.hook_event_name !== 'string' || !Object.hasOwn(events, input.hook_event_name)
          || (input.stop_hook_active !== undefined && typeof input.stop_hook_active !== 'boolean')
          || (input.hook_event_name === 'StopFailure' && !LIMIT_ERRORS.includes(input.error))) return null;
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
        ? { decision: 'block', reason: stopNudge }
        : { hookSpecificOutput: { hookEventName: names[kind], additionalContext: frame } }) + '\n';
    },
  };
}
