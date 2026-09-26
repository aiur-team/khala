import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createHttpListeningPort } from '../composition/listening-http';
import { ListeningControl } from './ListeningControl';
import { createListeningController } from './listening-controller';
import { provenCodexEntry, unprovenClaudeEntry } from './listening-fixtures';
import { type ListeningPort, decodeBindingList, modeOffered } from './listening-port';

const ORIGIN = 'http://127.0.0.1:4871';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('binding list decoding', () => {
  it('decodes the server list and offers only proven modes', () => {
    const [ada, bea] = decodeBindingList({ v: 1, bindings: [provenCodexEntry(), unprovenClaudeEntry()] })!;
    expect(ada).toMatchObject({ displayName: 'Ada', harness: 'codex', requested: 'sync', effective: 'sync', paused: false, version: 1 });
    expect(['steer', 'sync', 'async'].map(mode => modeOffered(ada!, mode as 'steer'))).toEqual([true, true, false]);
    expect(bea).toMatchObject({ requested: null, effective: null, effectiveReason: 'no_requested_mode', harnessVersion: null, lastChangedBy: { kind: 'unknown' } });
    const [changed] = decodeBindingList({ v: 1, bindings: [provenCodexEntry({ changedBy: 'agent', version: 2 })] })!;
    expect(changed).toMatchObject({ harnessVersion: '0.156.1', ownedByViewer: true, lastChangedBy: { kind: 'agent', participantId: 'participant-ada' } });
    expect(['steer', 'sync', 'async'].some(mode => modeOffered(bea!, mode as 'steer'))).toBe(false);
  });

  it('refuses the whole list when any entry is malformed', () => {
    const broken = { ...provenCodexEntry(), view: { ...provenCodexEntry().view, requested: 'loud' } };
    expect(decodeBindingList({ v: 1, bindings: [unprovenClaudeEntry(), broken] })).toBeNull();
    expect(decodeBindingList({ v: 2, bindings: [] })).toBeNull();
    const actorless = { ...provenCodexEntry(), view: { ...provenCodexEntry().view, lastChangedBy: { kind: 'robot' } } };
    expect(decodeBindingList({ v: 1, bindings: [actorless] })).toBeNull();
  });
});

describe('HTTP listening port', () => {
  it('sends the owner\'s exact version and generation with the request secret', async () => {
    const fetch = vi.fn(async () => json({ v: 1, outcome: 'applied', requested: 'steer', version: 2 }));
    const port = createHttpListeningPort({
      origin: ORIGIN, requestSecret: 'secret', fetch, newCommandId: () => 'cmd-1', now: () => new Date('2026-09-26T00:00:00.000Z'),
    });
    const [ada] = decodeBindingList({ v: 1, bindings: [provenCodexEntry()] })!;
    expect(await port.setMode('ch_1', ada!, 'steer')).toEqual({ kind: 'done' });
    expect(fetch).toHaveBeenCalledWith(`${ORIGIN}/api/v1/channels/ch_1/bindings/binding-ada/listening-mode`, expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      body: JSON.stringify({ v: 1, commandId: 'cmd-1', generation: 1, expectedVersion: 1, requested: 'steer', issuedAt: '2026-09-26T00:00:00.000Z' }),
      headers: expect.objectContaining({ 'x-khala-request-secret': 'secret' }),
    }));
  });

  it('maps every non-success to a failure and never to success', async () => {
    const [ada] = decodeBindingList({ v: 1, bindings: [provenCodexEntry()] })!;
    const port = (response: () => Promise<Response>) => createHttpListeningPort({ origin: ORIGIN, requestSecret: 's', fetch: response });
    expect(await port(async () => json({ v: 1, outcome: 'conflict' })).setMode('ch_1', ada!, 'steer')).toEqual({ kind: 'failed', reason: 'conflict' });
    expect(await port(async () => json({}, 401)).setPaused('ch_1', ada!, true)).toEqual({ kind: 'failed', reason: 'session_ended' });
    expect(await port(async () => json({}, 409)).setPaused('ch_1', ada!, true)).toEqual({ kind: 'failed', reason: 'conflict' });
    expect(await port(async () => json({ v: 1, paused: false })).setPaused('ch_1', ada!, true)).toEqual({ kind: 'failed', reason: 'outcome_unknown' });
    expect(await port(async () => { throw new TypeError('offline'); }).setPaused('ch_1', ada!, true))
      .toEqual({ kind: 'failed', reason: 'outcome_unknown' });
    expect(await port(async () => json({}, 503)).list('ch_1')).toEqual({ kind: 'failed', reason: 'unavailable' });
  });
});

