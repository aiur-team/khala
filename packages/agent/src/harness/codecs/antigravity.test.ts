import * as fs from 'node:fs/promises';
import { expect, it } from 'vitest';
import { antigravityCodec as codec } from './antigravity';

it('parses the captured PreInvocation and Stop fixtures and emits their accepted shapes', async () => {
  const dir = new URL('../fixtures/antigravity/', import.meta.url);
  for (const name of await fs.readdir(dir)) {
    if (!name.startsWith('hook.')) continue;
    const fixture = JSON.parse(await fs.readFile(new URL(name, dir), 'utf8'));
    const parsed = codec.parse(JSON.stringify({ ...fixture.stdin, khalaHookEvent: fixture.event }));
    if (!['PreInvocation', 'Stop'].includes(fixture.event)) { expect(parsed).toBeNull(); continue; }
    expect(parsed?.sessionId).toBe(fixture.stdin.conversationId);
    expect(parsed?.event).toBe(fixture.event === 'Stop' ? 'stop' : fixture.stdin.invocationNum === 0 ? 'prompt' : 'tool');
    expect(parsed?.continuation).toBe(false);
    if (name.includes('inject-ephemeral')) expect(JSON.parse(codec.render('tool', fixture.stdout.injectSteps[0].ephemeralMessage))).toEqual(fixture.stdout);
    if (name.includes('continue')) expect(JSON.parse(codec.render('stop', fixture.stdout.reason))).toEqual(fixture.stdout);
    if (name.includes('allow')) expect(JSON.parse(codec.noop('stop'))).toEqual(fixture.stdout);
  }
});
it('rejects malformed events and does not trust imaginary prompt fields', () => {
  for (const input of ['null', '[]', '{', '{"conversationId":"s"}', '{"conversationId":"s","khalaHookEvent":"PreInvocation","invocationNum":-1}']) expect(codec.parse(input)).toBeNull();
  expect(codec.parse('{"conversationId":"s","khalaHookEvent":"PreInvocation","invocationNum":0,"prompt":"fake"}')?.promptText).toBeUndefined();
});
