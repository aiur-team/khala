import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Panel } from '../../shell/Panel';
import { StatusBadge, type StatusTone } from '../../shell/StatusBadge';
import { createAgentControlsController, type AgentControlsConfig, type AgentControlsController } from './controller';
import {
  listeningStatusText,
  type AgentControlsView, type EvidenceDetail, type GrantState, type ListeningDisplay, type ListeningModeOption,
} from './model';
import type { AgentControlsPorts } from './ports';

export interface AgentControlsPanelProps {
  ports: AgentControlsPorts;
  config: AgentControlsConfig;
  /** Test-only seam: a pre-built controller (for example one already driven to a target snapshot). */
  controller?: AgentControlsController;
}

const CONNECTION_TONE: Record<AgentControlsView['connection'], StatusTone> = {
  connected: 'positive',
  offline: 'critical',
  unknown: 'neutral',
};

const CONNECTION_LABEL: Record<AgentControlsView['connection'], string> = {
  connected: 'Connector online',
  offline: 'Connector offline',
  unknown: 'Connector status unknown',
};

const ACKNOWLEDGMENT_TONE: Record<AgentControlsView['policy']['acknowledgment'], StatusTone> = {
  pending: 'caution',
  effective: 'positive',
  matches: 'positive',
  offline: 'critical',
  rejected: 'critical',
  unknown: 'critical',
};

function effectivePolicyLabel(view: AgentControlsView): string {
  if (view.policy.effectiveVersion === null || view.policy.effectiveMode === null || view.policy.paused === null) {
    return 'Effective policy unknown';
  }
  // "Automatic delivery" is never offered as a request from this panel — it is
  // only decodable because the wire contract must not change shape when
  // G-AUTOMATION opens (KTD3) — so a snapshot that already reports it is
  // labelled as pending that unresolved decision, never as a live feature.
  const modeLabel = view.policy.effectiveMode === 'review'
    ? 'Review required'
    : 'Automatic delivery (unavailable pending policy decision)';
  const pauseLabel = view.policy.paused ? ', paused' : '';
  return `${modeLabel}${pauseLabel} (v${view.policy.effectiveVersion})`;
}

const ACKNOWLEDGMENT_SUFFIX: Record<AgentControlsView['policy']['acknowledgment'], string> = {
  pending: ' — request pending',
  effective: ' — confirmed',
  // A values-only snapshot match is not proof this command's own ack settled
  // — it is worded as agreement with current state, never "confirmed", which
  // is reserved for this exact command's own terminal ack.
  matches: ' — current policy matches your request',
  offline: ' — connector offline, request pending',
  rejected: ' — request rejected',
  unknown: ' — outcome unknown, connector unreachable',
};

/**
 * A pause/resume request changes future delivery policy only. It is never a
 * claim that an in-flight model turn stopped or was cancelled (KTD3) — the
 * wording here is deliberately scoped to "delivery" and "requested", never
 * "stopped"/"cancelled". Tracks `requestedPaused` explicitly so a resume
 * request is never mislabelled as a pause request.
 */
function requestedPolicyLabel(view: AgentControlsView): string | null {
  if (view.policy.requestedVersion === null || view.policy.requestedPaused === null) return null;
  const action = view.policy.requestedPaused ? 'pause requested' : 'resume requested';
  const suffix = ACKNOWLEDGMENT_SUFFIX[view.policy.acknowledgment]
    + (view.policy.errorCode ? ` (${view.policy.errorCode})` : '');
  return `Requested: review, ${action} (v${view.policy.requestedVersion})${suffix}`;
}

export function EvidenceLines({ evidence }: { evidence: EvidenceDetail }) {
  return (
    <ul className="agent-controls__evidence-list">
      <li>Route: {evidence.route}</li>
      <li>Tested version: {evidence.testedVersion ?? 'none'}</li>
      <li>
        Evidence:{' '}
        {evidence.evidenceHref && evidence.evidenceRef
          ? <a href={evidence.evidenceHref}>{evidence.evidenceRef}</a>
          : evidence.evidenceRef ?? 'none'}
      </li>
      <li>Evidence revision: {evidence.evidenceRevision ?? 'none'}</li>
    </ul>
  );
}

