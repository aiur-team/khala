import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clockLabel, dayLabel } from '../khala/format-time';
import { participantHue } from '../khala/identity';
import {
  AGENTS, CHANNELS, conversationSummary, failedSends, FIXTURE_NOW, FIXTURE_TIME, HUMANS, productText, timelineData,
} from './fixture-data';

type DesignMessage = { day?: string; from?: string; event?: string; t: string; text?: string; failed?: boolean };
type DesignConvo = { id: string; title: string; unread?: number; state?: string; members: string[]; msgs: DesignMessage[] };

/** `KH_CONVOS` from the design source, evaluated as the literal it is. */
function designConvos(): DesignConvo[] {
  const source = readFileSync(join(import.meta.dirname, '../../../../../docs/design/khala-chat/source/Aiur Dashboard.html'), 'utf8');
  const start = source.indexOf('const KH_CONVOS = [');
  const end = source.indexOf('\n  ];', start);
  return new Function(`return ${source.slice(start + 'const KH_CONVOS = '.length, end + 4)}`)() as DesignConvo[];
}

const design = designConvos();
const live = design.filter(convo => !convo.state);
const release = CHANNELS.find(channel => channel.id === 'release')!;

describe('the conversation fixture dataset', () => {
  it('has the design’s six live channels in order and omits the state channels', () => {
    expect(CHANNELS.map(channel => [channel.id, channel.title, channel.unread]))
      .toEqual(live.map(convo => [convo.id, convo.title, convo.unread ?? null]));
    expect(CHANNELS).toHaveLength(6);
    expect(CHANNELS.map(channel => channel.id)).not.toContain('infra');
  });

  it('puts 3 humans and 6 agents in "release", in member order', () => {
    expect(release.members).toEqual(live[0]!.members);
    expect(release.members.filter(key => key in HUMANS)).toHaveLength(3);
    expect(release.members.filter(key => key in AGENTS)).toHaveLength(6);
    expect(release.entries).toHaveLength(15);
  });

  it('gives every agent a harness, an `#num` idBadge and a `<Short> · <Owner>` name', () => {
    for (const [id, agent] of Object.entries(AGENTS)) {
      expect(['claude', 'codex']).toContain(agent.harness);
      expect(agent.idBadge).toBe(`#${id.slice('AIUR-'.length)}`);
      expect(agent.displayName).toMatch(/^(Opus|Sonnet|Codex) · (Kevin|Maya|Kai)$/u);
    }
  });

  it('copies every message, event and day marker verbatim from the design', () => {
    for (const [index, channel] of CHANNELS.entries()) {
      const msgs = live[index]!.msgs;
      expect(channel.entries).toHaveLength(msgs.length);
      channel.entries.forEach((entry, at) => {
        const original = msgs[at]!;
        if (entry.kind === 'day') {
          expect(entry.label).toBe(original.day);
          expect(dayLabel(new Date(entry.at), FIXTURE_NOW, FIXTURE_TIME)).toBe(original.day);
        } else if (entry.kind === 'message') {
          expect([entry.from, entry.text, entry.failed ?? false]).toEqual([original.from, original.text, original.failed ?? false]);
          expect(clockLabel(new Date(entry.at), FIXTURE_TIME)).toBe(original.t);
        } else {
          expect(timelineData(channel).rows!.find(row => row.kind === 'channel_event' && row.receivedAt === entry.at))
            .toMatchObject({ content: { body: original.event } });
          expect(entry.ref).toBe((original as { ref?: string }).ref);
        }
      });
    }
  });

  it('rewrites only `<code>` and the design’s mention references', () => {
    expect(productText('Nav shell: protected routes gated on <code>useSession()</code>. Waiting on @530.'))
      .toBe('Nav shell: protected routes gated on `useSession()`. Waiting on @Sonnet.');
    expect(productText("@kai I'll review @395 now so @530 isn't blocked.")).toBe("@Kai I'll review @Opus now so @Sonnet isn't blocked.");
    expect(productText('Got it @maya. Badge plus a sunset date.')).toBe('Got it @Maya. Badge plus a sunset date.');
    const bodies = CHANNELS.flatMap(channel => channel.entries.flatMap(entry => entry.kind === 'message' ? [productText(entry.text)] : []));
    for (const body of bodies) expect(body).not.toMatch(/<\/?code>|@\d|@(kai|maya|you)\b/u);
  });

  it('keeps the failed "release" send out of the history until `?failed=1`', () => {
    const data = timelineData(release);
    expect(data.items).toHaveLength(12);
    expect(data.rows).toHaveLength(13);
    expect(data.items.at(-1)!.content).toMatchObject({ body: 'Pushing both fixes now. @Kai screenshots attached to the PR.' });
    expect(failedSends(release)).toEqual([expect.objectContaining({ phase: 'failed',
      content: expect.objectContaining({ body: '@Codex ping here when the search index is built.' }) })]);
    expect(conversationSummary(release)).toMatchObject({ unreadCount: 3, lastSender: { label: 'Sonnet', isViewer: false },
      timestamp: '2026-10-02T10:11:00Z' });
  });

  it('chooses ids whose product hash hue is already the design hue', () => {
    expect(participantHue({ kind: 'human', ownerId: HUMANS.me.ownerId, isViewer: true })).toBe(HUMANS.me.hue);
    for (const human of [HUMANS.maya, HUMANS.kai]) expect(participantHue({ kind: 'human', ownerId: human.ownerId })).toBe(human.hue);
    for (const agent of Object.values(AGENTS)) expect(participantHue({ kind: 'agent', participantId: agent.participantId })).toBe(agent.hue);
  });
});
