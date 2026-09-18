// In-process reference ledger. Transactions run one at a time against a staged copy that is
// committed only when the work returns. It is not durable: a restart is modelled by building a new
// dispatcher over the same instance. KHA-133 supplies the durable local ledger.

import type { BindingId, CausalRootId, ReleaseId } from '@khala/contracts/delivery/index';
import {
  ACTIVE_STATES, type BindingState, type DispatchLedger, type DispatchPolicy, type DispatchRecord, type DispatchTx,
} from './types';

/** Controls are applied through the same transactions, so they order against claims. */
export interface MemoryTx extends DispatchTx {
  setPolicy(policy: DispatchPolicy | null): void;
  setBinding(state: BindingState): void;
}

export interface MemoryLedger extends DispatchLedger {
  transact<T>(work: (tx: MemoryTx) => T): Promise<T>;
}

type State = {
  policy: DispatchPolicy | null;
  bindings: Map<BindingId, BindingState>;
  records: Map<ReleaseId, DispatchRecord>;
  causal: Map<CausalRootId, number>;
  seq: number;
};

export function createMemoryLedger(): MemoryLedger {
  let state: State = { policy: null, bindings: new Map(), records: new Map(), causal: new Map(), seq: 0 };
  let chain: Promise<unknown> = Promise.resolve();

  function over(staged: State): MemoryTx {
    const records = (): DispatchRecord[] => [...staged.records.values()].sort((a, b) => a.seq - b.seq);
    return {
      policy: () => staged.policy,
      binding: bindingId => staged.bindings.get(bindingId) ?? null,
      record: releaseId => staged.records.get(releaseId) ?? null,
      releaseFor: commandId => records().find(record => record.job.approval.commandId === commandId)?.releaseId ?? null,
      put: record => void staged.records.set(record.releaseId, record),
      queued: () => records().filter(record => record.state === 'queued').map(record => record.releaseId),
      active: () => records().filter(record => ACTIVE_STATES.includes(record.state)),
      nextSeq: () => ++staged.seq,
      causalCount: root => staged.causal.get(root) ?? 0,
      setCausalCount: (root, count) => void staged.causal.set(root, count),
      setPolicy: policy => void (staged.policy = policy),
      setBinding: binding => void staged.bindings.set(binding.binding.bindingId, binding),
    };
  }

  function transact<T>(work: (tx: MemoryTx) => T): Promise<T> {
    const run = chain.then(() => {
      const staged: State = {
        ...state,
        bindings: new Map(state.bindings),
        records: new Map(state.records),
        causal: new Map(state.causal),
      };
      const result = work(over(staged));
      state = staged;
      return result;
    });
    chain = run.catch(() => undefined);
    return run;
  }

  return { transact };
}
