import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createHttpListeningPort } from '../composition/listening-http';
import { ListeningControl } from './ListeningControl';
import { createListeningController } from './listening-controller';
import { experimentalClaudeEntry, provenCodexEntry, unprovenClaudeEntry } from './listening-fixtures';
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

  it('decodes the evidence a grant pins, and only this binding generation\'s experimental-route grants', () => {
    const entry = experimentalClaudeEntry({ granted: true });
    const foreign = { ...entry.view.experimentalGrants[0]!, generation: 2 };
    const hardCancel = { ...entry.view.experimentalGrants[0]!, kind: 'hard_cancel' };
    const [cy] = decodeBindingList({ v: 1, bindings: [{ ...entry, view: { ...entry.view, experimentalGrants: [...entry.view.experimentalGrants, foreign, hardCancel] } }] })!;
    expect(cy!.support.steer).toEqual({
      status: 'experimental', reason: 'Claude Code 2.1.283 has not been proven on this route.', route: 'claude-interactive-hooks',
      testedVersion: '2.1.283', evidenceRef: 'experiments/internal-mode/read-receipts/claude/evidence.json', evidenceRevision: 'interactive-claude-2026-09-25',
    });
    expect(cy!.experimentalGrants).toEqual([{ mode: 'steer', route: 'claude-interactive-hooks', harnessVersion: '2.1.283', evidenceRevision: 'interactive-claude-2026-09-25' }]);
    const malformed = { ...entry, view: { ...entry.view, experimentalGrants: [{ mode: 'steer' }] } };
    expect(decodeBindingList({ v: 1, bindings: [malformed] })).toBeNull();
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

  it('grants and revokes the exact experimental route the owner reviewed', async () => {
    const fetch = vi.fn(async () => json({ v: 1, outcome: 'applied', reason: null, view: {} }));
    const port = createHttpListeningPort({
      origin: ORIGIN, requestSecret: 'secret', fetch, newCommandId: () => 'cmd-g', now: () => new Date('2026-09-26T00:00:00.000Z'),
    });
    const [cy] = decodeBindingList({ v: 1, bindings: [experimentalClaudeEntry()] })!;
    const route = { mode: 'steer', route: 'claude-interactive-hooks', harnessVersion: '2.1.283', evidenceRevision: 'interactive-claude-2026-09-25' } as const;
    expect(await port.changeExperimentalRoute('ch_1', cy!, 'grant', route)).toEqual({ kind: 'done' });
    expect(fetch).toHaveBeenLastCalledWith(`${ORIGIN}/api/v1/channels/ch_1/bindings/binding-cy/experimental-route/grant`, expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ v: 1, commandId: 'cmd-g', generation: 1, expectedVersion: 2, ...route, issuedAt: '2026-09-26T00:00:00.000Z' }),
      headers: expect.objectContaining({ 'x-khala-request-secret': 'secret' }),
    }));
    await port.changeExperimentalRoute('ch_1', cy!, 'revoke', route);
    expect(fetch).toHaveBeenLastCalledWith(`${ORIGIN}/api/v1/channels/ch_1/bindings/binding-cy/experimental-route/revoke`, expect.anything());
    const refused = createHttpListeningPort({ origin: ORIGIN, requestSecret: 's', fetch: async () => json({ v: 1, outcome: 'refused', reason: 'capability_mismatch' }) });
    expect(await refused.changeExperimentalRoute('ch_1', cy!, 'grant', route)).toEqual({ kind: 'failed', reason: 'forbidden' });
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
      async changeExperimentalRoute(_channel, binding, action, route) {
        calls.push(`${action}:${binding.bindingId}:v${binding.version}:${route.mode}:${route.route}@${route.harnessVersion}#${route.evidenceRevision}`);
        list = [experimentalClaudeEntry({ granted: action === 'grant', version: binding.version + 1 })];
        return { kind: 'done' };
      },
    };
  }

  it('grants an experimental route only after the owner confirms its exact evidence, and revokes it', async () => {
    const port = fakePort([experimentalClaudeEntry()]);
    const controller = createListeningController(port, 'ch_1');
    await controller.refresh();
    const before = renderToStaticMarkup(<ListeningControl controller={controller} />);
    expect(before).toContain('Not in effect: this mode needs an experimental grant.');
    expect(before.match(/>Enable experimental route</g)).toHaveLength(3);
    expect(before).not.toContain('Revoke experimental route');

    controller.requestGrant('binding-cy', 'steer');
    expect(port.calls).toEqual([]);
    const reviewing = renderToStaticMarkup(<ListeningControl controller={controller} />);
    // The hosted panel's confirmation wording and evidence lines.
    expect(reviewing).toContain('Enable experimental steer route on Cy?');
    expect(reviewing).toContain('<li>Route: claude-interactive-hooks</li>');
    expect(reviewing).toContain('<li>Tested version: 2.1.283</li>');
    expect(reviewing).toContain('<li>Evidence revision: interactive-claude-2026-09-25</li>');
    expect(reviewing).toContain('Missing proof: Claude Code 2.1.283 has not been proven on this route.');
    expect(reviewing).toContain('Enabling this experimental route lets you select it for this binding only.');
    controller.cancelGrant();
    expect(controller.getView().confirmation).toBeNull();
    expect(port.calls).toEqual([]);

    controller.requestGrant('binding-cy', 'steer');
    await controller.confirmGrant();
    expect(port.calls).toEqual(['grant:binding-cy:v2:steer:claude-interactive-hooks@2.1.283#interactive-claude-2026-09-25']);
    expect(controller.getView()).toMatchObject({ confirmation: null, notice: 'Experimental route for Steer on Cy granted.' });
    const granted = renderToStaticMarkup(<ListeningControl controller={controller} />);
    expect(granted).toContain('In effect: Steer.');
    expect(granted).toContain('Revoke experimental route');

    await controller.revokeGrant('binding-cy', 'steer');
    expect(port.calls[1]).toBe('revoke:binding-cy:v3:steer:claude-interactive-hooks@2.1.283#interactive-claude-2026-09-25');
    expect(controller.getView().notice).toBe('Experimental route for Steer on Cy revoked.');
    expect(controller.getView().bindings[0]).toMatchObject({ effective: null, experimentalGrants: [] });
  });

  it('closes a confirmation whose evidence changed while the owner reviewed it, and never offers a proven route', async () => {
    let entry = experimentalClaudeEntry();
    const port = { ...fakePort([]), list: async () => ({ kind: 'listed' as const, bindings: decodeBindingList({ v: 1, bindings: [entry] })! }) };
    const controller = createListeningController(port, 'ch_1');
    await controller.refresh();
    controller.requestGrant('binding-cy', 'steer');
    entry = experimentalClaudeEntry({ evidenceRevision: 'interactive-claude-2026-10-01' });
    await controller.refresh();
    expect(controller.getView()).toMatchObject({
      confirmation: null,
      notice: 'The evidence for Cy changed while you were reviewing it. Review the updated evidence before confirming.',
    });
    await controller.confirmGrant();
    expect(port.calls).toEqual([]);

    // A grant pinned to older evidence is stale: steer is not in effect, and the owner reviews again or revokes it.
    entry = experimentalClaudeEntry({ granted: true, evidenceRevision: 'interactive-claude-2026-10-01' });
    await controller.refresh();
    const stale = renderToStaticMarkup(<ListeningControl controller={controller} />);
    expect(stale).toContain('Not in effect: this mode needs an experimental grant.');
    expect(stale).toContain('Review updated evidence');
    expect(stale).toContain('Revoke experimental route');

    const proven = createListeningController(fakePort([provenCodexEntry()]), 'ch_1');
    await proven.refresh();
    proven.requestGrant('binding-ada', 'steer');
    expect(proven.getView().confirmation).toBeNull();
    expect(renderToStaticMarkup(<ListeningControl controller={proven} />)).not.toContain('experimental route');
  });

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
