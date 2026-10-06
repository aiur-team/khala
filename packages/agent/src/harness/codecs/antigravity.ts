import type { DeliverCodec } from '../adapter';

/** Event names come from the installed command, not Antigravity's stdin. */
export const antigravityCodec: DeliverCodec = {
  promptDeliversWithoutWake: false, promptAcceptsContext: false, suppressOutputErrors: false,
  parse(stdin) {
    try {
      const input = JSON.parse(stdin.replace(/^\uFEFF/u, ''));
      if (!input || typeof input.conversationId !== 'string') return null;
      let event: 'prompt' | 'tool' | 'stop';
      if (input.khalaHookEvent === 'PreInvocation' && Number.isInteger(input.invocationNum) && input.invocationNum >= 0)
        event = input.invocationNum === 0 ? 'prompt' : 'tool';
      else if (input.khalaHookEvent === 'Stop') event = 'stop';
      else return null;
      return { sessionId: input.conversationId, event, continuation: false,
        ...(typeof input.transcriptPath === 'string' ? { transcriptPath: input.transcriptPath } : {}),
        ...(typeof input.workspacePaths?.[0] === 'string' ? { workspace: input.workspacePaths[0] } : {}) };
    } catch { return null; }
  },
  noop: kind => JSON.stringify(kind === 'stop' ? { decision: 'stop' } : {}) + '\n',
  render: (kind, frame) => JSON.stringify(kind === 'stop' ? { decision: 'continue', reason: frame }
    : { injectSteps: [{ ephemeralMessage: frame }] }) + '\n',
};
