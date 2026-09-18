import { useEffect, useId, useMemo, useState } from 'react';
import { Panel } from '../../shell/Panel';
import { StatusBadge, type StatusTone } from '../../shell/StatusBadge';
import { createAgentControlsController, type AgentControlsConfig, type AgentControlsController } from './controller';
import type { AgentControlsView } from './model';
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

export function AgentControlsPanel({ ports, config, controller: injectedController }: AgentControlsPanelProps) {
  const ownController = useMemo(
    () => (injectedController ? null : createAgentControlsController(ports, config)),
    [ports, config.bindingId, config.roomId, config.peerParticipantId, config.viewerOwnerId, injectedController],
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
          <dt>Room</dt>
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

      {view.receiptDetail ? (
        <p className="agent-controls__receipt">{view.receiptDetail}</p>
      ) : null}
    </Panel>
  );
}