/**
 * Green is reserved for a proven route on an active session. A stopped or
 * disconnected session, or any route short of proven, never shows green.
 */
function supportTone(option: ListeningModeOption, sessionActive: boolean): StatusTone {
  if (!sessionActive) return 'neutral';
  if (option.status === 'proven') return 'positive';
  if (option.status === 'experimental') return 'caution';
  return 'neutral';
}

const SUPPORT_LABEL: Record<ListeningModeOption['status'], string> = {
  proven: 'Proven',
  experimental: 'Experimental',
  blocked_without_wrapper: 'Blocked without wrapper',
  unsupported: 'Unsupported',
  unknown: 'Unknown',
};

function grantSuffix(grant: GrantState): string {
  if (grant.kind === 'granted') return ' (granted)';
  if (grant.kind === 'expired') return ' (consent expired)';
  return '';
}

function ListeningSection({ listening, controller }: { listening: ListeningDisplay; controller: AgentControlsController }) {
  const baseId = useId();
  const fieldsetRef = useRef<HTMLFieldSetElement>(null);
  const confirmationRef = useRef<HTMLDivElement>(null);
  const inactiveId = `${baseId}-inactive`;
  const selected = listening.draft ?? listening.requested;
  const pending = listening.submission.kind === 'pending';
  const draftOption = listening.options.find(option => option.mode === listening.draft);
  const canApply = !pending
    && listening.draft !== null
    && listening.draft !== listening.requested
    && draftOption?.selectable === true;
  const confirmation = listening.confirmation;

  // Conflict recovery: move focus back to the refreshed selector so the owner
  // can make an explicit choice; nothing is resubmitted automatically.
  useEffect(() => {
    if (listening.focusToken === 0) return;
    const fieldset = fieldsetRef.current;
    if (!fieldset) return;
    const target = fieldset.querySelector<HTMLInputElement>('input:checked:not(:disabled)')
      ?? fieldset.querySelector<HTMLInputElement>('input:not(:disabled)');
    (target ?? fieldset).focus();
  }, [listening.focusToken]);

  useEffect(() => {
    if (confirmation) confirmationRef.current?.focus();
  }, [confirmation]);

  const hardCancelGrant = listening.hardCancel.grant;

  return (
    <section className="agent-controls__listening" aria-labelledby={`${baseId}-heading`}>
      <h3 id={`${baseId}-heading`}>Listening mode</h3>
      <p className="agent-controls__session-label">{listening.sessionLabel}</p>
      <p className="agent-controls__listening-meta">{listening.lastChangeLabel}</p>
      {listening.initialReason ? <p className="agent-controls__listening-meta">{listening.initialReason}</p> : null}
      {listening.idleClaim ? <p className="agent-controls__listening-meta">{listening.idleClaim}</p> : null}

      <fieldset
        ref={fieldsetRef}
        className="agent-controls__mode-selector"
        tabIndex={-1}
        aria-describedby={listening.inactiveReason ? inactiveId : undefined}
      >
        <legend>Listening mode for {listening.sessionLabel}</legend>
        {listening.options.map(option => {
          const inputId = `${baseId}-${option.mode}`;
          const descriptionId = `${inputId}-description`;
          const grant = option.experimentalGrant;
          return (
            <div key={option.mode} className="agent-controls__mode-option">
              <input
                type="radio"
                id={inputId}
                name={`${baseId}-mode`}
                value={option.mode}
                checked={selected === option.mode}
                disabled={!option.selectable || pending}
                aria-describedby={descriptionId}
                onChange={() => controller.selectListeningMode(option.mode)}
              />
              <label htmlFor={inputId}>
                {option.mode}
                {option.mode === listening.requested ? ' (requested)' : ''}
              </label>{' '}
              <StatusBadge
                tone={supportTone(option, listening.sessionActive)}
                label={`${SUPPORT_LABEL[option.status]}${grantSuffix(grant)}`}
              />
              <p id={descriptionId} className="agent-controls__mode-description">{option.description}</p>
              {option.canGrantExperimental ? (
                <button type="button" onClick={() => controller.requestGrant('experimental_route', option.mode)}>
                  {grant.kind === 'expired' ? 'Review updated evidence' : 'Enable experimental route'}
                </button>
              ) : null}
              {grant.kind !== 'none' && listening.inactiveReason === null ? (
                <button type="button" onClick={() => controller.revokeGrant('experimental_route', option.mode)}>
                  Revoke experimental route
                </button>
              ) : null}
              <details className="agent-controls__evidence">
                <summary>Evidence for {option.mode} on {listening.sessionLabel}</summary>
                <EvidenceLines evidence={option.evidence} />
              </details>
            </div>
          );
        })}
      </fieldset>

      <div className="agent-controls__actions">
        <button
          type="button"
          className="agent-controls__apply-mode-button"
          disabled={!canApply}
          aria-describedby={listening.inactiveReason ? inactiveId : undefined}
          onClick={() => controller.applyListeningMode()}
        >
          Apply listening mode
        </button>
      </div>

      {/* Permanently mounted so requested/effective divergence, conflicts and
          grant results are announced even though it started with text. */}
      <p className="agent-controls__listening-status" role="status">{listeningStatusText(listening)}</p>

      {listening.inactiveReason ? (
        <p id={inactiveId} className="agent-controls__notice" role="note">{listening.inactiveReason}</p>
      ) : null}

      {listening.deliveryIssue ? (
        <p className="agent-controls__listening-issue">{listening.deliveryIssue}</p>
      ) : null}

      <div className="agent-controls__hard-cancel">
        <h4>Hard cancel</h4>
        <p className="agent-controls__mode-description">
          {listening.hardCancel.description}
          {hardCancelGrant.kind === 'granted' ? ' Granted for this binding.' : ' Off by default.'}
        </p>
        {listening.hardCancel.canGrant ? (
          <button type="button" onClick={() => controller.requestGrant('hard_cancel', 'steer')}>
            {hardCancelGrant.kind === 'expired' ? 'Review updated hard-cancel evidence' : 'Enable hard cancel'}
          </button>
        ) : null}
        {hardCancelGrant.kind !== 'none' && listening.inactiveReason === null ? (
          <button type="button" onClick={() => controller.revokeGrant('hard_cancel', 'steer')}>
            Revoke hard cancel
          </button>
        ) : null}
        <details className="agent-controls__evidence">
          <summary>Hard-cancel evidence for {listening.sessionLabel}</summary>
          <EvidenceLines evidence={listening.hardCancel.evidence} />
        </details>
      </div>

      {confirmation ? (
        <div
          ref={confirmationRef}
          className="agent-controls__confirmation"
          role="group"
          tabIndex={-1}
          aria-labelledby={`${baseId}-confirm-heading`}
        >
          <h4 id={`${baseId}-confirm-heading`}>
            {confirmation.grantKind === 'hard_cancel'
              ? `Enable hard cancel on ${confirmation.sessionLabel}?`
              : `Enable experimental ${confirmation.mode} route on ${confirmation.sessionLabel}?`}
          </h4>
          {confirmation.expiredChanges ? (
            <p>Your earlier consent expired: {confirmation.expiredChanges.join('; ')}.</p>
          ) : null}
          <EvidenceLines evidence={confirmation.evidence} />
          <p>Missing proof: {confirmation.missingProof}</p>
          <p className="agent-controls__warning">{confirmation.warning}</p>
          <div className="agent-controls__actions">
            <button type="button" onClick={() => controller.confirmGrant()}>Confirm for this binding</button>
            <button type="button" onClick={() => controller.cancelGrant()}>Cancel</button>
          </div>
        </div>
      ) : null}

      {listening.secondaryEvidence ? (
        <details className="agent-controls__evidence">
          <summary>Secondary evidence for {listening.sessionLabel}</summary>
          <p>{listening.secondaryEvidence}</p>
        </details>
      ) : null}
    </section>
  );
}

