// Presentational join screen. Controlled entirely by `view`: it never imports
// a port, never navigates, and never renders content this ticket has not
// been handed through `JoinView`. Wiring `createJoinController` to this
// component (calling `start`, `signIn`, `retry`) is a composition concern
// owned outside this file.

import { KhalaPageFrame } from '../../shell/KhalaPageFrame';
import { Panel } from '../../shell/Panel';
import { StatusBadge } from '../../shell/StatusBadge';
import type { JoinPhase, JoinView } from './model';

export interface JoinScreenProps {
  view: JoinView;
  onSignIn: () => void;
  onRetry: () => void;
  onOpenRoom?: (roomId: string) => void;
}

const BUSY_PHASES: readonly JoinPhase[] = ['checking_identity', 'checking_invitation', 'initializing_device', 'joining'];

const BUSY_COPY: Partial<Record<JoinPhase, string>> = {
  checking_identity: 'Checking your sign-in…',
  checking_invitation: 'Checking this invitation…',
  initializing_device: 'Getting your device ready…',
  joining: 'Joining the channel…',
};

const OUTCOME_COPY: Partial<Record<JoinPhase, { heading: string; body: string }>> = {
  expired: { heading: 'This invitation expired', body: 'Ask whoever shared this link for a new one.' },
  revoked: { heading: 'This invitation was revoked', body: 'Access to this channel is no longer available through this link.' },
  wrong_account: { heading: 'Wrong account', body: 'This invitation is not for the account you are signed in as.' },
  unavailable: { heading: 'Something did not load', body: 'This did not complete. You can try again.' },
};

export function JoinScreen({ view, onSignIn, onRetry, onOpenRoom }: JoinScreenProps) {
  const banner = view.email ? <span>Signed in as {view.email}</span> : null;

  const statusMessage = BUSY_COPY[view.phase];

  return (
    <KhalaPageFrame model={{ title: 'Join', labelledBy: 'join-heading' }} banner={banner}>
      <Panel
        heading="Join this channel"
        status={BUSY_PHASES.includes(view.phase) ? 'busy' : 'idle'}
        {...(statusMessage !== undefined ? { statusMessage } : {})}
      >
        {view.phase === 'sign_in' ? <SignIn onSignIn={onSignIn} /> : null}
        {view.phase === 'joined' ? <Joined roomId={view.roomId} {...(onOpenRoom ? { onOpenRoom } : {})} /> : null}
        {OUTCOME_COPY[view.phase] ? (
          <Outcome
            heading={OUTCOME_COPY[view.phase]!.heading}
            body={OUTCOME_COPY[view.phase]!.body}
            retryAllowed={view.retryAllowed}
            onRetry={onRetry}
          />
        ) : null}
      </Panel>
    </KhalaPageFrame>
  );
}

function SignIn({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div className="join-sign-in">
      <p>Sign in to accept this invitation.</p>
      <button type="button" onClick={onSignIn}>
        Sign in
      </button>
    </div>
  );
}

function Joined({ roomId, onOpenRoom }: { roomId: string | null; onOpenRoom?: (roomId: string) => void }) {
  return (
    <div className="join-joined" role="status">
      <StatusBadge tone="positive" label="Joined" />
      <p>You&apos;re in.</p>
      {roomId ? <p className="join-joined__room-id">Channel: {roomId}</p> : null}
      {roomId && onOpenRoom ? <button type="button" onClick={() => onOpenRoom(roomId)}>Open channel</button> : null}
    </div>
  );
}

function Outcome({
  heading,
  body,
  retryAllowed,
  onRetry,
}: {
  heading: string;
  body: string;
  retryAllowed: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="join-outcome" role="alert">
      <StatusBadge tone="critical" label={heading} />
      <p>{body}</p>
      {retryAllowed ? (
        <button type="button" onClick={onRetry} autoFocus>
          Try again
        </button>
      ) : null}
    </div>
  );
}
