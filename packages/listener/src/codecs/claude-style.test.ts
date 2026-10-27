import { expect, it } from 'vitest';
import { createClaudeStyleCodec } from '../index';

const codec = createClaudeStyleCodec('Product-owned nudge');
it('decodes Claude/Codex hooks and preserves optional context fields', () => {
  for (const [hook_event_name, event] of [['SessionStart', 'start'], ['UserPromptSubmit', 'prompt'], ['PostToolUse', 'tool'], ['Stop', 'stop'], ['StopFailure', 'limit']]) {
    expect(codec.parse(JSON.stringify({ session_id: 'session', hook_event_name, error: 'rate_limit', stop_hook_active: true,
      cwd: '/work', transcript_path: '/transcript', prompt: 'hello' }))).toEqual({ sessionId: 'session', event,
      continuation: true, workspace: '/work', transcriptPath: '/transcript', promptText: 'hello' });
  }
  expect(codec.parse('{"session_id":"s","hook_event_name":"Stop"}')).toEqual({ sessionId: 's', event: 'stop', continuation: false });
});
it('rejects malformed hooks and unrelated StopFailure errors', () => {
  for (const input of ['{', 'null', '{}', '{"session_id":1,"hook_event_name":"Stop"}',
    '{"session_id":"s","hook_event_name":"toString"}', '{"session_id":"s","hook_event_name":"Stop","stop_hook_active":1}',
    '{"session_id":"s","hook_event_name":"StopFailure","error":"other"}']) expect(codec.parse(input)).toBeNull();
  expect(codec.parse('{"session_id":"s","hook_event_name":"StopFailure","error":"billing_error"}')).toEqual({ sessionId: 's', event: 'limit', continuation: false });
});
it('renders hook envelopes with caller-owned Stop copy and explicit Stop context', () => {
  expect(codec.noop()).toBe('');
  for (const [event, hookEventName] of [['prompt', 'UserPromptSubmit'], ['tool', 'PostToolUse'], ['stop', 'Stop']] as const) {
    expect(codec.render(event, 'frame', true)).toBe(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: 'frame' } }) + '\n');
  }
  expect(codec.render('stop', 'private frame')).toBe('{"decision":"block","reason":"Product-owned nudge"}\n');
  expect(codec.promptAcceptsContext).toBe(true);
  expect(codec.promptDeliversWithoutWake).toBe(true);
  expect(codec.suppressOutputErrors).toBe(false);
});
