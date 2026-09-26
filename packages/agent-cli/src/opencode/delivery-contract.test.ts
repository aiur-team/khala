import { describe, expect, it } from 'vitest';
import {
  OPENCODE_DELIVERY_EVENTS, OPENCODE_DELIVERY_STATES, type OpenCodeDeliveryState,
  maySubmitOpenCodeBatch, nextOpenCodeDeliveryState,
} from './delivery-contract';
import * as entry from './index';

const allowed: Readonly<Record<string, OpenCodeDeliveryState>> = {
  'leased:submitted': 'delivered',
  'leased:outcome_unknown': 'uncertain',
  'delivered:next_call_acknowledged': 'acknowledged',
  'uncertain:human_confirmed_stored': 'delivered',
  'uncertain:human_authorized_replay': 'leased',
};

describe('OpenCode batch delivery states', () => {
  it.each(OPENCODE_DELIVERY_STATES.flatMap(state => OPENCODE_DELIVERY_EVENTS.map(event => [state, event] as const)))(
    '%s + %s follows the closed transition table',
    (state, event) => {
      const expected = event === 'hint' ? state : allowed[`${state}:${event}`];
      expect(nextOpenCodeDeliveryState(state, event)).toEqual(
        expected === undefined ? { ok: false, code: 'invalid_transition' } : { ok: true, state: expected },
      );
    },
  );

  it('submits only a leased batch; an uncertain outcome never replays automatically', () => {
    expect(OPENCODE_DELIVERY_STATES.filter(maySubmitOpenCodeBatch)).toEqual(['leased']);
    expect(nextOpenCodeDeliveryState('uncertain', 'submitted')).toEqual({ ok: false, code: 'invalid_transition' });
    expect(nextOpenCodeDeliveryState('uncertain', 'hint')).toEqual({ ok: true, state: 'uncertain' });
  });

  it('acknowledges only a delivered batch, and only through the next Khala call', () => {
    for (const state of OPENCODE_DELIVERY_STATES) {
      expect(nextOpenCodeDeliveryState(state, 'next_call_acknowledged').ok).toBe(state === 'delivered');
    }
  });
});

describe('@aiur/khala/opencode entry', () => {
  it('names itself and exposes the shared delivery contract', () => {
    expect(entry.OPENCODE_PLUGIN_SPECIFIER).toBe('@aiur/khala/opencode');
    expect(entry.OPENCODE_ROUTE_EVIDENCE).toHaveLength(5);
    expect(typeof entry.decodeOpenCodeInboxHint).toBe('function');
    expect(typeof entry.nextOpenCodeDeliveryState).toBe('function');
  });
});
