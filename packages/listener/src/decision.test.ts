import { expect, it } from 'vitest';
import { decideDelivery, type DecisionInput } from './index';

const base: DecisionInput = { harness: 'claude', event: 'prompt', continuation: false,
  busy: true, busyAgeMs: 119_999, interruptedSinceBusy: false };

it('tool boundary delivers steer only', () => {
  expect(decideDelivery({ ...base, event: 'tool' })).toEqual({ deliverModes: ['steer'], markIdleOnly: false });
});
it('busy Claude prompts expire at 120 seconds and require a recorded busy turn without an interrupt', () => {
  expect(decideDelivery(base)).toEqual({ deliverModes: ['steer'], markIdleOnly: false });
  for (const override of [{ busyAgeMs: 120_000 }, { busyAgeMs: null }, { busy: false }, { interruptedSinceBusy: true }]) {
    expect(decideDelivery({ ...base, ...override })).toEqual({ deliverModes: ['steer', 'sync'], markIdleOnly: false });
  }
});
it('Codex prompts deliver steer and sync even while busy', () => {
  expect(decideDelivery({ ...base, harness: 'codex' })).toEqual({ deliverModes: ['steer', 'sync'], markIdleOnly: false });
});
it('stop continuation marks idle only, otherwise stop delivers steer and sync', () => {
  expect(decideDelivery({ ...base, event: 'stop', continuation: true })).toEqual({ deliverModes: [], markIdleOnly: true });
  expect(decideDelivery({ ...base, event: 'stop' })).toEqual({ deliverModes: ['steer', 'sync'], markIdleOnly: false });
});
it('start delivers nothing', () => {
  expect(decideDelivery({ ...base, event: 'start' })).toEqual({ deliverModes: [], markIdleOnly: false });
});
it('async is never delivered across hook states', () => {
  for (const harness of ['claude', 'codex', 'cursor', 'unknown'])
    for (const event of ['start', 'prompt', 'tool', 'stop'] as const)
      for (const continuation of [false, true])
        for (const busy of [false, true])
          for (const busyAgeMs of [null, 0, 119_999, 120_000, 120_001])
            for (const interruptedSinceBusy of [false, true]) {
              expect(decideDelivery({ harness, event, continuation, busy, busyAgeMs, interruptedSinceBusy }).deliverModes).not.toContain('async');
            }
});
