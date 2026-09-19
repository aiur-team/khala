import type { ProvideRecoverySecret } from '@khala/contracts/messaging/index';

import {
  IDLE_RECOVERY_OPERATION,
  projectClosureOperation,
  projectRecoveryOperation,
  projectRecoveryView,
  projectRevocationOperation,
} from './model';
import type { RecoveryOperation, RecoveryView } from './model';
import type {
  RecoveryOperationReference,
  RecoveryPorts,
  RecoverySnapshot,
  RevocationCapability,
} from './ports';

export type RecoveryControllerConfig = Readonly<{
  roomId: RecoveryOperationReference['roomId'];
  roomRevision: number;
  createOperationId?: () => string;
}>;

export interface RecoveryController {
  getView(): RecoveryView;
  subscribe(listener: () => void): () => void;
  beginRecovery(mode: string, provideSecret: ProvideRecoverySecret): Promise<RecoveryOperation | null>;
  beginRevocation(target: RevocationCapability): Promise<RecoveryOperation | null>;
  beginClosure(): Promise<RecoveryOperation | null>;
  inspect(): Promise<RecoveryOperation | null>;
  cancel(): void;
  dispose(): void;
}

function ownerId(snapshot: RecoverySnapshot): RecoveryOperationReference['ownerId'] | null {
  return snapshot.identity.kind === 'signed_in' ? snapshot.identity.principal.ownerId : null;
}

function closureMatchesConfig(snapshot: RecoverySnapshot, config: RecoveryControllerConfig): boolean {
  return snapshot.closure === null
    || (snapshot.closure.roomId === config.roomId
      && snapshot.closure.expectedRoomRevision === config.roomRevision);
}

function referenceFor(
  kind: RecoveryOperationReference['kind'],
  operationId: string,
  snapshot: RecoverySnapshot,
  config: RecoveryControllerConfig,
): RecoveryOperationReference | null {
  const owner = ownerId(snapshot);
  if (owner === null) return null;
  if (!closureMatchesConfig(snapshot, config)) return null;
  return {
    kind,
    operationId,
    ownerId: owner,
    deviceId: snapshot.device.deviceId,
    deviceGeneration: snapshot.device.generation,
    roomId: config.roomId,
    roomRevision: config.roomRevision,
  };
}

function referenceMatches(
  reference: RecoveryOperationReference,
  snapshot: RecoverySnapshot,
  config: RecoveryControllerConfig,
): boolean {
  return ownerId(snapshot) === reference.ownerId
    && snapshot.device.deviceId === reference.deviceId
    && snapshot.device.generation === reference.deviceGeneration
    && reference.roomId === config.roomId
    && reference.roomRevision === config.roomRevision
    && closureMatchesConfig(snapshot, config);
}

function sameLifecycle(a: RecoverySnapshot, b: RecoverySnapshot, config: RecoveryControllerConfig): boolean {
  return ownerId(a) === ownerId(b)
    && a.device.deviceId === b.device.deviceId
    && a.device.generation === b.device.generation
    && (a.closure?.roomId ?? config.roomId) === (b.closure?.roomId ?? config.roomId)
    && (a.closure?.expectedRoomRevision ?? config.roomRevision)
      === (b.closure?.expectedRoomRevision ?? config.roomRevision);
}

function pendingOperation(reference: RecoveryOperationReference): RecoveryOperation {
  switch (reference.kind) {
    case 'recovery':
      return { kind: 'recovery', operationId: reference.operationId, state: 'restoring', reason: null };
    case 'revocation':
      return { kind: 'revocation', operationId: reference.operationId, state: 'pending', reason: null };
    case 'closure':
      return { kind: 'closure', operationId: reference.operationId, state: 'pending', reason: null };
  }
}

function unknownOperation(reference: RecoveryOperationReference): RecoveryOperation {
  return { kind: reference.kind, operationId: reference.operationId, state: 'outcome_unknown', reason: null };
}

function isTerminal(operation: RecoveryOperation): boolean {
  if (operation.kind === 'idle' || operation.state === 'outcome_unknown') return false;
  if (operation.kind === 'recovery') return operation.state !== 'locked' && operation.state !== 'restoring';
  if (operation.kind === 'revocation') {
    return operation.state !== 'pending'
      && operation.state !== 'propagating'
      && operation.state !== 'partial';
  }
  return operation.state !== 'pending' && operation.state !== 'partial';
}

