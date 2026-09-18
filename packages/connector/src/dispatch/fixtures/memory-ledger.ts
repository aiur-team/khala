// Test-only reference ledger. Transactions run one at a time against a staged copy that is
// committed only when the work returns synchronously; a throw rolls it back. It is not durable: a
// restart is modelled by building a new dispatcher over the same instance. KHA-133 supplies the
// durable local ledger.

import type { BindingId, CausalRootId, CommandId, ReleaseId } from '@khala/contracts/delivery/index';
import {
  ACTIVE_STATES, type BindingState, type DispatchLedger, type DispatchPolicy, type DispatchRecord, type DispatchTx,
} from '../types';

/** Controls are applied through the same transactions, so they order against claims. */
export interface MemoryTx extends DispatchTx {
  setPolicy(bindingId: BindingId, policy: DispatchPolicy | null): void;
  setBinding(state: BindingState): void;
}

export interface MemoryLedger extends DispatchLedger {
  transact<T>(work: (tx: MemoryTx) => T): Promise<T>;
}

type State = {
  policies: Map<BindingId, DispatchPolicy | null>;
  bindings: Map<BindingId, BindingState>;
  records: Map<ReleaseId, DispatchRecord>;
  byApproval: Map<CommandId, ReleaseId>;
  causal: Map<CausalRootId, number>;
  seq: number;
};

export function createMemoryLedger(): MemoryLedger {
  let state: State = {
    policies: new Map(), bindings: new Map(), records: new Map(), byApproval: new Map(), causal: new Map(), seq: 0,
  };
  let chain: Promise<unknown> = Promise.resolve();

  function over(staged: State, open: () => boolean): MemoryTx {
    const records = (): DispatchRecord[] => [...staged.records.values()].sort((a, b) => a.seq - b.seq);
    const tx: MemoryTx = {
      policy: bindingId => staged.policies.get(bindingId) ?? null,
      binding: bindingId => staged.bindings.get(bindingId) ?? null,
      record: releaseId => staged.records.get(releaseId) ?? null,
      releaseFor: commandId => staged.byApproval.get(commandId) ?? null,
      put: record => {
        staged.records.set(record.releaseId, record);
        if (!staged.byApproval.has(record.job.approval.commandId)) staged.byApproval.set(record.job.approval.commandId, record.releaseId);
      },
      queued: () => records().filter(record => record.state === 'queued').map(record => record.releaseId),
      active: () => records().filter(record => ACTIVE_STATES.includes(record.state)),
      nextSeq: () => ++staged.seq,
      causalCount: root => staged.causal.get(root) ?? 0,
      setCausalCount: (root, count) => void staged.causal.set(root, count),
      setPolicy: (bindingId, policy) => void staged.policies.set(bindingId, policy),
      setBinding: binding => void staged.bindings.set(binding.binding.bindingId, binding),
    };
    // A tx used after its transaction ended, such as from a late async callback, throws.
    return Object.fromEntries(Object.entries(tx).map(([name, method]) => [name, (...args: unknown[]) => {
      if (!open()) throw new Error(`transaction closed: ${name}`);
      return (method as (...values: unknown[]) => unknown)(...args);
    }])) as unknown as MemoryTx;
  }

  function transact<T>(work: (tx: MemoryTx) => T): Promise<T> {
    const run = chain.then(() => {
      const staged: State = {
        ...state,
        policies: new Map(state.policies),
        bindings: new Map(state.bindings),
        records: new Map(state.records),
        byApproval: new Map(state.byApproval),
        causal: new Map(state.causal),
      };
      let open = true;
      try {
        const result = work(over(staged, () => open));
        if (typeof (result as { then?: unknown } | null)?.then === 'function') {
          throw new Error('transaction work must be synchronous');
        }
        state = staged;
        return result;
      } finally {
        open = false;
      }
    });
    chain = run.catch(() => undefined);
    return run;
  }

  return { transact };
}
