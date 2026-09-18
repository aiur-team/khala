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
