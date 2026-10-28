import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentJoinView } from '@khala/contracts/m1/agent-join';
import { createAgentConfirmController } from './controller';
import type { AgentJoinPort, AgentJoinResult } from './ports';

const pending: AgentJoinView = { joinId: 'j1', label: 'Helper', harness: 'claude', channelName: 'Launch', roomId: '!r1:khala.local', state: 'pending' };
const confirmed: AgentJoinView = { ...pending, state: 'confirmed', agentUserId: '@agent-x:khala.local' };
const ready: AgentJoinView = { ...confirmed, state: 'ready' };
const ok = (view: AgentJoinView): AgentJoinResult => ({ kind: 'ok', view });
const flush = async () => { await vi.advanceTimersByTimeAsync(0); };
function fixture(view = pending, readyTimeoutMs = 180_000) {
  const port = { view: vi.fn<AgentJoinPort['view']>().mockResolvedValue(ok(view)),
    confirm: vi.fn<AgentJoinPort['confirm']>().mockResolvedValue(ok(confirmed)),
    status: vi.fn<AgentJoinPort['status']>().mockResolvedValue(ok(confirmed)) };
  const controller = createAgentConfirmController({ joinId: 'j1', port, readyTimeoutMs });
  return { port, controller };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('agent confirmation controller', () => {
  it('confirms once, polls every second and finishes when ready, with no browser invite (AE1 browser leg)', async () => {
    const { port, controller } = fixture();
    controller.start(); controller.start(); await flush();
    expect(controller.getSnapshot()).toEqual({ state: 'review', view: pending });
    port.status.mockResolvedValueOnce(ok(confirmed)).mockResolvedValueOnce(ok(confirmed)).mockResolvedValue(ok(ready));
    await Promise.all([controller.confirm(), controller.confirm()]);
    expect(port.confirm).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().state).toBe('connecting');
    await vi.advanceTimersByTimeAsync(999);
    expect(port.status).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2001);
    expect(port.status).toHaveBeenCalledTimes(3);
    expect(controller.getSnapshot()).toEqual({ state: 'done', view: ready });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(port.status).toHaveBeenCalledTimes(3);
    controller.dispose();
  });

  it('names the stage, flags a slow join, keeps polling past the agent\'s own retries and joins without a click', async () => {
    const { port, controller } = fixture(pending, 180_000);
    controller.start(); await flush(); await controller.confirm();
    expect(controller.getSnapshot()).toEqual({ state: 'connecting', view: confirmed });
    port.status.mockResolvedValue(ok({ ...confirmed, state: 'claimed' }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(controller.getSnapshot()).toEqual({ state: 'connecting', view: { ...confirmed, state: 'claimed' } });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(controller.getSnapshot()).toMatchObject({ state: 'connecting', slow: true });
    port.status.mockResolvedValue(ok(ready));
    await vi.advanceTimersByTimeAsync(100_000);
    expect(controller.getSnapshot()).toEqual({ state: 'done', view: ready });
    expect(port.confirm).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('gives up after the deadline with a cause per stage, and offers no blind retry', async () => {
    for (const [state, code] of [['confirmed', 'not_picked_up'], ['claimed', 'not_finished']] as const) {
      const { port, controller } = fixture({ ...confirmed, state });
      port.status.mockResolvedValue(ok({ ...confirmed, state }));
      controller.start(); await flush(); await vi.advanceTimersByTimeAsync(180_000);
      expect(controller.getSnapshot()).toMatchObject({ state: 'error', code });
      const calls = port.status.mock.calls.length;
      controller.retry(); await vi.advanceTimersByTimeAsync(5000);
      expect(port.status).toHaveBeenCalledTimes(calls);
      controller.dispose();
    }
  });

  it('confirms with no click when Approve joins is off and the viewer issued the link, and waits for a click otherwise', async () => {
    const auto = fixture({ ...pending, access: 'auto' });
    auto.controller.start(); await flush();
    // The page names the agent with a Cancel window first.
    expect(auto.controller.getSnapshot()).toEqual({ state: 'review', view: { ...pending, access: 'auto' } });
    await vi.advanceTimersByTimeAsync(2999);
    expect(auto.port.confirm).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(auto.port.confirm).toHaveBeenCalledTimes(1);
    expect(auto.controller.getSnapshot().state).toBe('connecting');
    auto.controller.dispose();
    // Cancel turns it back into an ordinary click-to-confirm page.
    const cancelled = fixture({ ...pending, access: 'auto' });
    cancelled.controller.start(); await flush();
    cancelled.controller.cancelAuto();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(cancelled.port.confirm).not.toHaveBeenCalled();
    expect(cancelled.controller.getSnapshot()).toEqual({ state: 'review', view: pending });
    await cancelled.controller.confirm();
    expect(cancelled.port.confirm).toHaveBeenCalledTimes(1);
    cancelled.controller.dispose();
    // Approval on (no hint), and a non-member who must join: the page waits for Confirm.
    for (const view of [pending, { ...pending, access: 'join' as const }]) {
      const manual = fixture(view);
      manual.controller.start(); await flush();
      expect(manual.port.confirm).not.toHaveBeenCalled();
      expect(manual.controller.getSnapshot()).toEqual({ state: 'review', view });
      manual.controller.dispose();
    }
  });

  it('does not confirm a forbidden request', async () => {
    const { port, controller } = fixture();
    port.view.mockResolvedValue({ kind: 'error', code: 'not_member' });
    controller.start(); await flush(); await controller.confirm();
    expect(controller.getSnapshot()).toEqual({ state: 'error', code: 'not_member' });
    expect(port.confirm).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('resumes polling after a confirmed page reload without posting', async () => {
    const { port, controller } = fixture(confirmed);
    port.status.mockResolvedValue(ok(ready));
    controller.start(); await flush();
    expect(controller.getSnapshot().state).toBe('connecting');
    await vi.advanceTimersByTimeAsync(1000);
    expect(controller.getSnapshot().state).toBe('done');
    expect(port.confirm).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('stops polling when the request expires', async () => {
    const { port, controller } = fixture(confirmed);
    port.status.mockResolvedValue(ok({ ...confirmed, state: 'expired' }));
    controller.start(); await flush(); await vi.advanceTimersByTimeAsync(5000);
    expect(controller.getSnapshot()).toMatchObject({ state: 'error', code: 'expired' });
    expect(port.status).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('shows a ready request as done immediately: the server already invited the agent', async () => {
    const { port, controller } = fixture(ready);
    controller.start(); await flush();
    expect(controller.getSnapshot()).toEqual({ state: 'done', view: ready });
    expect(port.status).not.toHaveBeenCalled();
    expect(port.confirm).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('retry rereads the join: a confirm that landed resumes polling without posting again', async () => {
    const { port, controller } = fixture();
    port.confirm.mockRejectedValue(new Error('response lost'));
    port.status.mockResolvedValue(ok(ready));
    controller.start(); await flush(); await controller.confirm();
    expect(controller.getSnapshot()).toMatchObject({ state: 'error', code: 'unavailable' });
    port.view.mockResolvedValue(ok(confirmed));
    controller.retry(); await vi.advanceTimersByTimeAsync(1000);
    expect(controller.getSnapshot().state).toBe('done');
    expect(port.confirm).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('retry after a confirm that never landed offers Confirm again', async () => {
    const { port, controller } = fixture();
    port.confirm.mockRejectedValueOnce(new Error('offline'));
    controller.start(); await flush(); await controller.confirm();
    controller.retry(); await flush();
    expect(controller.getSnapshot()).toEqual({ state: 'review', view: pending });
    await controller.confirm();
    expect(port.confirm).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot()).toEqual({ state: 'connecting', view: confirmed });
    controller.dispose();
  });

  it('does not retry a signed-out error: the page signs in instead', async () => {
    const { port, controller } = fixture();
    port.view.mockResolvedValue({ kind: 'error', code: 'signed_out' });
    controller.start(); await flush(); controller.retry(); await flush();
    expect(port.view).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('retries an unavailable initial view and renders expired views as errors', async () => {
    const { port, controller } = fixture();
    port.view.mockResolvedValueOnce({ kind: 'error', code: 'unavailable' }).mockResolvedValue(ok({ ...pending, state: 'expired' }));
    controller.start(); await flush(); controller.retry(); await flush();
    expect(controller.getSnapshot()).toMatchObject({ state: 'error', code: 'expired' });
    expect(port.view).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it('does not overlap slow status requests and bounds them by the deadline', async () => {
    const { port, controller } = fixture(confirmed, 3000);
    port.status.mockImplementation(() => new Promise(() => undefined));
    controller.start(); await flush(); await vi.advanceTimersByTimeAsync(3000);
    expect(port.status).toHaveBeenCalledTimes(1);
    expect(port.status.mock.calls[0]?.[1]?.aborted).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ state: 'error', code: 'not_picked_up' });
    controller.dispose();
  });

  it('disposes a pending status read, ignoring late ready results and notifications', async () => {
    const { port, controller } = fixture(confirmed);
    let resolve!: (result: AgentJoinResult) => void;
    port.status.mockImplementation(() => new Promise(done => { resolve = done; }));
    const listener = vi.fn(); controller.subscribe(listener);
    controller.start(); await flush(); await vi.advanceTimersByTimeAsync(1000);
    controller.dispose(); const notifications = listener.mock.calls.length;
    resolve(ok(ready)); await flush(); await vi.advanceTimersByTimeAsync(60_000);
    expect(port.status.mock.calls[0]?.[1]?.aborted).toBe(true);
    expect(listener).toHaveBeenCalledTimes(notifications);
    expect(port.status).toHaveBeenCalledTimes(1);
  });

  it('ignores a late initial view after disposal', async () => {
    const { port, controller } = fixture();
    let resolve!: (result: AgentJoinResult) => void;
    port.view.mockImplementation(() => new Promise(done => { resolve = done; }));
    controller.start(); controller.dispose(); resolve(ok(ready)); await flush();
    expect(controller.getSnapshot().state).toBe('loading');
  });
});
