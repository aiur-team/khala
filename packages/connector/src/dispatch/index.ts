// Public surface of bounded model dispatch (KHA-121). Every effect goes through an injected port;
// composition binds the durable ledger, harness and controls (KHA-133, KHA-135). Test doubles and
// the in-memory reference ledger live under `fixtures/` and are not part of this surface.

export { createDispatcher } from './run';
export { claim, promote, sameRelease, type PromoteResult } from './claim';
export {
  ACTIVE_STATES, MAX_RECEIPTS, type AttemptSnapshot, type BindingState, type BlockCode, type BoundaryObservation,
  type ClaimResult, type DeliveryBoundary, type DispatchDeps, type DispatchLedger, type DispatchLimits, type DispatchListening,
  type DispatchMode, type DispatchPolicy, type DispatchRecord, type DispatchState, type DispatchTx, type Dispatcher,
  type EnqueueResult, type QuarantineCode,
} from './types';
