import { expect, it } from 'vitest';
import ready from '../../../contracts/fixtures/aiur-events/pr-ready-for-review.json';
import push from '../../../contracts/fixtures/aiur-events/system-branch-push.json';
import { resolveEventInput } from './emit';

const event = { kind: 'ci.failed', summary: 'CI failed: test', subject: { ticket: 'AIUR-395', branch: 'aiur/395-events-cursor' } };
it('encodes native input and replaces caller-supplied version and body', () => {
  expect(resolveEventInput({ event: { ...event, v: 99, body: 'untrusted' } })).toEqual({
    kind: 'send', content: { ...event, v: 1, body: 'AIUR-395 CI failed: test · aiur/395-events-cursor' },
  });
});
it('returns contract validation locations', () => {
  expect(resolveEventInput({ event: { ...event, url: 'javascript:alert(1)' } })).toEqual({ kind: 'invalid', path: 'url', code: 'invalid_value' });
});
it('skips unmapped Aiur records and maps the real review fixture with a prefix', () => {
  expect(resolveEventInput({ aiur: push })).toEqual({ kind: 'skipped' });
  expect(resolveEventInput({ aiur: ready, ticketPrefix: 'AIUR-' })).toMatchObject({ kind: 'send', content: {
    v: 1, body: 'AIUR-395 review requested · feat/events-cursor', key: 'pr:aiur-team/aiur:ready_for_review:412:3f9c2ab0d1',
  } });
  expect(resolveEventInput({ aiur: ready, ticketPrefix: '' })).toMatchObject({ kind: 'send', content: { subject: { ticket: '395' } } });
});
it.each([
  [null, ''], [[], ''], [new Date(), ''], [{}, ''], [{ event, aiur: ready }, ''],
  [{ event, extra: true }, 'extra'], [{ event: [] }, 'event'], [{ event: null }, 'event'],
  [{ event: new Date() }, 'event'], [{ aiur: 1 }, 'aiur'], [{ aiur: undefined }, 'aiur'],
  [{ event, ticketPrefix: null }, 'ticketPrefix'], [{ event, ticketPrefix: 'x'.repeat(17) }, 'ticketPrefix'],
])('rejects malformed arguments %j at %s', (args, path) => {
  expect(resolveEventInput(args)).toEqual({ kind: 'invalid', path, code: 'invalid_value' });
});
it('accepts a sixteen-character prefix', () => {
  expect(resolveEventInput({ aiur: ready, ticketPrefix: 'x'.repeat(16) })).toMatchObject({ kind: 'send' });
});
