import type { SessionBinding } from '@khala/contracts/delivery/index';

export const RUNTIME_PREREQUISITES = [
  'storage',
  'device',
  'bootstrap',
  'subscription',
  'controls',
  'harness',
  'dispatch',
  'review',
  'recovery',
] as const;

export type RuntimePrerequisite = (typeof RUNTIME_PREREQUISITES)[number];
export type PrerequisiteState = 'ready' | 'blocked' | 'offline' | 'unsupported' | 'unknown';
export type RuntimePhase = 'starting' | 'ready' | 'degraded' | 'stopping' | 'stopped';

export type RuntimeStatus = Readonly<{
  binding: SessionBinding | null;
  phase: RuntimePhase;
  prerequisites: Readonly<Record<RuntimePrerequisite, PrerequisiteState>>;
  effectivePolicyVersion: number | null;
  errorCode: string | null;
}>;

export function initialPrerequisites(): Record<RuntimePrerequisite, PrerequisiteState> {
  return Object.fromEntries(RUNTIME_PREREQUISITES.map(key => [key, 'blocked'])) as Record<
    RuntimePrerequisite,
    PrerequisiteState
  >;
}

export function copyStatus(status: RuntimeStatus): RuntimeStatus {
  return Object.freeze({ ...status, prerequisites: Object.freeze({ ...status.prerequisites }) });
}
