// Delivery states for one inbox batch held by the OpenCode plugin. The plugin keeps no
// cursor, lease or dedupe table of its own: the batch token is Khala's, and the agent's
// next Khala call acknowledges it (decisions 1 and 3).

/**
 * `leased`: peeked with its token, nothing submitted. `delivered`: OpenCode stored the
 * prompt, the steer transform applied, or `khala_read` returned it — a queued claim, not
 * consumption. `uncertain`: reconciliation cannot tell whether a prompt was stored
 * (`outcome_unknown`). `acknowledged`: the next Khala call returned the token.
 */
export const OPENCODE_DELIVERY_STATES = ['leased', 'delivered', 'uncertain', 'acknowledged'] as const;
export type OpenCodeDeliveryState = (typeof OPENCODE_DELIVERY_STATES)[number];

export const OPENCODE_DELIVERY_EVENTS = [
  'submitted', 'outcome_unknown', 'next_call_acknowledged', 'human_confirmed_stored', 'human_authorized_replay', 'hint',
] as const;
export type OpenCodeDeliveryEvent = (typeof OPENCODE_DELIVERY_EVENTS)[number];

// Absent transitions are refused. There is no automatic path out of `uncertain`, and a
// hint never moves a batch: duplicate and catch-up hints only trigger a re-read.
const TRANSITIONS: Readonly<Record<OpenCodeDeliveryState, Partial<Record<OpenCodeDeliveryEvent, OpenCodeDeliveryState>>>> = {
  leased: { submitted: 'delivered', outcome_unknown: 'uncertain', hint: 'leased' },
  delivered: { next_call_acknowledged: 'acknowledged', hint: 'delivered' },
  uncertain: { human_confirmed_stored: 'delivered', human_authorized_replay: 'leased', hint: 'uncertain' },
  acknowledged: { hint: 'acknowledged' },
};

export type OpenCodeDeliveryTransition =
  | Readonly<{ ok: true; state: OpenCodeDeliveryState }>
  | Readonly<{ ok: false; code: 'invalid_transition' }>;

export function nextOpenCodeDeliveryState(
  state: OpenCodeDeliveryState,
  event: OpenCodeDeliveryEvent,
): OpenCodeDeliveryTransition {
  const next = TRANSITIONS[state][event];
  return next === undefined ? { ok: false, code: 'invalid_transition' } : { ok: true, state: next };
}

/** Only a `leased` batch may be submitted; `uncertain` blocks the binding until a human resolves it. */
export function maySubmitOpenCodeBatch(state: OpenCodeDeliveryState): boolean {
  return state === 'leased';
}
