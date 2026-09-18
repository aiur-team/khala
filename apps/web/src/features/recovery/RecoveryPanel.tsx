import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { Panel } from '../../shell/Panel';
import { StatusBadge, type StatusTone } from '../../shell/StatusBadge';
import {
  createRecoveryController,
  type RecoveryController,
  type RecoveryControllerConfig,
} from './controller';
import { canBeginOperation, type RecoveryOperation, type RecoveryView } from './model';
import type { ClosureConsequences, RecoveryPorts, RevocationCapability } from './ports';

export interface RecoveryPanelProps {
  ports: RecoveryPorts;
  config: RecoveryControllerConfig;
  onClosureComplete: () => void;
  /** Test/composition seam for a controller whose lifetime is owned by its caller. */
  controller?: RecoveryController;
}

type Selection =
  | Readonly<{ kind: 'revocation'; target: RevocationCapability }>
  | Readonly<{ kind: 'closure' }>;

type OperationPresentation = Readonly<{
  label: string;
  tone: StatusTone;
  message: string;
  alert: boolean;
}>;

const DEVICE_LABEL: Record<RecoveryView['deviceState'], string> = {
  new: 'Device not initialized',
  initializing: 'Device initializing',
  ready: 'Device ready',
  locked: 'Device keys locked',
  lost: 'Device unavailable',
  revoked: 'Device revoked',
  failed: 'Device setup failed',
};

const DEVICE_TONE: Record<RecoveryView['deviceState'], StatusTone> = {
  new: 'neutral',
  initializing: 'neutral',
  ready: 'positive',
  locked: 'caution',
  lost: 'critical',
  revoked: 'critical',
  failed: 'critical',
};

const HISTORY_PRESENTATION: Record<RecoveryView['history'], Readonly<{
  label: string;
  tone: StatusTone;
  message: string;
}>> = {
  available: {
    label: 'History available',
    tone: 'positive',
    message: 'This device can decrypt the available room history.',
  },
  partial: {
    label: 'History partially available',
    tone: 'caution',
    message: 'Some earlier messages remain unavailable because this device does not have every historical key.',
  },
  unavailable: {
    label: 'History keys unavailable',
    tone: 'critical',
    message: 'This device cannot decrypt earlier messages. This does not mean the room has no messages.',
  },
};

function humanize(value: string): string {
  return value.replaceAll('_', ' ');
}

const OPERATION_PRESENTATIONS: Record<string, OperationPresentation> = {
    'recovery:locked': {
      label: 'Recovery needs input', tone: 'caution', message: 'Recovery is waiting for an approved local step.', alert: false,
    },
    'recovery:restoring': {
      label: 'Recovery in progress', tone: 'neutral', message: 'Historical keys are being restored to this device.', alert: false,
    },
    'recovery:restored': {
      label: 'Recovery complete', tone: 'positive', message: 'The available historical keys were restored to this device.', alert: false,
    },
    'recovery:partial': {
      label: 'Recovery partially complete', tone: 'caution', message: 'Some historical keys were restored; some earlier messages remain unavailable.', alert: true,
    },
    'recovery:unrecoverable': {
      label: 'History cannot be recovered', tone: 'critical', message: 'The selected device/key recovery mode cannot restore the remaining history.', alert: true,
    },
    'recovery:failed': {
      label: 'Recovery failed', tone: 'critical', message: 'No successful recovery was confirmed.', alert: true,
    },
    'recovery:outcome_unknown': {
      label: 'Recovery outcome unknown', tone: 'critical', message: 'Inspect this operation before taking another action.', alert: true,
    },
    'revocation:pending': {
      label: 'Revocation pending', tone: 'neutral', message: 'The revocation request is pending.', alert: false,
    },
    'revocation:propagating': {
      label: 'Revocation propagating', tone: 'neutral', message: 'The revocation is still reaching its approved targets.', alert: false,
    },
    'revocation:complete': {
      label: 'Revocation complete', tone: 'positive', message: 'The selected target was revoked.', alert: false,
    },
    'revocation:partial': {
      label: 'Revocation partially complete', tone: 'caution', message: 'Some revocation effects completed and some remain unresolved.', alert: true,
    },
    'revocation:failed': {
      label: 'Revocation failed', tone: 'critical', message: 'No complete revocation was confirmed.', alert: true,
    },
    'revocation:outcome_unknown': {
      label: 'Revocation outcome unknown', tone: 'critical', message: 'Inspect this operation before taking another action.', alert: true,
    },
    'closure:pending': {
      label: 'Closure pending', tone: 'neutral', message: 'Room closure is in progress.', alert: false,
    },
    'closure:complete': {
      label: 'Closure complete', tone: 'positive', message: 'New messages stopped and the room was removed from your view. Local cleanup was requested.', alert: false,
    },
    'closure:partial': {
      label: 'Closure partially complete', tone: 'caution', message: 'Completed: new messages stopped and the room was removed from your view. Remaining: local cleanup did not complete on every owner device.', alert: true,
    },
    'closure:failed': {
      label: 'Closure failed', tone: 'critical', message: 'No complete room closure was confirmed.', alert: true,
    },
    'closure:outcome_unknown': {
      label: 'Closure outcome unknown', tone: 'critical', message: 'Inspect this operation before taking another action.', alert: true,
    },
};

