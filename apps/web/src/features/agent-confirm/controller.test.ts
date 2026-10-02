import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentJoinView } from '@khala/contracts/m1/agent-join';
import { createAgentConfirmController } from './controller';
import type { AgentJoinPort, AgentJoinResult } from './ports';

const pending: AgentJoinView = { joinId: 'j1', label: 'Helper', harness: 'claude', channelName: 'Launch', roomId: '!r1:khala.local', state: 'pending' };
const confirmed: AgentJoinView = { ...pending, state: 'confirmed', agentUserId: '@agent-x:khala.local' };
const ready: AgentJoinView = { ...confirmed, state: 'ready' };
const ok = (view: AgentJoinView): AgentJoinResult => ({ kind: 'ok', view });
const flush = async () => { await vi.advanceTimersByTimeAsync(0); };
function fixture(view = pending, readyTimeoutMs = 60_000) {
  const port = { view: vi.fn<AgentJoinPort['view']>().mockResolvedValue(ok(view)),
    confirm: vi.fn<AgentJoinPort['confirm']>().mockResolvedValue(ok(confirmed)),
    status: vi.fn<AgentJoinPort['status']>().mockResolvedValue(ok(confirmed)) };
  const invite = vi.fn().mockResolvedValue(true);
  const controller = createAgentConfirmController({ joinId: 'j1', port, invite, readyTimeoutMs });
  return { port, invite, controller };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('agent confirmation controller', () => {
  it('confirms once, polls every second and invites once when ready (AE1 browser leg)', async () => {
    const { port, invite, controller } = fixture();
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
    expect(invite).toHaveBeenCalledExactlyOnceWith(pending.roomId, ready.agentUserId);
    expect(controller.getSnapshot()).toEqual({ state: 'done', view: ready });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(port.status).toHaveBeenCalledTimes(3);
    controller.dispose();
  });

  it('times out after 60 seconds and retries status without another confirmation', async () => {
    const { port, controller, invite } = fixture();
    controller.start(); await flush(); await controller.confirm();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(controller.getSnapshot()).toMatchObject({ state: 'error', code: 'ready_timeout' });
    port.status.mockResolvedValue(ok(ready));
    controller.retry(); controller.retry(); await vi.advanceTimersByTimeAsync(1000);
    expect(port.confirm).toHaveBeenCalledTimes(1);
    expect(invite).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().state).toBe('done');
    controller.dispose();
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

  it('invites a ready request immediately and retries only failed invites', async () => {
    const { port, controller, invite } = fixture(ready);
    invite.mockResolvedValueOnce(false).mockResolvedValue(true);
    controller.start(); await flush();
    expect(controller.getSnapshot()).toMatchObject({ state: 'error', code: 'invite_failed' });
    controller.retry(); controller.retry(); await flush();
    expect(controller.getSnapshot().state).toBe('done');
    expect(invite).toHaveBeenCalledTimes(2);
    expect(port.status).not.toHaveBeenCalled();
    expect(port.confirm).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('re-polls after a lost confirmation response without posting again', async () => {
    const { port, controller } = fixture();
    port.confirm.mockRejectedValue(new Error('response lost'));
    port.status.mockResolvedValue(ok(ready));
    controller.start(); await flush(); await controller.confirm();
    expect(controller.getSnapshot()).toMatchObject({ state: 'error', code: 'unavailable' });
    controller.retry(); await vi.advanceTimersByTimeAsync(1000);
    expect(controller.getSnapshot().state).toBe('done');
    expect(port.confirm).toHaveBeenCalledTimes(1);
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
    expect(controller.getSnapshot()).toMatchObject({ state: 'error', code: 'ready_timeout' });
    controller.dispose();
  });

  it('disposes a pending status read, ignoring late ready results and notifications', async () => {
    const { port, controller, invite } = fixture(confirmed);
    let resolve!: (result: AgentJoinResult) => void;
    port.status.mockImplementation(() => new Promise(done => { resolve = done; }));
    const listener = vi.fn(); controller.subscribe(listener);
    controller.start(); await flush(); await vi.advanceTimersByTimeAsync(1000);
    controller.dispose(); const notifications = listener.mock.calls.length;
    resolve(ok(ready)); await flush(); await vi.advanceTimersByTimeAsync(60_000);
    expect(port.status.mock.calls[0]?.[1]?.aborted).toBe(true);
    expect(invite).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(notifications);
    expect(port.status).toHaveBeenCalledTimes(1);
  });

  it('ignores a late initial view after disposal', async () => {
    const { port, controller, invite } = fixture();
    let resolve!: (result: AgentJoinResult) => void;
    port.view.mockImplementation(() => new Promise(done => { resolve = done; }));
    controller.start(); controller.dispose(); resolve(ok(ready)); await flush();
    expect(controller.getSnapshot().state).toBe('loading');
    expect(invite).not.toHaveBeenCalled();
  });

  it('rejects ready views without an agent identity', async () => {
    const { controller, invite } = fixture({ ...pending, state: 'ready' });
    controller.start(); await flush();
    expect(controller.getSnapshot()).toMatchObject({ state: 'error', code: 'unavailable' });
    expect(invite).not.toHaveBeenCalled(); controller.dispose();
  });
});
