import { decodeChannelListing, type ChannelListing, type ChannelVisibility } from '@khala/contracts/messaging/index';
import type { AllowlistedAgent, ChannelSettingsSnapshot, KnownAgentPrincipal } from './ports';

/** The allowlist row for a picker entry; how the owner knew the agent is not stored. */
export function toAllowlisted(agent: KnownAgentPrincipal): AllowlistedAgent {
  return {
    principal: agent.principal,
    fingerprint: agent.fingerprint,
    sessionGeneration: agent.sessionGeneration,
    displayLabel: agent.displayLabel,
    workspaceLabel: agent.workspaceLabel,
  };
}

/** Ordered from least to most discoverable; an increase always needs confirmation. */
const VISIBILITY_RANK: Readonly<Record<ChannelVisibility, number>> = { secret: 0, private: 1, public: 2 };

export function isVisibilityIncrease(from: ChannelVisibility, to: ChannelVisibility): boolean {
  return VISIBILITY_RANK[to] > VISIBILITY_RANK[from];
}

/**
 * Stand-in for the per-agent opaque reference the server issues with each page.
 * The owner never sees a real reference: each agent session gets its own.
 */
export const PREVIEW_LISTING_REF = 'issued-per-agent';

export type ListingPreview =
  | Readonly<{ kind: 'listed'; listing: ChannelListing }>
  | Readonly<{ kind: 'not_listed' }>
  | Readonly<{ kind: 'invalid_title' }>;

/**
 * The exact pre-join `ChannelListing` an eligible agent would receive, built
 * through the contract decoder so title normalization matches the server's.
 * `secret` is never listed, so it has no projection at all.
 */
export function projectListing(visibility: ChannelVisibility, title: string): ListingPreview {
  if (visibility === 'secret') return { kind: 'not_listed' };
  const decoded = decodeChannelListing({
    v: 1,
    listingRef: PREVIEW_LISTING_REF,
    title,
    visibility,
    serviceKind: 'external',
    requestState: 'not_requested',
  });
  return decoded.ok ? { kind: 'listed', listing: decoded.value } : { kind: 'invalid_title' };
}

export type ChannelSettingsPhase = 'loading' | 'editing' | 'confirming' | 'submitting' | 'load_failed';

export type ChannelSettingsStatus =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'saved'; visibility: ChannelVisibility }>
  | Readonly<{ kind: 'allowed'; fingerprint: string }>
  | Readonly<{ kind: 'revoked'; fingerprint: string }>
  /** The channel changed elsewhere; settings were reloaded and nothing was saved. */
  | Readonly<{ kind: 'stale_refreshed' }>
  /** The viewer no longer manages the channel; the view is read-only. */
  | Readonly<{ kind: 'authority_lost' }>
  /** Nothing was saved. `retryable` failures keep the pending edit for `retry()`. */
  | Readonly<{ kind: 'failed'; code: string; retryable: boolean }>;

export type PickerState =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'ready'; principals: readonly KnownAgentPrincipal[] }>
  | Readonly<{ kind: 'failed' }>;

/** The edit currently being confirmed, submitted, or held for retry. */
export type PendingEdit =
  | Readonly<{ kind: 'visibility'; visibility: ChannelVisibility; title: string | null }>
  | Readonly<{ kind: 'allow'; agent: KnownAgentPrincipal }>
  | Readonly<{ kind: 'revoke'; agent: AllowlistedAgent }>;

export type ChannelSettingsView = Readonly<{
  phase: ChannelSettingsPhase;
  /** Last server-confirmed settings; null until the first read succeeds. */
  saved: ChannelSettingsSnapshot | null;
  readOnly: boolean;
  draftVisibility: ChannelVisibility;
  draftTitle: string;
  titleError: 'title_required' | 'title_invalid' | null;
  preview: ListingPreview;
  pending: PendingEdit | null;
  status: ChannelSettingsStatus;
  picker: PickerState;
}>;

export const INITIAL_VIEW: ChannelSettingsView = {
  phase: 'loading',
  saved: null,
  readOnly: true,
  draftVisibility: 'secret',
  draftTitle: '',
  titleError: null,
  preview: { kind: 'not_listed' },
  pending: null,
  status: { kind: 'idle' },
  picker: { kind: 'loading' },
};