function operationPresentation(operation: Exclude<RecoveryOperation, { kind: 'idle' }>): OperationPresentation {
  if (operation.kind === 'closure' && operation.state === 'partial' && operation.reason !== 'local_cleanup_failed') {
    return {
      label: 'Closure partially complete',
      tone: 'caution',
      message: 'Some room-closure effects completed and some remain unresolved. Inspect the operation before taking another action.',
      alert: true,
    };
  }
  return OPERATION_PRESENTATIONS[`${operation.kind}:${operation.state}`] ?? {
    label: 'Operation unavailable',
    tone: 'critical',
    message: 'The operation returned a state this interface cannot safely interpret.',
    alert: true,
  };
}

function operationIsPending(operation: RecoveryOperation): boolean {
  if (operation.kind === 'idle') return false;
  if (operation.kind === 'recovery') return operation.state === 'locked' || operation.state === 'restoring';
  if (operation.kind === 'revocation') return operation.state === 'pending' || operation.state === 'propagating';
  return operation.state === 'pending';
}

function operationIsInspectable(operation: RecoveryOperation): boolean {
  return operation.kind !== 'idle'
    && (operationIsPending(operation)
      || operation.state === 'outcome_unknown'
      || ((operation.kind === 'revocation' || operation.kind === 'closure') && operation.state === 'partial'));
}

function ConsequenceList({ consequences }: { consequences: ClosureConsequences }) {
  return (
    <ul className="recovery-panel__consequences">
      {consequences.stopsNewMessages ? <li>New messages will stop.</li> : null}
      {consequences.removesFromOwnerView ? <li>The room will be removed from your view.</li> : null}
      {consequences.requestsLocalCleanup ? <li>Local cleanup will be requested on your devices.</li> : null}
      {!consequences.recallsDeliveredCopies ? (
        <li>Copies already delivered to participants or models cannot be recalled.</li>
      ) : null}
    </ul>
  );
}

