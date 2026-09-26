import { describe, expect, it } from 'vitest';
import type { OperationResult, PairingDecisionRequest, PairingOwnerResult } from '@khala/contracts/messaging/index';
import { PAIRING_FIXTURE } from '../approval-decision/pairing-fixture';
import { createPairingApprovalController } from './controller';
import type { PairingApprovalPort } from './ports';

const B64 = (seed: string) => seed.padEnd(43, 'x').slice(0, 43);
const HANDLE = `pair_${B64('h')}`;
const NOW = Date.parse('2026-09-25T10:05:00Z');

function claimed(overrides: { generation?: number; fingerprint?: string; revision?: string; expiresAt?: string } = {}): PairingOwnerResult {
  const base = PAIRING_FIXTURE;
  return {
    ...base,
    requestHandle: HANDLE,
    expiresAt: overrides.expiresAt ?? base.expiresAt,
    revision: overrides.revision ?? '1',
    claim: {
      ...base.claim!,
      jkt: B64('jkt'),
      evidenceDigest: B64('ev'),
      fingerprint: overrides.fingerprint ?? B64('fp1'),
      generation: overrides.generation ?? 2,
    },
  };
}

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function fakePort(initial: PairingOwnerResult) {
  const state = { current: initial, decisions: [] as PairingDecisionRequest[], decideResults: [] as OperationResult<unknown, never>[] };
  const port: PairingApprovalPort = {
    inspect: async () => ({ kind: 'ok', value: state.current }),
    decide: async input => {
      state.decisions.push(input);
      const scripted = state.decideResults.shift();
      if (scripted) return scripted as OperationResult<unknown, never>;
      const claim = state.current.claim!;
      if (input.revision !== state.current.revision || input.claimFingerprint !== claim.fingerprint) return { kind: 'rejected', code: 'stale_claim' };
      state.current = {
        ...state.current,
        state: input.decision === 'approve' ? 'approved' : 'denied',
        decidedAt: '2026-09-25T10:06:00Z',
        revision: String(Number(state.current.revision) + 1),
      };
      return { kind: 'ok', value: state.current };
    },
  };
  return { state, port };
}

function start(initial = claimed(), now = () => NOW) {
  const fake = fakePort(initial);
  const timers: { fire: () => void }[] = [];
  const controller = createPairingApprovalController(fake.port, HANDLE, {
    now,
    createId: (() => { let n = 0; return () => `op_${++n}`; })(),
    setTimer: callback => { const timer = { fire: callback }; timers.push(timer); return timer; },
    clearTimer: () => {},
  });
  controller.start();
  return { ...fake, controller, timers };
}

describe('pairing approval controller', () => {
  it('approves only the displayed claim at its displayed revision', async () => {
    const { controller, state } = start();
    await settle();
    controller.decide('approve');
    await settle();
    expect(state.decisions).toEqual([expect.objectContaining({ decision: 'approve', claimFingerprint: B64('fp1'), revision: '1', operationId: 'op_1' })]);
    expect(controller.getView().status.kind).toBe('decided');
    expect(controller.getView().pairing?.state).toBe('approved');
  });

  it('denial is terminal and offers no further decision', async () => {
    const { controller, state } = start();
    await settle();
    controller.decide('deny');
    await settle();
    expect(controller.getView().pairing?.state).toBe('denied');
    controller.decide('approve');
    await settle();
    expect(state.decisions).toHaveLength(1);
  });

  it('a changed generation requires a new prompt and mints no grant', async () => {
    const { controller, state } = start();
    await settle();
    // The agent reconnects as a new generation while the owner is looking.
    state.current = claimed({ generation: 3, fingerprint: B64('fp2'), revision: '2' });
    controller.refresh();
    await settle();
    expect(controller.getView().status.kind).toBe('refreshed');
    expect(controller.getView().pairing?.claim?.generation).toBe(3);
    expect(state.decisions).toEqual([]);
    controller.decide('approve');
    await settle();
    expect(state.decisions).toEqual([expect.objectContaining({ claimFingerprint: B64('fp2'), revision: '2' })]);
  });

  it('a decision made against a claim that then changed is refused and reloads', async () => {
    const { controller, state } = start();
    await settle();
    // The server has moved on but this window has not refreshed yet.
    state.current = claimed({ generation: 3, fingerprint: B64('fp2'), revision: '2' });
    controller.decide('approve');
    await settle();
    expect(state.decisions[0]).toEqual(expect.objectContaining({ claimFingerprint: B64('fp1'), revision: '1' }));
    expect(state.current.state).toBe('claimed');
    const view = controller.getView();
    expect(view.status.kind).toBe('refreshed');
    expect(view.pairing?.claim?.fingerprint).toBe(B64('fp2'));
  });

  it('a lost response retries the same operation and never decides twice', async () => {
    const { controller, state } = start();
    await settle();
    state.decideResults.push({ kind: 'outcome_unknown', operationId: 'op_1' });
    controller.decide('approve');
    await settle();
    expect(controller.getView().status.kind).toBe('retryable');
    controller.retry();
    await settle();
    expect(state.decisions.map(d => d.operationId)).toEqual(['op_1', 'op_1']);
    expect(controller.getView().status.kind).toBe('decided');
  });

  it('expiry is terminal and sends nothing', async () => {
    let now = NOW;
    const { controller, state, timers } = start(claimed(), () => now);
    await settle();
    now = Date.parse('2026-09-25T10:10:01Z');
    timers.at(-1)!.fire();
    expect(controller.getView().status).toEqual({ kind: 'blocked', message: expect.stringContaining('expired') });
    controller.decide('approve');
    await settle();
    expect(state.decisions).toEqual([]);
  });

  it('refuses to send when the clock is past expiry even if the timer has not fired', async () => {
    let now = NOW;
    const { controller, state } = start(claimed(), () => now);
    await settle();
    now = Date.parse('2026-09-25T10:11:00Z');
    controller.decide('approve');
    await settle();
    expect(state.decisions).toEqual([]);
    expect(controller.getView().status.kind).toBe('blocked');
  });

  it('a reload shows the current server state, including a decision made elsewhere', async () => {
    const { controller, state } = start();
    await settle();
    state.current = { ...state.current, state: 'denied', decidedAt: '2026-09-25T10:06:00Z', revision: '2' };
    controller.refresh();
    await settle();
    expect(controller.getView().status.kind).toBe('decided');
    controller.decide('approve');
    await settle();
    expect(state.decisions).toEqual([]);
  });

  it('a forbidden decision removes authority', async () => {
    const { controller, state } = start();
    await settle();
    state.decideResults.push({ kind: 'rejected', code: 'forbidden' as never });
    controller.decide('approve');
    await settle();
    expect(controller.getView().readOnly).toBe(true);
    controller.decide('deny');
    await settle();
    expect(state.decisions).toHaveLength(1);
  });

  it('rejects a projection for another request', async () => {
    const other = { ...claimed(), requestHandle: `pair_${B64('z')}` };
    const { controller } = start(other);
    await settle();
    expect(controller.getView().phase).toBe('load_failed');
  });
});