export function AgentControlsPanel({ ports, config, controller: injectedController }: AgentControlsPanelProps) {
  const ownController = useMemo(
    () => (injectedController ? null : createAgentControlsController(ports, config)),
    [
      ports, config.bindingId, config.roomId, config.peerParticipantId, config.viewerOwnerId, config.evidenceRegistry,
      injectedController,
    ],
  );
  const controller = injectedController ?? ownController!;
  const [view, setView] = useState<AgentControlsView>(() => controller.getView());
  const unavailableReasonId = useId();

  useEffect(() => {
    setView(controller.getView());
    return controller.subscribe(setView);
  }, [controller]);
  useEffect(() => () => {
    // Only dispose the controller this component built; an injected controller
    // is owned by its caller (e.g. a test), never leaked into or torn down here.
    if (ownController) ownController.dispose();
  }, [ownController]);

  const requestedLabel = requestedPolicyLabel(view);
  const nextPaused = !(view.policy.paused ?? false);

  return (
    <Panel heading="Agent delivery controls">
      <dl className="agent-controls__scope">
        <div>
          <dt>Owner</dt>
          <dd>{view.ownerLabel}</dd>
        </div>
        <div>
          <dt>Agent</dt>
          <dd>{view.agentLabel}</dd>
        </div>
        <div>
          <dt>Channel</dt>
          <dd>{view.roomLabel}</dd>
        </div>
      </dl>

      <div className="agent-controls__status">
        <StatusBadge tone={CONNECTION_TONE[view.connection]} label={CONNECTION_LABEL[view.connection]} />
        {view.revoked ? <StatusBadge tone="critical" label="Revoked" /> : null}
        <span className="agent-controls__effective">{effectivePolicyLabel(view)}</span>
      </div>

      {view.capabilityDetail ? (
        <p className="agent-controls__capability">{view.capabilityDetail}</p>
      ) : null}

      {/* Permanently mounted so a later confirmation is announced by assistive
          tech even though this element was empty when the page first rendered. */}
      <p className="agent-controls__requested" role="status">
        {requestedLabel ? (
          <StatusBadge tone={ACKNOWLEDGMENT_TONE[view.policy.acknowledgment]} label={requestedLabel} />
        ) : null}
      </p>

      <div className="agent-controls__actions">
        <button
          type="button"
          className="agent-controls__pause-button"
          disabled={!view.controlsAvailable}
          aria-describedby={!view.controlsAvailable && view.unavailableReason ? unavailableReasonId : undefined}
          onClick={() => controller.requestPause(nextPaused)}
        >
          {nextPaused ? 'Request pause' : 'Resume review delivery'}
        </button>
        {view.notice ? (
          <button type="button" className="agent-controls__refresh-button" onClick={() => controller.refresh()}>
            Refresh
          </button>
        ) : null}
        {view.retryAvailable ? (
          <button type="button" className="agent-controls__retry-button" onClick={() => controller.retry()}>
            Retry
          </button>
        ) : null}
      </div>

      {!view.controlsAvailable && view.unavailableReason ? (
        <p id={unavailableReasonId} className="agent-controls__notice" role="note">{view.unavailableReason}</p>
      ) : null}

      {view.notice ? (
        <p className="agent-controls__notice agent-controls__notice--alert" role="alert">{view.notice.message}</p>
      ) : null}

      {view.listening ? (
        <ListeningSection listening={view.listening} controller={controller} />
      ) : (
        <section className="agent-controls__listening">
          <h3>Listening mode</h3>
          <p className="agent-controls__notice">Waiting for listening-mode state for this binding.</p>
        </section>
      )}

      {view.receiptDetail ? (
        <p className="agent-controls__receipt">
          {view.listening ? `${view.listening.sessionLabel}: ` : ''}{view.receiptDetail}
        </p>
      ) : null}
    </Panel>
  );
}
