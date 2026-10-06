import { expect, it } from 'vitest';
import { geminiCodec } from './gemini';

it.each([['SessionStart', 'start'], ['BeforeAgent', 'prompt'], ['AfterTool', 'tool'], ['AfterAgent', 'stop']])('parses %s without relying on the retry flag', (hook_event_name, event) => {
  expect(geminiCodec.parse(JSON.stringify({ session_id: 's', hook_event_name, cwd: '/work', prompt: 'hello', stop_hook_active: true })))
    .toEqual({ sessionId: 's', event, continuation: false, workspace: '/work', promptText: 'hello' });
});
it.each(['garbage', 'null', '{}', '{"session_id":"s","hook_event_name":"BeforeModel"}'])('rejects malformed or unrelated input %s', input => {
  expect(geminiCodec.parse(input)).toBeNull();
});
it('emits JSON context, deny and allow envelopes', () => {
  expect(JSON.parse(geminiCodec.render('tool', 'frame'))).toEqual({ hookSpecificOutput: { hookEventName: 'AfterTool', additionalContext: 'frame' } });
  expect(JSON.parse(geminiCodec.render('stop', 'frame'))).toEqual({ decision: 'deny', reason: 'frame' });
  expect(JSON.parse(geminiCodec.noop('stop'))).toEqual({ decision: 'allow' });
  expect(JSON.parse(geminiCodec.noop('start'))).toEqual({});
});
