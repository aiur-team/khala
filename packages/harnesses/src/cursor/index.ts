// Cursor app harness adapter. Khala never launches, hosts or pushes into Cursor
// (decision 24): the person's own Agent Chat pulls a batch through a proven hook or
// `khala_read`. `submit` therefore always fails closed, and `inspect` reports only what
// the exact inspected tuple's proofs support.

import type {
  AppHarnessRecord, Clock, DeliveryLimits, DeliveryReceipt, HarnessPort, SessionBinding,
} from '@khala/contracts/delivery/index';
import {
  CURSOR_HARNESS, CURSOR_SHAPES, type CursorInspection, type CursorRouteProof, cursorAppRecord,
} from './capabilities';
import { cursorFailedReceipt } from './receipts';

export {
  CURSOR_ADAPTER_VERSION, CURSOR_BLOCKED_REASONS, CURSOR_BLOCKED_SUMMARIES, CURSOR_HARNESS, CURSOR_MODE_ROUTES, CURSOR_NEXT_TURN_ONLY_REASON,
  CURSOR_PROOF_MATRIX_REF, CURSOR_ROUTE_PROOFS, CURSOR_SHAPES, cursorAppRecord,
} from './capabilities';
export type { CursorInspection, CursorRouteProof, CursorShape } from './capabilities';
export { cursorFailedReceipt, cursorReceiptKind } from './receipts';
export type { CursorObservation } from './receipts';

/** Reports what the person's running Cursor app is. It never starts Cursor or an agent. */
export interface CursorAppProbe {
  inspect(sessionId: string): Promise<CursorInspection>;
}

export type CursorHarnessDeps = Readonly<{
  probe: CursorAppProbe;
  clock: Clock;
  /** From configuration or the capability record; the adapter has no default. */
  limits: DeliveryLimits;
  /** Test seam; production uses the committed proofs. */
  proofs?: readonly CursorRouteProof[];
}>;

export interface CursorHarness extends HarnessPort {
  /** The full app record (identity tuple and boundaries) behind `inspect`. */
  inspectApp(binding: SessionBinding): Promise<AppHarnessRecord>;
}

const NULL_FIELD = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : null);

function sanitize(raw: CursorInspection): CursorInspection | null {
  if (!(CURSOR_SHAPES as readonly unknown[]).includes(raw?.shape)) return null;
  return {
    shape: raw.shape,
    appVersion: NULL_FIELD(raw.appVersion),
    accountTier: NULL_FIELD(raw.accountTier),
    administratorPolicyScope: NULL_FIELD(raw.administratorPolicyScope),
  };
}

export function createCursorHarness(deps: CursorHarnessDeps): CursorHarness {
  const { probe, clock, limits } = deps;
  let closed = false;

  async function inspectApp(binding: SessionBinding): Promise<AppHarnessRecord> {
    if (closed) throw new Error('cursor adapter is closed');
    if (binding.harness !== CURSOR_HARNESS) throw new Error('cursor adapter: binding names another harness');
    // A probe that cannot name a Cursor shape is treated as an uninspected local chat.
    const inspection = sanitize(await probe.inspect(binding.sessionId)) ?? {
      shape: 'local_chat', appVersion: null, accountTier: null, administratorPolicyScope: null,
    };
    return cursorAppRecord(inspection, limits, deps.proofs);
  }

  return {
    inspectApp,
    async inspect(binding) {
      return (await inspectApp(binding)).capabilities;
    },

    // Khala never wakes Cursor; a hint must never reach the model.
    async notify() {},

    async submit({ job }): Promise<DeliveryReceipt> {
      return cursorFailedReceipt(job, 'harness_unavailable', clock);
    },

    // `null` means "no evidence" and never licenses a second submission.
    async reconcile() {
      return null;
    },

    async close() {
      closed = true;
    },
  };
}
