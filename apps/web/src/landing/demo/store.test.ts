import { describe, expect, it } from 'vitest';
import { AGENT_REPLIES, mentionedAgents, NUDGES, nudgeDue, pickLine, repliesFor } from './replies';
import { AGENTS, createDemo, MODE_CONFIRM_DELAY_MS, REPLY_DELAY_MS, VIEWER, WELCOME_CHANNEL } from './store';

/** A demo on a manual clock: `advance` runs every timer that is due. */
function harness(random: () => number = () => 0.5) {
  let clock = Date.parse('2026-10-05T17:00:00Z');
  let timers: { at: number; run: () => void; id: number }[] = [];
  let ids = 0;
  const demo = createDemo({
    random, now: () => new Date(clock),
    setTimer: (run, ms) => { const id = ++ids; timers.push({ at: clock + ms, run, id }); return id; },
    clearTimer: id => { timers = timers.filter(timer => timer.id !== id); },
  });
  const advance = (ms: number) => {
    clock += ms;
    const due = timers.filter(timer => timer.at <= clock).sort((a, b) => a.at - b.at);
    timers = timers.filter(timer => timer.at > clock);
    for (const timer of due) timer.run();
  };
  const messages = (channel = WELCOME_CHANNEL) => demo.timeline(channel).getSnapshot().items
    .map(item => ({ from: item.participant.participantId as string, body: item.content.kind === 'text' ? item.content.body : '' }));
  return { demo, advance, messages, pending: () => timers.length };
}

describe('splash demo replies', () => {
  it('an @mentioned agent replies after its listening-mode delay with a line from the list', () => {
    const { demo, advance, messages } = harness();
    const before = messages().length;
    demo.send(WELCOME_CHANNEL, 'txn-1', 'hey @Codex, what is Steer?');
    expect(messages().slice(before)).toEqual([{ from: VIEWER.participantId, body: 'hey @Codex, what is Steer?' }]);
    advance(REPLY_DELAY_MS.steer - 1);
    expect(messages()).toHaveLength(before + 1);
    advance(1);
    const reply = messages().at(-1)!;
    expect(reply.from).toBe(AGENTS.codex.participantId);
    expect(AGENT_REPLIES).toContain(reply.body);
  });

  it('a message without a mention gets no reply', () => {
    const { demo, advance, messages, pending } = harness();
    demo.send(WELCOME_CHANNEL, 'txn-1', 'hello everyone');
    const after = messages().length;
    expect(pending()).toBe(0);
    advance(10_000);
    expect(messages()).toHaveLength(after);
  });

  it('nudges only now and then when no agent is mentioned', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(nudgeDue)).toEqual([false, true, false, false, false, true, false]);
    const { demo, advance, messages } = harness();
    demo.send(WELCOME_CHANNEL, 'txn-1', 'one');
    demo.send(WELCOME_CHANNEL, 'txn-2', 'two');
    advance(10_000);
    expect(NUDGES).toContain(messages().at(-1)!.body);
  });

  it('never says the same line twice in a row', () => {
    // A random source stuck on one value would repeat without the guard.
    const { demo, advance, messages } = harness(() => 0);
    for (let index = 0; index < 6; index += 1) {
      demo.send(WELCOME_CHANNEL, `txn-${index}`, '@Scout again');
      advance(5_000);
    }
    const replies = messages().filter(message => message.from === AGENTS.scout.participantId).slice(-6).map(message => message.body);
    replies.slice(1).forEach((line, index) => expect(line).not.toBe(replies[index]));
    expect(pickLine(['a', 'b'], 'a', () => 0)).toBe('b');
  });

  it('every mentioned agent in the channel answers, and agents outside it do not', () => {
    expect(mentionedAgents('@Scout and @codex, also @Opus', [
      { participantId: 'a', label: 'Scout' }, { participantId: 'b', label: 'Codex' },
    ])).toEqual(['a', 'b']);
    const { demo, advance, messages } = harness();
    demo.send('local', 'txn-1', '@Codex are you here? @Opus?');
    advance(10_000);
    expect(messages('local').slice(-2).map(message => message.from)).toEqual([VIEWER.participantId, AGENTS.opus.participantId]);
  });

  it('keeps mode lines true to the agent', () => {
    expect(repliesFor('sync').some(line => line.startsWith('I’m on Async'))).toBe(false);
    expect(repliesFor('async').some(line => line.startsWith('I’m on Async'))).toBe(true);
    expect(repliesFor('steer').some(line => line.startsWith('set me to Steer'))).toBe(false);
  });
});

describe('splash demo state', () => {
  it('confirms a listening-mode change shortly after it is sent', async () => {
    const { demo, advance } = harness();
    expect(demo.modeFor(AGENTS.opus.participantId)).toBe('async');
    expect(await demo.setMode(AGENTS.opus.participantId, 'steer')).toBe('sent');
    advance(MODE_CONFIRM_DELAY_MS);
    expect(demo.modeFor(AGENTS.opus.participantId)).toBe('steer');
  });

  it('renames only the visitor’s agent, posts the pill, and the new name answers mentions', async () => {
    const { demo, advance, messages } = harness();
    expect(await demo.rename(AGENTS.codex.participantId, 'Atlas')).toEqual({ kind: 'error', code: 'not_owner' });
    expect(await demo.rename(AGENTS.opus.participantId, 'Scout')).toEqual({ kind: 'error', code: 'name_taken' });
    expect(await demo.rename(AGENTS.opus.participantId, 'Nova')).toEqual({ kind: 'ok', name: 'Nova' });
    const rows = demo.timeline(WELCOME_CHANNEL).getSnapshot().rows!;
    expect(rows.at(-1)).toMatchObject({ kind: 'channel_event', content: { summary: 'Opus is now Nova' } });
    expect(demo.describeParticipant(AGENTS.opus.participantId)).toMatchObject({ displayName: 'Nova' });
    demo.send(WELCOME_CHANNEL, 'txn-1', '@Nova hi');
    advance(10_000);
    expect(messages().at(-1)!.from).toBe(AGENTS.opus.participantId);
  });

  it('counts replies in a channel the visitor is not reading as unread', () => {
    const { demo, advance } = harness();
    demo.open(WELCOME_CHANNEL);
    demo.send('docs', 'txn-1', '@Scout status?');
    advance(10_000);
    expect(demo.summaries().find(summary => summary.id === 'docs')!.unreadCount).toBe(3);
    demo.open('docs');
    expect(demo.summaries().find(summary => summary.id === 'docs')!.unreadCount).toBeNull();
  });

  it('drops pending replies when disposed', () => {
    const { demo, pending } = harness();
    demo.send(WELCOME_CHANNEL, 'txn-1', '@Codex hi');
    expect(pending()).toBe(1);
    demo.dispose();
    expect(pending()).toBe(0);
  });
});
