import type { DeliverCodec } from '../adapter';

const events = { 'session-start': 'start', prompt: 'prompt', 'post-tool': 'tool', 'turn-end': 'stop', idle: 'stop' } as const;

/** The plugin injects the raw frame returned by the CLI. */
export const opencodeCodec: DeliverCodec = {
  promptAcceptsContext: true,
  promptDeliversWithoutWake: true,
  suppressOutputErrors: false,
  parse(stdin) {
    try {
      const input = JSON.parse(stdin.replace(/^\uFEFF/u, ''));
      if (!input || typeof input.session_id !== 'string' || typeof input.event !== 'string'
        || !Object.hasOwn(events, input.event)) return null;
      return { sessionId: input.session_id, event: events[input.event as keyof typeof events], continuation: false,
        ...(typeof input.prompt === 'string' ? { promptText: input.prompt } : {}) };
    } catch { return null; }
  },
  noop: () => '',
  render: (_kind, frame) => frame,
};