function defaultOperationId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Owns one scoped operation at a time. The resume reference is written before
 * dispatch and deliberately outlives disposal or an ambiguous remote result.
 */
export function createRecoveryController(
  ports: RecoveryPorts,
  config: RecoveryControllerConfig,
): RecoveryController {
  const lifecycleAbort = new AbortController();
  const listeners = new Set<() => void>();
  const createOperationId = config.createOperationId ?? defaultOperationId;
  let currentSnapshot = ports.ui.snapshot();
  let operation: RecoveryOperation = IDLE_RECOVERY_OPERATION;
  let activeReference: RecoveryOperationReference | null = null;
  let operationAbort: AbortController | null = null;
  let operationGeneration = 0;
  let disposed = false;
  let cachedView = projectRecoveryView(currentSnapshot, operation);

  function notify(): void {
    cachedView = projectRecoveryView(currentSnapshot, operation);
    if (disposed) return;
    for (const listener of listeners) listener();
  }

  function clearActiveReference(): void {
    activeReference = null;
    ports.resumeStore.clear();
  }

  function invalidateOperation(): void {
    operationGeneration += 1;
    operationAbort?.abort();
    operationAbort = null;
    if (activeReference !== null) clearActiveReference();
    operation = IDLE_RECOVERY_OPERATION;
  }

  function tokenIsCurrent(reference: RecoveryOperationReference, token: number): boolean {
    return !disposed
      && operationGeneration === token
      && activeReference?.operationId === reference.operationId
      && activeReference.kind === reference.kind
      && referenceMatches(reference, currentSnapshot, config);
  }

  function adoptOperation(
    reference: RecoveryOperationReference,
    token: number,
    nextOperation: RecoveryOperation,
  ): RecoveryOperation | null {
    if (!tokenIsCurrent(reference, token)) return null;
    operation = nextOperation;
    if (isTerminal(operation)) clearActiveReference();
    notify();
    return operation;
  }

  function adoptUnknown(reference: RecoveryOperationReference, token: number): RecoveryOperation | null {
    if (!tokenIsCurrent(reference, token)) return null;
    operation = unknownOperation(reference);
    notify();
    return operation;
  }

  function beginReference(kind: RecoveryOperationReference['kind']): {
    reference: RecoveryOperationReference;
    token: number;
    signal: AbortSignal;
  } | null {
    if (disposed || activeReference !== null) return null;
    const operationId = createOperationId();
    if (operationId.length === 0) return null;
    const reference = referenceFor(kind, operationId, currentSnapshot, config);
    if (reference === null) return null;

    operationGeneration += 1;
    const token = operationGeneration;
    operationAbort = new AbortController();
    activeReference = reference;
    operation = pendingOperation(reference);
    // Write-ahead is intentional: a crash immediately after dispatch must still
    // leave enough non-secret identity for the next controller to inspect.
    ports.resumeStore.save(reference);
    notify();
    return { reference, token, signal: operationAbort.signal };
  }

  async function beginRecovery(
    _mode: string,
    _provideSecret: ProvideRecoverySecret,
  ): Promise<RecoveryOperation | null> {
    void _mode;
    void _provideSecret;
    // P14 exposes no recovery mode. Retain the method shape for the canonical
    // port boundary, but fail closed without allocating an operation or
    // invoking a secret callback.
    return null;
  }

  async function beginRevocation(target: RevocationCapability): Promise<RecoveryOperation | null> {
    const isCurrentTarget = currentSnapshot.revocationTargets.some(candidate =>
      candidate.targetKind === target.targetKind
      && candidate.targetId === target.targetId
      && candidate.expectedGeneration === target.expectedGeneration);
    if (!isCurrentTarget || activeReference !== null || disposed) return null;
    const begun = beginReference('revocation');
    if (begun === null) return null;
    const { reference, token, signal } = begun;
    try {
      const result = await ports.ui.revoke(
        { ...target, operationId: reference.operationId },
        { signal },
      );
      return adoptOperation(reference, token, projectRevocationOperation(reference.operationId, result));
    } catch {
      return adoptUnknown(reference, token);
    }
  }

  async function beginClosure(): Promise<RecoveryOperation | null> {
    const capability = currentSnapshot.closure;
    if (disposed || activeReference !== null || capability?.available !== true) return null;
    if (ownerId(currentSnapshot) !== capability.ownerId
      || capability.roomId !== config.roomId
      || capability.expectedRoomRevision !== config.roomRevision) return null;
    const begun = beginReference('closure');
    if (begun === null) return null;
    const { reference, token, signal } = begun;
    try {
      const result = await ports.ui.closeRoom({
        operationId: reference.operationId,
        ownerId: reference.ownerId,
        roomId: reference.roomId,
        expectedRoomRevision: reference.roomRevision,
      }, { signal });
      return adoptOperation(reference, token, projectClosureOperation(reference.operationId, result));
    } catch {
      return adoptUnknown(reference, token);
    }
  }

  async function inspectReference(reference: RecoveryOperationReference): Promise<RecoveryOperation | null> {
    if (disposed || !referenceMatches(reference, currentSnapshot, config)) return null;
    operationGeneration += 1;
    const token = operationGeneration;
    operationAbort?.abort();
    operationAbort = new AbortController();
    activeReference = reference;
    operation = pendingOperation(reference);
    notify();
    try {
      switch (reference.kind) {
        case 'recovery': {
          const result = await ports.ui.inspectRecovery(reference.operationId, { signal: operationAbort.signal });
          return adoptOperation(reference, token, projectRecoveryOperation(reference.operationId, result));
        }
        case 'revocation': {
          const result = await ports.ui.inspectRevocation(reference.operationId, { signal: operationAbort.signal });
          return adoptOperation(reference, token, projectRevocationOperation(reference.operationId, result));
        }
        case 'closure': {
          const result = await ports.ui.inspectClosure(reference.operationId, { signal: operationAbort.signal });
          return adoptOperation(reference, token, projectClosureOperation(reference.operationId, result));
        }
      }
    } catch {
      return adoptUnknown(reference, token);
    }
  }

  function inspect(): Promise<RecoveryOperation | null> {
    return activeReference === null ? Promise.resolve(null) : inspectReference(activeReference);
  }

  function cancel(): void {
    if (disposed) return;
    operationGeneration += 1;
    operationAbort?.abort();
    operationAbort = null;
    if (activeReference !== null) {
      // Aborting a local wait cannot establish whether an effectful request
      // reached its owner. Keep the write-ahead identity and require inspection
      // under the same operation ID before another mutation can begin.
      operation = unknownOperation(activeReference);
    } else {
      operation = IDLE_RECOVERY_OPERATION;
    }
    notify();
  }

  function getView(): RecoveryView {
    return cachedView;
  }

  function subscribe(listener: () => void): () => void {
    if (disposed) return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  const disposePortSubscription = ports.ui.subscribe(() => {
    if (disposed) return;
    const nextSnapshot = ports.ui.snapshot();
    if (!sameLifecycle(currentSnapshot, nextSnapshot, config)) invalidateOperation();
    currentSnapshot = nextSnapshot;
    if (activeReference !== null && !referenceMatches(activeReference, currentSnapshot, config)) {
      invalidateOperation();
    }
    notify();
  }, lifecycleAbort.signal);

  const savedReference = ports.resumeStore.load();
  if (savedReference !== null) {
    if (referenceMatches(savedReference, currentSnapshot, config)) {
      activeReference = savedReference;
      operation = pendingOperation(savedReference);
      notify();
      void inspectReference(savedReference);
    } else {
      ports.resumeStore.clear();
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    operationGeneration += 1;
    operationAbort?.abort();
    operationAbort = null;
    lifecycleAbort.abort();
    disposePortSubscription();
    listeners.clear();
    // Do not clear the write-ahead reference: an effectful request may have
    // escaped before local disposal, so the next controller must inspect it.
  }

  return {
    getView,
    subscribe,
    beginRecovery,
    beginRevocation,
    beginClosure,
    inspect,
    cancel,
    dispose,
  };
}
