import { expect, it } from 'vitest';
import { copilotCodec, createCopilotCodec } from './copilot';

it.each(['sessionStart', 'userPromptSubmitted', 'postToolUse', 'agentStop'])('parses camelCase %s with argv event', event => {
  expect(createCopilotCodec(event).parse(JSON.stringify({ sessionId: 'session', cwd: '/work', prompt: 'hello' })))
    .toMatchObject({ sessionId: 'session', continuation: false, workspace: '/work', promptText: 'hello' });
});
it('parses snake_case, BOM and the continuation guard', () => {
  expect(copilotCodec.parse('\uFEFF' + JSON.stringify({ session_id: 'session', hook_event_name: 'Stop', stop_hook_active: true })))
    .toEqual({ sessionId: 'session', event: 'stop', continuation: true });
  expect(createCopilotCodec('agentStop').parse('{"sessionId":"session","stopHookActive":true}')?.continuation).toBe(true);
});
it.each(['null', '[]', '{}', 'broken', '{"sessionId":"session","stop_hook_active":"true"}'])('ignores invalid payload %s', stdin => {
  expect(createCopilotCodec('agentStop').parse(stdin)).toBeNull();
});
it('always emits JSON with Copilot delivery frames', () => {
  expect(copilotCodec.noop()).toBe('{}\n');
  expect(copilotCodec.render('prompt', 'frame')).toBe('{}\n');
  expect(JSON.parse(copilotCodec.render('tool', 'frame'))).toEqual({ additionalContext: 'frame' });
  expect(JSON.parse(copilotCodec.render('stop', 'frame'))).toEqual({ decision: 'block', reason: 'frame' });
});
