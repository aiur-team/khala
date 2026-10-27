import type { ListeningMode } from './modes';

export type HookEvent = 'start' | 'prompt' | 'tool' | 'stop';
export type DecisionInput = Readonly<{
  harness: string;
  event: HookEvent;
  continuation: boolean;
  busy: boolean;
  busyAgeMs: number | null;
  interruptedSinceBusy: boolean;
}>;
export type Decision = Readonly<{ deliverModes: readonly ListeningMode[]; markIdleOnly: boolean }>;

export function decideDelivery(input: DecisionInput): Decision {
  if (input.event === 'start') return { deliverModes: [], markIdleOnly: false };
  if (input.event === 'stop' && input.continuation) return { deliverModes: [], markIdleOnly: true };
  const steerOnly = input.event === 'tool' || (input.event === 'prompt' && input.harness === 'claude'
    && input.busy && input.busyAgeMs !== null && input.busyAgeMs < 120_000 && !input.interruptedSinceBusy);
  return { deliverModes: steerOnly ? ['steer'] : ['steer', 'sync'], markIdleOnly: false };
}
