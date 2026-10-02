import { describe, expect, it } from 'vitest';
import { segmentMentions, type MentionCandidate } from './mentions';

const opus: MentionCandidate = { label: 'Opus', participantId: 'p-opus', kind: 'agent', hue: 150 };
const kai: MentionCandidate = { label: 'Kai', participantId: 'p-kai', kind: 'human', hue: 150 };
const kaiBot: MentionCandidate = { label: 'Kai Bot', participantId: 'p-kai-bot', kind: 'agent', hue: 210 };

describe('segmentMentions', () => {
  it('splits a known mention from the text after it', () => {
    expect(segmentMentions('@Opus said', [opus])).toEqual([
      { mention: 'Opus', participantId: 'p-opus', kind: 'agent', hue: 150 },
      { text: ' said' },
    ]);
  });

  it('leaves an unknown mention as plain text', () => {
    expect(segmentMentions('@nobody here', [opus])).toEqual([{ text: '@nobody here' }]);
  });

  it('prefers the longest known label', () => {
    const roster = [kai, kaiBot];
    expect(segmentMentions('ping @Kai Bot now', roster)[1]).toMatchObject({ mention: 'Kai Bot', participantId: 'p-kai-bot' });
    expect(segmentMentions('ping @Kai Botany', roster)[1]).toMatchObject({ mention: 'Kai', participantId: 'p-kai' });
  });

  it('does not treat an email address as a mention', () => {
    expect(segmentMentions('mail@kai.dev', [kai])).toEqual([{ text: 'mail@kai.dev' }]);
  });

  it('matches case-insensitively at word boundaries only', () => {
    expect(segmentMentions('(@opus) and @Kaiser', [opus, kai])).toEqual([
      { text: '(' },
      { mention: 'Opus', participantId: 'p-opus', kind: 'agent', hue: 150 },
      { text: ') and @Kaiser' },
    ]);
  });

  it('stays under 2 ms per message across a 500-message thread', () => {
    const roster = Array.from({ length: 40 }, (_, index) => ({ ...opus, label: `Agent${index}`, participantId: `p${index}` }));
    const body = 'Status for @Agent7 and @Agent31: nothing blocking, see mail@example.dev. '.repeat(4);
    const started = performance.now();
    for (let index = 0; index < 500; index += 1) segmentMentions(body, roster);
    expect((performance.now() - started) / 500).toBeLessThan(2);
  });
});
