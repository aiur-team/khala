import { expect, it } from 'vitest';
import { cursorCodec as codec } from './cursor';
import { CURSOR_DEFAULT_SESSION, cursorSessionId } from '../../cursor';

it.each([
  ['beforeSubmitPrompt', 'prompt', { continue: true }], ['postToolUse', 'tool', {}], ['stop', 'stop', {}],
] as const)('accepts BOM-prefixed %s and owns its no-op', (name, event, noop) => {
  expect(codec.parse('\uFEFF' + JSON.stringify({ hook_event_name: name, workspace_roots: ['/work/project'] })))
    .toEqual({ sessionId: cursorSessionId('/work/project'), workspace: '/work/project', event, continuation: false });
  expect(codec.noop(event)).toBe(JSON.stringify(noop) + '\n');
  expect(codec.render(event, 'frame')).toBe(JSON.stringify(event === 'prompt' ? noop
    : event === 'tool' ? { additional_context: 'frame' } : { followup_message: 'frame' }) + '\n');
});
it.each([1, 2, 0.5, 0, -1, '1', null])('retains loop_count semantics for %s', loop_count => {
  expect(codec.parse(JSON.stringify({ hook_event_name: 'stop', loop_count }))?.continuation)
    .toBe(typeof loop_count === 'number' && loop_count > 0);
});
it.each([undefined, [], [123, '/ignored'], ['${workspaceFolder}']])('uses the default session for unusable roots %s', workspace_roots => {
  expect(codec.parse(JSON.stringify({ hook_event_name: 'stop', workspace_roots }))?.sessionId).toBe(CURSOR_DEFAULT_SESSION);
  expect(codec.fallbackSession).toBe(CURSOR_DEFAULT_SESSION);
});
it.each(['garbage', 'null', '{}', '{"hook_event_name":"toString"}', '{"hook_event_name":["stop"]}'])
('rejects malformed stdin %s with an empty JSON no-op', stdin => {
  expect(codec.parse(stdin)).toBeNull();
  expect(codec.noop()).toBe('{}\n');
});
