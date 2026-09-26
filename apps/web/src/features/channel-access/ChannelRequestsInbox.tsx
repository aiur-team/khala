import { useEffect, useRef, useState } from 'react';
import { Panel } from '../../shell/Panel';
import { DecisionDialog } from '../approval-decision/DecisionDialog';
import type { ChannelAccessInboxController } from './controller';
import {
  connectionLabel,
  decisionLabel,
  muteActionLabel,
  operationLabel,
  pendingRequests,
  recentRequests,
  subjectLabel,
  toDecisionPrompt,
  type InboxNotice,
  type InboxStatus,
  type InboxView,
  type OwnerRequest,
} from './model';

/** Subscribes a component to the shared inbox controller. */
export function useInboxView(controller: ChannelAccessInboxController): InboxView {
  const [view, setView] = useState<InboxView>(() => controller.getView());
  useEffect(() => {
    setView(controller.getView());
    return controller.subscribe(setView);
  }, [controller]);
  return view;
}

export interface ChannelRequestsInboxProps {
  /** Shared with the navigation entry; the host starts and disposes it. */
  controller: ChannelAccessInboxController;
  /** A request handle from direct navigation (a deep link). Selects the row; never opens it. */
  selectedHandle?: string | null | undefined;
}

const MUTE_FAILURE: Readonly<Record<string, string>> = {
  forbidden: 'You no longer own this channel, so its mute could not change.',
  not_found: 'That request is no longer available. Nothing was changed.',
  operation_mismatch: 'That change conflicted with an earlier one. Nothing was changed.',
  unavailable: 'Could not reach the server. Nothing was changed; try again.',
  unknown: 'Could not confirm whether that change was saved. The list has been refreshed; check it and try again if needed.',
};

function statusMessage(status: InboxStatus): string {
  switch (status.kind) {
    case 'idle':
      return '';
    case 'muted':
      if (status.operationKind === 'access') {
        return status.muted
          ? 'Muted. This agent’s new requests for this channel will not reach you.'
          : 'Unmuted. This agent can request this channel again.';
      }
      return status.muted
        ? 'Muted. This agent’s new channel-creation requests will not reach you.'
        : 'Unmuted. This agent can ask you to create channels again.';
    case 'mute_refreshed':
      return 'Mute settings changed in another window. They have been reloaded; nothing was changed.';
    case 'mute_failed':
      return MUTE_FAILURE[status.code] ?? 'Nothing was changed.';
    case 'authority_lost':
      return 'You can no longer decide these requests. Only the current channel owner can.';
    case 'refresh_failed':
      return 'Could not refresh channel requests. Showing the last list.';
  }
}

function noticeText(notice: InboxNotice): string {
  return notice.requestHandle === null ? `${notice.count} new channel requests` : 'New channel request';
}

const rowId = (handle: string) => `channel-request-${handle}`;

