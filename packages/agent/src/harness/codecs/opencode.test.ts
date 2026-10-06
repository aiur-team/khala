import { expect, it } from 'vitest';
import { opencodeCodec as codec } from './opencode';

it.each([['session-start', 'start'], ['prompt', 'prompt'], ['post-tool', 'tool'], ['turn-end', 'stop'], ['idle', 'stop']] as const)
('normalizes %s and returns a raw frame', (event, kind) => {
  expect(codec.parse(JSON.stringify({ session_id: 'ses_123', event, prompt: 'hello' })))
    .toEqual({ sessionId: 'ses_123', event: kind, continuation: false, promptText: 'hello' });
  expect(codec.noop(kind)).toBe('');
  if (kind !== 'start') expect(codec.render(kind, '<frame>\n')).toBe('<frame>\n');
});
it.each(['null', '{}', 'bad', '{"session_id":1,"event":"prompt"}', '{"session_id":"s","event":"toString"}'])
('rejects invalid input %s', stdin => expect(codec.parse(stdin)).toBeNull());
