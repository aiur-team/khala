import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Panel } from '../../shell/Panel';
import { createCreateChannelController, type CreateChannelController, type CreateChannelMode } from './controller';
import type { CreateChannelView } from './model';
import type { CreateChannelPorts } from './ports';
import { copyShareLink, type CopyResult } from './share-link';

export interface CreateChannelScreenProps {
  ports: CreateChannelPorts;
  /** Injected for tests and for hosts that supply their own clipboard bridge. */
  onCopyShareLink?: (shareUrl: string) => Promise<CopyResult>;
  onOpenRoom?: (roomId: string) => void;
  /** `on_demand` opens the hosted channel before sharing; `private` skips admission. */
  mode?: CreateChannelMode;
  /** Test-only seam: a pre-built controller (for example one already driven to a target phase). */
  controller?: CreateChannelController;
}

/** @deprecated Use `CreateChannelScreenProps`. Kept through the first tagged release containing #163. */
export type CreateChatScreenProps = CreateChannelScreenProps;

type Readiness = Readonly<{ kind: 'checking' } | { kind: 'blocked'; reason: string } | { kind: 'ready' }>;

// Distinct from the "-ing" busy phases below: `resolving` means the last attempt's
// outcome is unknown and idle, waiting on an explicit Retry — never an ongoing action.
const RESOLVING_MESSAGE = 'The last step did not confirm. Retry to find out what happened.';
const BUSY_MESSAGE: Partial<Record<CreateChannelView['phase'], string>> = {
  creating: 'Creating the channel…',
  sharing: 'Preparing the share link…',
  resolving: RESOLVING_MESSAGE,
};

export function CreateChannelScreen({
  ports, onCopyShareLink = copyShareLink, onOpenRoom, mode = 'shared', controller: injectedController,
}: CreateChannelScreenProps) {
  const ownController = useMemo(() => createCreateChannelController(ports, { mode }), [mode, ports]);
  const controller = injectedController ?? ownController;
  const [view, setView] = useState<CreateChannelView>(() => controller.getView());
  const [readiness, setReadiness] = useState<Readiness>({ kind: 'checking' });
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'denied'>('idle');

  useEffect(() => {
    // Sync immediately: a controller swap (new `ports`, e.g. a sign-out or
    // account change) must not leave the previous controller's stale view —
    // including a completed share link — rendered until it next emits.
    setView(controller.getView());
    return controller.subscribe(setView);
  }, [controller]);
  useEffect(() => () => controller.dispose(), [controller]);

  useEffect(() => {
    let cancelled = false;
    async function checkReadiness() {
      try {
        const identity = await ports.identity.current();
        if (cancelled) return;
        if (identity.kind === 'signed_out') {
          // A private composition has no sign-in; its session can only be relaunched.
          setReadiness({
            kind: 'blocked',
            reason: mode === 'private' ? 'This session has ended. Relaunch Khala to create a channel.' : 'Sign in to create a channel.',
          });
          return;
        }
        if (identity.kind === 'unavailable') {
          setReadiness({ kind: 'blocked', reason: 'Account status is unavailable right now. Try again shortly.' });
          return;
        }
        const device = await ports.device.ensureReady(identity.principal.ownerId);
        if (cancelled) return;
        if (device.kind !== 'ok' || device.value.state !== 'ready') {
          setReadiness({ kind: 'blocked', reason: 'This device is not ready yet.' });
          return;
        }
        setReadiness({ kind: 'ready' });
      } catch {
        if (!cancelled) setReadiness({ kind: 'blocked', reason: 'Account status is unavailable right now. Try again shortly.' });
      }
    }
    void checkReadiness();
    return () => {
      cancelled = true;
    };
  }, [mode, ports]);

  useEffect(() => {
    setCopyStatus('idle');
  }, [view.shareUrl]);

  useEffect(() => {
    if (view.phase === 'ready' && view.roomId !== null) onOpenRoom?.(view.roomId);
  }, [mode, onOpenRoom, view.phase, view.roomId]);

  const editable = view.phase === 'editing';
  const retryable = view.phase === 'failed' || view.phase === 'resolving';
  const canSubmit = editable && readiness.kind === 'ready';
  const busyMessage = BUSY_MESSAGE[view.phase];

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    controller.submit();
  }

  async function handleCopy() {
    if (!view.shareUrl) return;
    const result = await onCopyShareLink(view.shareUrl);
    setCopyStatus(result.ok ? 'copied' : 'denied');
  }

  return (
    <Panel heading="Create a channel">
      <form onSubmit={handleSubmit}>
        <div className="create-channel__field">
          <label htmlFor="create-channel-title">Channel name (optional)</label>
          <input
            id="create-channel-title"
            type="text"
            value={view.title}
            disabled={!editable}
            aria-invalid={view.titleError !== null}
            aria-describedby={view.titleError !== null ? 'create-channel-title-error' : undefined}
            onChange={event => controller.setTitle(event.target.value)}
          />
          {view.titleError !== null ? (
            <p role="alert" id="create-channel-title-error">
              {view.titleError === 'title_too_long'
                ? 'That name is too long.'
                : view.titleError === 'title_invalid'
                  ? 'That name contains characters that aren’t allowed.'
                  : view.titleError}
            </p>
          ) : null}
        </div>

        {readiness.kind === 'blocked' ? <p role="alert">{readiness.reason}</p> : null}
        <button type="submit" disabled={!canSubmit}>
          Create channel
        </button>
      </form>

      {mode !== 'private' && readiness.kind === 'ready' ? (
        <p>
          Want your agent to request the channel instead?{' '}
          <a href="/api/human/channel-discovery/authority/create-target">Copy an agent creation link</a>
          {' '}and give it to that exact session. You will approve its request before a channel is created.
        </p>
      ) : null}

      <p aria-live="polite" className="create-channel__status">
        {busyMessage ?? (mode === 'private' && view.phase === 'ready' ? 'Channel created. Opening it…' : '')}
      </p>

      {view.errorCode ? (
        <p role="alert">
          {view.roomId !== null
            ? `Could not prepare the share link (${view.errorCode}).`
            : `Could not finish creating the channel (${view.errorCode}).`}{' '}
          {retryable ? (
            <button type="button" onClick={() => controller.retry()}>
              Retry
            </button>
          ) : null}
        </p>
      ) : null}
      {!view.errorCode && view.phase === 'resolving' ? (
        <button type="button" onClick={() => controller.retry()}>
          Retry
        </button>
      ) : null}

      {mode === 'shared' && view.roomId && retryable && onOpenRoom ? (
        <button type="button" onClick={() => onOpenRoom(view.roomId!)}>
          Open created channel
        </button>
      ) : null}

      {view.phase === 'ready' && view.shareUrl ? (
        <div className="create-channel__share">
          <label htmlFor="create-channel-share-url">Channel link</label>
          <input
            id="create-channel-share-url"
            className="create-channel__share-url"
            readOnly
            value={view.shareUrl}
            onFocus={event => event.currentTarget.select()}
          />
          <button type="button" onClick={handleCopy}>
            Copy link
          </button>
          {view.roomId && onOpenRoom ? (
            <button type="button" onClick={() => onOpenRoom(view.roomId!)}>
              Open channel
            </button>
          ) : null}
          <p role="status">
            {copyStatus === 'copied' ? 'Link copied.' : copyStatus === 'denied' ? 'Copy failed — select and copy the link above.' : ''}
          </p>
        </div>
      ) : null}
    </Panel>
  );
}

/** @deprecated Use `CreateChannelScreen`. Kept through the first tagged release containing #163. */
export const CreateChatScreen = CreateChannelScreen;
