import type { MakeExternalAction, MakeExternalJourneyView } from '@khala/contracts/messaging/make-external';
import { describe, expect, it } from 'vitest';
import { createMakeExternalController } from './controller';
import { baseView, conversionView, signedIn } from './fixtures/views';
import type { MakeExternalPort, MakeExternalRead, MakeExternalWrite } from './port';

class FakePort implements MakeExternalPort {
  readonly actions: MakeExternalAction[] = [];
  current: MakeExternalJourneyView = baseView;
  next: Array<MakeExternalWrite | ((action: MakeExternalAction) => MakeExternalWrite)> = [];
  views = 0;
  async view(): Promise<MakeExternalRead> {
    this.views += 1;
    return { kind: 'ok', view: this.current };
  }
  async act(_channelId: string, action: MakeExternalAction): Promise<MakeExternalWrite> {
    this.actions.push(action);
    const queued = this.next.shift();
    if (typeof queued === 'function') return queued(action);
    return queued ?? { kind: 'ok', view: this.current, rejection: null };
  }
}

function setup(port = new FakePort()) {
  const timers: Array<() => void> = [];
  let id = 0;
  const controller = createMakeExternalController(port, 'internal-planning', {
    createId: () => `op-${++id}`, setTimer: run => timers.push(run), clearTimer: () => timers.splice(0),
  });
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  return { port, controller, timers, settle };
}

describe('make-external controller', () => {
  it('loads the journey and announces its step', async () => {
    const { controller, settle } = setup();
    controller.start();
    await settle();
    expect(controller.getState()).toMatchObject({ phase: 'ready', announcement: 'Make external. Nothing changes until you confirm.' });
  });

  it('resends an action whose outcome is unknown with the same operation ID', async () => {
    const { port, controller, settle } = setup();
    port.current = signedIn();
    controller.start();
    await settle();
    port.next.push({ kind: 'outcome_unknown' });
    await controller.act({ kind: 'start', historyMode: 'start_fresh', visibility: 'secret', agents: [] });
    expect(controller.getState()).toMatchObject({ retryable: true, busy: null });
    port.next.push({ kind: 'ok', view: conversionView(), rejection: null });
    await controller.retry();
    expect(port.actions.map(action => action.operationId)).toEqual(['op-1', 'op-1']);
    expect(controller.getState()).toMatchObject({ retryable: false, error: null });
  });

  it('shows a refusal with the resulting view', async () => {
    const { port, controller, settle } = setup();
    controller.start();
    await settle();
    port.next.push({ kind: 'ok', view: conversionView(), rejection: 'not_ready' });
    await controller.act({ kind: 'commit' });
    expect(controller.getState().error).toBe('Every agent must be ready or skipped before you switch.');
  });

  it('keeps asking the server to continue only while a step advances on its own', async () => {
    const { port, controller, timers, settle } = setup();
    port.current = conversionView({ state: 'history_copying' });
    controller.start();
    await settle();
    expect(timers).toHaveLength(1);
    port.current = conversionView({ state: 'drain_required' });
    timers.shift()!();
    await settle();
    expect(port.actions.at(-1)?.kind).toBe('resume');
    expect(controller.getState().announcement).toMatch(/History is still changing/);
    expect(timers).toHaveLength(0);
  });

  it('polls the view, never an action, while sign-in is pending', async () => {
    const { port, controller, timers, settle } = setup();
    port.current = { ...baseView, signIn: { status: 'pending', verificationUrl: 'https://khala.test/s', failure: null } };
    controller.start();
    await settle();
    port.current = signedIn();
    timers.shift()!();
    await settle();
    expect(port.actions).toEqual([]);
    expect(port.views).toBe(2);
    expect(controller.getState().announcement).toBe('Signed in. Choose history, visibility and agents.');
  });

  it('ignores a second action while one is in flight', async () => {
    const { port, controller, settle } = setup();
    controller.start();
    await settle();
    const first = controller.act({ kind: 'sign_in' });
    await controller.act({ kind: 'sign_in' });
    await first;
    expect(port.actions).toHaveLength(1);
  });
});
