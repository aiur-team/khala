import type { ListeningModeView, SessionBinding } from '@khala/contracts/delivery/index';
import type { LocalAutomationProvider } from './provider';

/** Inputs are read from the owner's local grant, mode and causal journals, never a message body. */
export type AdmittedPeerFacts = Readonly<{
  recipient: SessionBinding;
  sender: SessionBinding | null;
  recipientChannelId: string;
  senderChannelId: string | null;
  recipientActive: boolean;
  senderActive: boolean;
  paused: boolean | 'unavailable';
  mode: ListeningModeView | null;
  arrivedModeVersion: number | null;
  causal: Readonly<{ rootId: string; depth: number }> | null;
  releasedInCausalRoot: number;
  activeJobs: number;
}>;

export type AdmittedPeerDecision =
  | Readonly<{ kind: 'reserve'; rootId: string; depth: number; modeVersion: number }>
  | Readonly<{ kind: 'held'; reason: 'grant' | 'mode' | 'paused' | 'stale' | 'causal_unknown' | 'loop_limit' | 'budget_exhausted' | 'busy' }>;

/**
 * The internal-only peer authority is the owner's journaled same-channel admission.
 * A local listening-mode control is a delivery condition, not a synthetic hosted
 * `auto` command or connector policy acknowledgement. A human-authored event starts
 * a new causal root; an agent event without server-derived provenance never wakes.
 */
export function evaluateAdmittedPeer(
  provider: LocalAutomationProvider,
  facts: AdmittedPeerFacts,
): AdmittedPeerDecision {
  const hold = (reason: Extract<AdmittedPeerDecision, { kind: 'held' }>['reason']): AdmittedPeerDecision => ({ kind: 'held', reason });
  if (!facts.recipientActive || !facts.senderActive || !facts.sender
    || facts.sender.agentParticipantId === facts.recipient.agentParticipantId
    || facts.senderChannelId !== facts.recipientChannelId) return hold('grant');
  if (facts.paused !== false) return hold('paused');
  const mode = facts.mode;
  if (!mode || mode.bindingId !== facts.recipient.bindingId || mode.generation !== facts.recipient.generation
    || (mode.effective !== 'steer' && mode.effective !== 'sync')) return hold('mode');
  if (facts.arrivedModeVersion !== mode.version) return hold('stale');
  const causal = facts.causal;
  if (!causal || !causal.rootId || !Number.isSafeInteger(causal.depth) || causal.depth < 0) return hold('causal_unknown');
  if (causal.depth >= provider.limits.maxCausalDepth) return hold('loop_limit');
  if (!Number.isSafeInteger(facts.releasedInCausalRoot) || facts.releasedInCausalRoot < 0
    || !Number.isSafeInteger(facts.activeJobs) || facts.activeJobs < 0) return hold('causal_unknown');
  if (facts.releasedInCausalRoot >= provider.limits.maxJobsPerCausalRoot) return hold('budget_exhausted');
  if (facts.activeJobs >= provider.limits.maxConcurrentJobs) return hold('busy');
  return { kind: 'reserve', rootId: causal.rootId, depth: causal.depth, modeVersion: mode.version };
}
