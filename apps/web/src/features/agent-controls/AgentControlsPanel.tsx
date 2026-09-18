import { useEffect, useMemo, useState } from 'react';
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
};

function effectivePolicyLabel(view: AgentControlsView): string {
  if (view.policy.effectiveVersion === null || view.policy.effectiveMode === null || view.policy.paused === null) {
    return 'Effective policy unknown';
  }
  const modeLabel = view.policy.effectiveMode === 'review' ? 'Review required' : 'Automatic delivery';
  const pauseLabel = view.policy.paused ? ', paused' : '';
  return `${modeLabel}${pauseLabel} (v${view.policy.effectiveVersion})`;
}

/**
 * A pause request changes future delivery policy only. It is never a claim that
 * an in-flight model turn stopped or was cancelled (KTD3) — the wording here is
 * deliberately scoped to "delivery" and "requested", never "stopped"/"cancelled".
 */
function requestedPolicyLabel(view: AgentControlsView): string | null {
  if (view.policy.requestedMode === null || view.policy.requestedVersion === null) return null;
  const suffix = view.policy.acknowledgment === 'offline'
    ? ' — connector offline, request pending'
    : view.policy.acknowledgment === 'rejected'
      ? ' — request rejected'
      : view.policy.acknowledgment === 'pending'
        ? ' — request pending'
        : ' — confirmed';
  return `Requested: review, pause requested (v${view.policy.requestedVersion})${suffix}`;
}

export function AgentControlsPanel({ ports, config, controller: injectedController }: AgentControlsPanelProps) {
  const ownController = useMemo(() => createAgentControlsController(ports, config), [ports, config]);
  const controller = injectedController ?? ownController;
  const [view, setView] = useState<AgentControlsView>(() => controller.getView());

  useEffect(() => {
    setView(controller.getView());
    return controller.subscribe(setView);
  }, [controller]);
  useEffect(() => () => controller.dispose(), [controller]);

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
        <span className="agent-controls__effective">{effectivePolicyLabel(view)}</span>
      </div>

      {requestedLabel ? (
        <p className="agent-controls__requested" role="status">
          <StatusBadge tone={ACKNOWLEDGMENT_TONE[view.policy.acknowledgment]} label={requestedLabel} />
        </p>
      ) : null}

      <div className="agent-controls__actions">
        <button
          type="button"
          className="agent-controls__pause-button"
          disabled={!view.controlsAvailable}
          onClick={() => controller.requestPause(nextPaused)}
        >
          {nextPaused ? 'Request pause' : 'Resume automatic review delivery'}
        </button>
      </div>

      {!view.controlsAvailable && view.unavailableReason ? (
        <p className="agent-controls__notice" role="note">{view.unavailableReason}</p>
      ) : null}

      {view.receiptDetail ? (
        <p className="agent-controls__receipt">{view.receiptDetail}</p>
      ) : null}
    </Panel>
  );
}