export function RecoveryPanel({
  ports,
  config,
  onClosureComplete,
  controller: injectedController,
}: RecoveryPanelProps) {
  const ownController = useMemo(
    () => (injectedController ? null : createRecoveryController(ports, config)),
    [ports, config.roomId, config.roomRevision, config.createOperationId, injectedController],
  );
  const controller = injectedController ?? ownController!;
  const closureNavigation = useRef({ controller, operationId: null as string | null });
  if (closureNavigation.current.controller !== controller) {
    closureNavigation.current = { controller, operationId: null };
  }
  const view = useSyncExternalStore(controller.subscribe, controller.getView, controller.getView);
  const [selection, setSelection] = useState<Selection | null>(null);
  const selectionTrigger = useRef<HTMLButtonElement | null>(null);
  const operationRegion = useRef<HTMLDivElement>(null);
  const historyDescriptionId = useId();

  useEffect(() => {
    setSelection(null);
  }, [config.roomId, config.roomRevision, controller]);

  useEffect(() => () => {
    if (ownController) ownController.dispose();
  }, [ownController]);

  useEffect(() => {
    if (closureNavigation.current.controller !== controller) return;
    if (view.operation.kind !== 'closure' || view.operation.state !== 'complete') return;
    if (closureNavigation.current.operationId === view.operation.operationId) return;
    closureNavigation.current.operationId = view.operation.operationId;
    onClosureComplete();
  }, [onClosureComplete, view.operation]);

  const history = HISTORY_PRESENTATION[view.history];
  const busy = operationIsPending(view.operation);
  const actionsAvailable = canBeginOperation(view.operation);
  const activePresentation = view.operation.kind === 'idle' ? null : operationPresentation(view.operation);
  const closureCurrent = view.closure !== null
    && view.closure.available
    && view.closure.roomId === config.roomId
    && view.closure.expectedRoomRevision === config.roomRevision;

  const selectedTarget = selection?.kind === 'revocation'
    ? view.revocationTargets.find(target => target.targetKind === selection.target.targetKind
      && target.targetId === selection.target.targetId
      && target.expectedGeneration === selection.target.expectedGeneration)
    : undefined;
  function cancelLocal(): void {
    const returnFocusTo = selectionTrigger.current;
    setSelection(null);
    if (view.operation.kind !== 'idle') controller.cancel();
    requestAnimationFrame(() => returnFocusTo?.isConnected && returnFocusTo.focus());
  }

  async function submitSelection(): Promise<void> {
    if (selection?.kind === 'revocation' && selectedTarget !== undefined) {
      await controller.beginRevocation(selectedTarget);
    } else if (selection?.kind === 'closure' && closureCurrent && view.allowedActions.includes('close_room')) {
      await controller.beginClosure();
    }
  }

  return (
    <Panel heading="Recovery and room access">
      <div className="recovery-panel__facts" aria-describedby={historyDescriptionId}>
        <StatusBadge
          tone={view.identityState === 'signed_in' ? 'positive' : 'critical'}
          label={view.identityState === 'signed_in' ? 'Signed in' : view.identityState === 'signed_out' ? 'Signed out' : 'Sign-in unavailable'}
        />
        <StatusBadge tone={DEVICE_TONE[view.deviceState]} label={DEVICE_LABEL[view.deviceState]} />
        <StatusBadge tone={history.tone} label={history.label} />
      </div>
      <p id={historyDescriptionId} className="recovery-panel__history-note" role={view.history === 'available' ? 'note' : 'alert'}>
        {history.message}
      </p>

      <div
        ref={operationRegion}
        className="recovery-panel__operation"
        role={activePresentation?.alert ? 'alert' : 'status'}
        aria-busy={busy}
        tabIndex={view.operation.kind === 'idle' ? undefined : -1}
      >
        {view.operation.kind === 'idle' || activePresentation === null ? null : (
          <>
            <StatusBadge tone={activePresentation.tone} label={activePresentation.label} />
            <p>{activePresentation.message}</p>
            {view.operation.reason ? <p>Reason: {humanize(view.operation.reason)}.</p> : null}
            <p className="recovery-panel__operation-id">Operation: {view.operation.operationId}</p>
          </>
        )}
      </div>

      {view.operation.kind === 'closure' && view.closure ? (
        <div className="recovery-panel__confirmation">
          <h3>Room {view.closure.roomId}</h3>
          <ConsequenceList consequences={view.closure.consequences} />
          <p>Service retention is governed separately; closure promises no retention window or global erasure.</p>
        </div>
      ) : null}

      {actionsAvailable ? (
        <div className="recovery-panel__actions" aria-label="Available recovery and room actions">
          {view.revocationTargets.map(target => {
            const targetAllowed = view.allowedActions.includes(target.targetKind === 'device' ? 'revoke_device' : 'revoke_binding');
            return (
              <button
                key={`${target.targetKind}:${target.targetId}:${target.expectedGeneration}`}
                type="button"
                disabled={!targetAllowed}
                onClick={event => {
                  selectionTrigger.current = event.currentTarget;
                  setSelection({ kind: 'revocation', target });
                }}
              >
                Revoke {target.targetKind} {target.targetId}
              </button>
            );
          })}
          {view.closure ? (
            <button
              type="button"
              disabled={!view.allowedActions.includes('close_room') || !closureCurrent}
              onClick={event => {
                selectionTrigger.current = event.currentTarget;
                setSelection({ kind: 'closure' });
              }}
            >
              Close room
            </button>
          ) : null}
        </div>
      ) : null}

      {view.operation.kind === 'idle' && view.recoveryUnavailableReason !== null ? (
        <p className="recovery-panel__unavailable" role="note">Recovery is not available.</p>
      ) : null}

      {view.identityState !== 'signed_in'
      || (view.operation.kind === 'idle' && view.allowedActions.length === 0 && view.recoveryUnavailableReason === null) ? (
        <p className="recovery-panel__unavailable" role="note">
          Recovery and destructive actions are unavailable for the current account and capability context.
          {view.closure?.unavailableReason ? ` Closure: ${humanize(view.closure.unavailableReason)}.` : ''}
        </p>
      ) : null}

      {selection?.kind === 'revocation' && selectedTarget !== undefined && actionsAvailable ? (
        <div className="recovery-panel__confirmation" role="alert">
          <h3>Revoke {selectedTarget.targetKind} {selectedTarget.targetId}?</h3>
          <p>Generation {selectedTarget.expectedGeneration} will stop using its current access. This does not erase copies already received.</p>
          <div className="recovery-panel__confirmation-actions">
            <button type="button" onClick={submitSelection}>Confirm revocation</button>
            <button type="button" onClick={cancelLocal}>Cancel</button>
          </div>
        </div>
      ) : null}

      {selection?.kind === 'closure' && closureCurrent && view.closure && actionsAvailable ? (
        <div className="recovery-panel__confirmation" role="alert">
          <h3>Close room {view.closure.roomId}?</h3>
          <ConsequenceList consequences={view.closure.consequences} />
          <p>Service retention is governed separately; closure promises no retention window or global erasure.</p>
          <div className="recovery-panel__confirmation-actions">
            <button type="button" onClick={submitSelection}>Confirm room closure</button>
            <button type="button" onClick={cancelLocal}>Cancel</button>
          </div>
        </div>
      ) : null}

      {view.operation.kind !== 'idle' ? (
        <div className="recovery-panel__operation-actions">
          {busy ? (
            <button type="button" disabled>
              {view.operation.kind === 'recovery'
                ? 'Recovery in progress'
                : view.operation.kind === 'revocation'
                  ? 'Revocation in progress'
                  : 'Close room'}
            </button>
          ) : null}
          {operationIsInspectable(view.operation) ? (
            <button type="button" onClick={() => controller.inspect()}>Inspect operation</button>
          ) : null}
          {busy ? <button type="button" onClick={cancelLocal}>Cancel local wait</button> : null}
          {busy ? <p>This stops waiting here; it does not claim to cancel an effect already sent.</p> : null}
        </div>
      ) : null}
    </Panel>
  );
}
