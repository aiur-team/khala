/**
 * Same-session acceptance for one delivered nonce. Pure so the AE2 negative
 * controls are testable without a live model: identity comes from native
 * thread/executor observations, never from generated text alone.
 */
export type Settings = {
  model: string | null;
  cwd: string | null;
  approvalPolicy: unknown;
  sandbox: unknown;
  reasoningEffort: unknown;
};
export type AcceptanceInput = {
  originalThreadId: string;
  /** Native executor that held the thread writer lock before delivery. */
  originalExecutorPid: number;
  /** Writer-lock holder when consumption was observed. */
  lockHolderPid: number | null;
  /** Executor process whose notification stream carried the consumption. */
  observedExecutorPid: number;
  observedThreadId: string | null;
  clientUserMessageId: string;
  /** Distinct native userMessage items carrying clientUserMessageId. */
  consumedMessageCount: number;
  replyText: string | null;
  nonce: string;
  priorMarker: string;
  /** The delivered text itself must not leak the marker it is asked to recall. */
  deliveredText: string;
  settingsBefore: Settings;
  settingsAfter: Settings;
};
export type Acceptance = { accepted: boolean; failures: readonly string[] };

export function sameSessionAcceptance(i: AcceptanceInput): Acceptance {
  const failures: string[] = [];
  if (i.observedThreadId !== i.originalThreadId) failures.push('thread_id_changed');
  if (i.observedExecutorPid !== i.originalExecutorPid) failures.push('executor_process_changed');
  if (i.lockHolderPid !== i.originalExecutorPid) failures.push('writer_lock_not_held_by_original_executor');
  if (i.consumedMessageCount === 0) failures.push('not_consumed');
  if (i.consumedMessageCount > 1) failures.push('consumed_more_than_once');
  if (i.deliveredText.includes(i.priorMarker)) failures.push('marker_leaked_in_delivery');
  if (!i.replyText?.includes(i.nonce)) failures.push('nonce_not_reported');
  if (!i.replyText?.includes(i.priorMarker)) failures.push('prior_context_not_reported');
  for (const key of ['model', 'cwd', 'approvalPolicy', 'sandbox', 'reasoningEffort'] as const) {
    if (JSON.stringify(i.settingsBefore[key]) !== JSON.stringify(i.settingsAfter[key])) failures.push(`setting_changed:${key}`);
  }
  return { accepted: failures.length === 0, failures };
}

/** Observed conditions a case needs before its delivery counts as idle or busy evidence. */
export type CaseConditions =
  | { kind: 'idle'; queueDrained: boolean; statusAtDelivery: string | null }
  | { kind: 'busy'; statusAtDelivery?: string | null; commandStartedAt: number | null; commandCompletedAt: number | null;
      commandExitCode: number | null; deliveredAt: number | null; consumedInBusyTurn: boolean };

/**
 * Same-session acceptance says nothing about whether the case exercised the state it
 * names. An idle case whose drain never converged, or a busy case whose controlled
 * command never ran, must not be reported as idle or busy evidence.
 */
export function caseConditionFailures(c: CaseConditions): string[] {
  const failures: string[] = [];
  if (c.kind === 'idle') {
    if (!c.queueDrained) failures.push('queue_not_drained_before_idle');
    if (c.statusAtDelivery !== 'idle') failures.push('not_idle_at_delivery');
    return failures;
  }
  if (c.statusAtDelivery !== undefined && c.statusAtDelivery !== 'active') failures.push('not_active_at_delivery');
  if (c.commandStartedAt === null) failures.push('controlled_command_not_started');
  if (c.commandCompletedAt === null || c.commandExitCode !== 0) failures.push('controlled_command_not_completed');
  if (c.deliveredAt === null || c.commandStartedAt === null || c.commandCompletedAt === null ||
      c.deliveredAt < c.commandStartedAt || c.deliveredAt > c.commandCompletedAt) failures.push('delivery_not_during_command');
  if (c.consumedInBusyTurn) failures.push('consumed_in_busy_turn');
  return failures;
}

export function withConditions(a: Acceptance, c: CaseConditions): Acceptance {
  const failures = [...a.failures, ...caseConditionFailures(c)];
  return { accepted: failures.length === 0, failures };
}