export function ChannelRequestsInbox({ controller, selectedHandle }: ChannelRequestsInboxProps) {
  const view = useInboxView(controller);
  const pendingHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const handledSequence = useRef(0);

  useEffect(() => {
    if (selectedHandle !== undefined) controller.select(selectedHandle);
  }, [controller, selectedHandle]);

  useEffect(() => {
    // Notification selection and direct navigation land on the same row.
    // Focus moves only because the owner asked to go there.
    if (view.phase !== 'ready' || view.selectionSequence === handledSequence.current) return;
    handledSequence.current = view.selectionSequence;
    const target = view.selected === null ? pendingHeadingRef.current : document.getElementById(rowId(view.selected));
    (target ?? pendingHeadingRef.current)?.focus();
    target?.scrollIntoView?.({ block: 'nearest' });
  }, [view.phase, view.selected, view.selectionSequence]);

  const pending = pendingRequests(view.requests);
  const recent = recentRequests(view.requests);
  const selectedMissing = view.phase === 'ready' && view.selected !== null
    && !view.requests.some(request => request.requestHandle === view.selected);
  const busy = view.phase === 'loading' ? 'Loading channel requests…' : '';
  const status = busy || (selectedMissing ? 'That request is no longer available.' : statusMessage(view.status));

  function renderRow(request: OwnerRequest) {
    const isPending = request.outcome === 'pending_owner';
    const selected = view.selected === request.requestHandle;
    return (
      <li
        key={request.requestHandle}
        id={rowId(request.requestHandle)}
        tabIndex={-1}
        className={`channel-requests__row${selected ? ' channel-requests__row--selected' : ''}`}
        aria-current={selected ? 'true' : undefined}
        aria-labelledby={`${rowId(request.requestHandle)}-subject`}
      >
        <p className="channel-requests__kind">{operationLabel(request)}</p>
        <p id={`${rowId(request.requestHandle)}-subject`} className="channel-requests__subject">{subjectLabel(request)}</p>
        <p className="channel-requests__fingerprint">
          <span className="channel-requests__fact-label">Session fingerprint</span> <code>{request.requester.sessionFingerprint}</code>
        </p>
        <p className="channel-requests__harness">
          <span className="channel-requests__fact-label">Harness</span> {request.requester.harness}
        </p>
        <UntrustedLabels request={request} />
        <dl className="channel-requests__state">
          <dt>Your decision</dt>
          <dd>{decisionLabel(request)}</dd>
          <dt>Agent connection</dt>
          <dd>{connectionLabel(request)}</dd>
        </dl>
        <div className="channel-requests__actions">
          {/* Never disabled: the dialog returns focus here when it closes. */}
          <button type="button" onClick={() => controller.open(request.requestHandle)}>
            {isPending ? 'Review request' : 'View details'}
          </button>
          <button
            type="button"
            onClick={() => controller.toggleMute(request.requestHandle)}
            disabled={view.readOnly || view.muting !== null}
            aria-pressed={request.muted}
          >
            {muteActionLabel(request)}
          </button>
        </div>
      </li>
    );
  }

  const dialog = view.dialog;
  return (
    <Panel heading="Channel requests">
      <div className="channel-requests" aria-busy={view.phase === 'loading'}>
        <p role="status" aria-live="polite" className="channel-requests__status">{status}</p>

        <section className="channel-requests__notices" aria-label="Channel request notifications" aria-live="polite">
          {view.notices.map(notice => (
            <div key={notice.notificationId} className="channel-requests__notice">
              <p>{noticeText(notice)}</p>
              <button type="button" onClick={() => controller.openNotice(notice.notificationId)}>
                Show in inbox
              </button>
              <button type="button" onClick={() => controller.dismissNotice(notice.notificationId)}>
                Dismiss notification
              </button>
            </div>
          ))}
        </section>

        {view.phase === 'load_failed' ? (
          <div role="alert">
            <p>{view.readOnly ? statusMessage({ kind: 'authority_lost' }) : 'Could not load channel requests.'}</p>
            <button type="button" onClick={() => controller.refresh()}>
              Reload requests
            </button>
          </div>
        ) : null}

        {view.phase === 'ready' ? (
          <>
            <section aria-labelledby="channel-requests-pending-heading">
              <h3 id="channel-requests-pending-heading" ref={pendingHeadingRef} tabIndex={-1}>
                Waiting for you ({pending.length})
              </h3>
              {pending.length === 0 ? (
                <p>No requests are waiting for you.</p>
              ) : (
                <ul className="channel-requests__list" aria-label="Requests waiting for you">
                  {pending.map(renderRow)}
                </ul>
              )}
            </section>

            <section aria-labelledby="channel-requests-recent-heading">
              <h3 id="channel-requests-recent-heading">Recent</h3>
              <p className="channel-requests__hint">Details of a finished request are removed 30 days after it ends.</p>
              {recent.length === 0 ? (
                <p>No recent requests.</p>
              ) : (
                <ul className="channel-requests__list" aria-label="Recent requests">
                  {recent.map(renderRow)}
                </ul>
              )}
            </section>

            {view.rejectedCount > 0 ? (
              <p className="channel-requests__hint">
                {view.rejectedCount === 1 ? '1 request' : `${view.rejectedCount} requests`} could not be shown safely and{' '}
                {view.rejectedCount === 1 ? 'was' : 'were'} left out.
              </p>
            ) : null}
          </>
        ) : null}

        {dialog !== null ? (
          <DecisionDialog
            key={dialog.handle}
            id="channel-request-dialog"
            prompt={toDecisionPrompt(dialog.request)}
            status={dialog.status}
            onDecide={choice => controller.decide(choice)}
            onRetry={() => controller.retry()}
            onDismiss={() => controller.close()}
            restoreFocus={() => (document.getElementById(rowId(dialog.handle)) ?? pendingHeadingRef.current)?.focus()}
            secondary={(
              <button
                type="button"
                onClick={() => controller.toggleMute(dialog.handle)}
                disabled={view.readOnly || view.muting !== null}
                aria-pressed={dialog.request.muted}
              >
                {muteActionLabel(dialog.request)}
              </button>
            )}
          />
        ) : null}
      </div>
    </Panel>
  );
}

function UntrustedLabels({ request }: { request: OwnerRequest }) {
  const { displayLabel, workspaceLabel } = request.requester;
  const proposed = request.detail.kind === 'create' ? request.detail.proposedTitle : null;
  if (displayLabel === null && workspaceLabel === null && proposed === null) return null;
  return (
    <dl className="channel-requests__untrusted">
      {displayLabel !== null ? (
        <>
          <dt>Name (reported by the agent, unverified)</dt>
          <dd><bdi>{displayLabel}</bdi></dd>
        </>
      ) : null}
      {workspaceLabel !== null ? (
        <>
          <dt>Workspace (reported by the agent, unverified)</dt>
          <dd><bdi>{workspaceLabel}</bdi></dd>
        </>
      ) : null}
      {proposed !== null ? (
        <>
          <dt>Proposed title (from the agent, unverified)</dt>
          <dd><bdi>{proposed}</bdi></dd>
        </>
      ) : null}
    </dl>
  );
}