describe('listening controller and control', () => {
  function fakePort(entries: unknown[]): ListeningPort & { calls: string[] } {
    let list = entries;
    const calls: string[] = [];
    return {
      calls,
      async list() { return { kind: 'listed', bindings: decodeBindingList({ v: 1, bindings: list })! }; },
      async setMode(_channel, binding, requested) {
        calls.push(`mode:${binding.bindingId}:${requested}`);
        list = [provenCodexEntry({ requested, version: binding.version + 1, changedBy: 'owner' }), ...list.slice(1)];
        return { kind: 'done' };
      },
      async setPaused(_channel, binding, paused) {
        calls.push(`pause:${binding.bindingId}:${paused}`);
        list = [provenCodexEntry({ paused }), ...list.slice(1)];
        return { kind: 'done' };
      },
    };
  }

  it('rereads after each change and announces it', async () => {
    const port = fakePort([provenCodexEntry(), unprovenClaudeEntry()]);
    const controller = createListeningController(port, 'ch_1');
    await controller.refresh();
    await controller.setMode('binding-ada', 'steer');
    expect(controller.getView()).toMatchObject({ busy: null, notice: 'Ada: Steer requested.' });
    expect(controller.getView().bindings[0]).toMatchObject({ requested: 'steer', version: 2 });
    await controller.setPaused('binding-ada', true);
    expect(controller.getView().notice).toBe('Delivery to Ada is paused. New messages wait until you resume.');
    expect(port.calls).toEqual(['mode:binding-ada:steer', 'pause:binding-ada:true']);
  });

  it('renders proven modes as choices and unproven ones disabled with the reason', async () => {
    const controller = createListeningController(fakePort([provenCodexEntry(), unprovenClaudeEntry({ paused: true })]), 'ch_1');
    await controller.refresh();
    const html = renderToStaticMarkup(<ListeningControl controller={controller} />);
    expect(html).toContain('In effect: Sync.');
    expect(html).toContain('Async (not proven for this agent)');
    expect(html).toContain('Awaiting a receipt proof');
    expect(html).toContain('Requested: none. Not in effect: no mode is proven');
    // Stated per agent while idle delivery is unproven, even when the harness's own claim omits it.
    expect(html.match(/<p class="listening-control__idle">Idle agents receive messages only at their next turn\.<\/p>/g)).toHaveLength(2);
    expect(html).toContain('Resume delivery to Bea');
    expect(html).toContain('Pause delivery to Ada');
    expect((html.match(/disabled=""/g) ?? []).length).toBe(4);
    // The hosted panel's agent label; no actor is recorded for either version yet.
    expect(html).toContain('Ada <span class="listening-control__harness">(Codex CLI 0.156.1 · ');
    expect(html).toContain('Bea <span class="listening-control__harness">(Claude Code version unknown · ');
    expect(html.match(/Last change: not recorded for v1/g)).toHaveLength(2);
  });

  it('says who made the last change, the owner or the agent itself', async () => {
    const render = async (changedBy: 'owner' | 'agent') => {
      const controller = createListeningController(fakePort([provenCodexEntry({ changedBy, version: 3 })]), 'ch_1');
      await controller.refresh();
      return renderToStaticMarkup(<ListeningControl controller={controller} />);
    };
    expect(await render('owner')).toContain('Last changed by you (owner) (v3)');
    expect(await render('agent')).toMatch(/Last changed by the agent \(Codex CLI 0\.156\.1 · [0-9a-z]+\) \(v3\)/);
  });
});
