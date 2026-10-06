import { expect, it } from 'vitest';
import { claudeStyleCodec as codec } from './claude-style';

it.each([
  ['UserPromptSubmit', 'prompt'], ['PostToolUse', 'tool'], ['Stop', 'stop'],
] as const)('normalizes %s and renders its existing envelope', (name, event) => {
  expect(codec.parse(JSON.stringify({ session_id: 'session', hook_event_name: name })))
    .toEqual({ sessionId: 'session', event, continuation: false });
  expect(codec.render(event, 'frame')).toBe(JSON.stringify(event === 'stop'
    ? { decision: 'block', reason: 'frame' }
    : { hookSpecificOutput: { hookEventName: name, additionalContext: 'frame' } }) + '\n');
  expect(codec.noop(event)).toBe('');
});
it('normalizes the stop continuation flag without interpreting the prompt', () => {
  expect(codec.parse('{"session_id":"s","hook_event_name":"Stop","stop_hook_active":true}'))
    .toEqual({ sessionId: 's', event: 'stop', continuation: true });
});
it.each(['garbage', 'null', '{}', '\uFEFF{}',
  '{"session_id":1,"hook_event_name":"Stop"}',
  '{"session_id":"s","hook_event_name":["Stop"]}',
  '{"session_id":"s","hook_event_name":"toString"}',
  '{"session_id":"s","hook_event_name":"Stop","stop_hook_active":"true"}',
])('rejects malformed stdin %s with silent no-op', stdin => {
  expect(codec.parse(stdin)).toBeNull();
  expect(codec.noop()).toBe('');
});

it('normalizes optional transcript paths and ignores non-string paths', () => {
  const input = { session_id: 's', hook_event_name: 'UserPromptSubmit' };
  expect(codec.parse(JSON.stringify({ ...input, transcript_path: '/tmp/session.jsonl' }))?.transcriptPath).toBe('/tmp/session.jsonl');
  expect(codec.parse(JSON.stringify({ ...input, transcript_path: 12 }))?.transcriptPath).toBeUndefined();
});
