import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { ChannelVisibility, RoomId } from '@khala/contracts/messaging/index';
import { Panel } from '../../shell/Panel';
import { createChannelSettingsController, type ChannelSettingsController } from './controller';
import { PREVIEW_LISTING_REF, type ChannelSettingsStatus, type ChannelSettingsView, type ListingPreview } from './model';
import type { AllowlistedAgent, ChannelSettingsPorts, KnownPrincipalSource } from './ports';

export interface ChannelSettingsPanelProps {
  ports: ChannelSettingsPorts;
  roomId: RoomId;
  /** Test-only seam: a pre-built controller. */
  controller?: ChannelSettingsController;
}

const VISIBILITY_OPTIONS: readonly Readonly<{ value: ChannelVisibility; label: string; description: string }>[] = [
  {
    value: 'secret',
    label: 'Secret',
    description: 'Never listed. An agent needs this channel’s URL, and you still approve every request.',
  },
  {
    value: 'private',
    label: 'Private',
    description: 'Listed only to your own agent sessions and the verified agents you allow below. You still approve every request.',
  },
  {
    value: 'public',
    label: 'Public',
    description: 'Listed to any verified agent signed in to this Khala service. You still approve every request.',
  },
];

const VISIBILITY_LABEL: Readonly<Record<ChannelVisibility, string>> = { secret: 'Secret', private: 'Private', public: 'Public' };

const AUDIENCE: Readonly<Record<ChannelVisibility, string>> = {
  secret: 'no agent',
  private: 'your own agent sessions and the agents you allow',
  public: 'every verified agent on this Khala service',
};

const SOURCE_LABEL: Readonly<Record<KnownPrincipalSource, string>> = {
  own_session: 'Your agent session',
  pairing: 'Completed pairing',
  approved_access: 'Previously approved access',
};

const FAILURE_MESSAGE: Readonly<Record<string, string>> = {
  unavailable: 'Could not reach the server. Nothing was saved.',
  public_discovery_disabled: 'Public listing is not enabled on this service. Nothing was saved.',
  operation_mismatch: 'That change conflicted with an earlier request. Nothing was saved; try again.',
  invalid_title: 'The server refused that listed title. Nothing was saved.',
};

function statusMessage(status: ChannelSettingsStatus): string {
  switch (status.kind) {
    case 'idle':
      return '';
    case 'saved':
      return `Saved. This channel is now ${VISIBILITY_LABEL[status.visibility].toLowerCase()}.`;
    case 'allowed':
      return `Saved. Agent ${status.fingerprint} can now see this channel’s listing.`;
    case 'revoked':
      return `Saved. Agent ${status.fingerprint} can no longer see this channel’s listing.`;
    case 'stale_refreshed':
      return 'This channel’s settings changed elsewhere. They have been reloaded; nothing was saved. Review them and try again.';
    case 'authority_lost':
      return 'You no longer manage this channel. Its settings are read-only.';
    case 'failed':
      return FAILURE_MESSAGE[status.code] ?? `Nothing was saved (${status.code}).`;
  }
}

function busyMessage(view: ChannelSettingsView): string {
  if (view.phase === 'loading') return 'Loading channel settings…';
  if (view.phase !== 'submitting' || view.pending === null) return '';
  if (view.pending.kind === 'visibility') return `Saving: changing visibility to ${VISIBILITY_LABEL[view.pending.visibility].toLowerCase()}…`;
  if (view.pending.kind === 'allow') return `Saving: allowing agent ${view.pending.agent.fingerprint}…`;
  return `Saving: removing agent ${view.pending.agent.fingerprint}…`;
}

function UntrustedLabels({ agent }: { agent: Pick<AllowlistedAgent, 'displayLabel' | 'workspaceLabel'> }) {
  if (agent.displayLabel === null && agent.workspaceLabel === null) return null;
  return (
    <dl className="channel-settings__untrusted">
      {agent.displayLabel !== null ? (
        <>
          <dt>Name (reported by the agent, unverified)</dt>
          <dd>{agent.displayLabel}</dd>
        </>
      ) : null}
      {agent.workspaceLabel !== null ? (
        <>
          <dt>Workspace (reported by the agent, unverified)</dt>
          <dd>{agent.workspaceLabel}</dd>
        </>
      ) : null}
    </dl>
  );
}

function Preview({ preview }: { preview: ListingPreview }) {
  if (preview.kind === 'not_listed') {
    return <p className="channel-settings__preview-empty">Not listed. No agent receives anything about this channel from discovery.</p>;
  }
  if (preview.kind === 'invalid_title') {
    return <p className="channel-settings__preview-empty">Enter a valid listed title to see what agents would receive.</p>;
  }
  const { listing } = preview;
  return (
    <>
      <dl className="channel-settings__projection">
        <dt>title</dt>
        <dd className="channel-settings__projection-title">{listing.title}</dd>
        <dt>visibility</dt>
        <dd>{listing.visibility}</dd>
        <dt>serviceKind</dt>
        <dd>{listing.serviceKind}</dd>
        <dt>requestState</dt>
        <dd>{listing.requestState} (per agent)</dd>
        <dt>listingRef</dt>
        <dd>{listing.listingRef === PREVIEW_LISTING_REF ? 'opaque, short-lived, issued separately to each agent' : listing.listingRef}</dd>
      </dl>
      <p className="channel-settings__preview-note">
        That is everything. Agents do not see who owns or is in the channel, member counts, activity, topic, or any message
        until you approve them.
      </p>
    </>
  );
}

export function ChannelSettingsPanel({ ports, roomId, controller: injectedController }: ChannelSettingsPanelProps) {
  const ownController = useMemo(() => createChannelSettingsController(ports, roomId), [ports, roomId]);
  const controller = injectedController ?? ownController;
  const [view, setView] = useState<ChannelSettingsView>(() => controller.getView());
  const confirmRef = useRef<HTMLDivElement | null>(null);
  const visibilityRef = useRef<HTMLFieldSetElement | null>(null);
  const wasConfirming = useRef(false);

  useEffect(() => {
    setView(controller.getView());
    const dispose = controller.subscribe(setView);
    controller.load();
    return dispose;
  }, [controller]);
  useEffect(() => () => controller.dispose(), [controller]);

  useEffect(() => {
    // Focus follows the confirmation in, starting on the keep-current choice,
    // and returns to the selected visibility once the dialog closes.
    if (view.phase === 'confirming') {
      confirmRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
      wasConfirming.current = true;
    } else if (wasConfirming.current && view.phase === 'editing') {
      visibilityRef.current?.querySelector<HTMLInputElement>('input:checked')?.focus();
      wasConfirming.current = false;
    }
  }, [view.phase]);

  const saved = view.saved;
  const editable = view.phase === 'editing' && !view.readOnly && saved !== null;
  const locked = view.phase === 'submitting' || view.phase === 'confirming';
  const dirty = saved !== null
    && (view.draftVisibility !== saved.visibility || (view.draftVisibility !== 'secret' && view.draftTitle.trim() !== saved.listedTitle));
  const pendingVisibility = view.pending?.kind === 'visibility' ? view.pending : null;
  const allowlisted = new Set(saved?.allowlist.map(agent => agent.principal) ?? []);
  const canEditAllowlist = editable && saved?.visibility === 'private' && saved.revision !== null;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    controller.save();
  }

  function handleConfirmKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      controller.cancel();
    }
  }

  const status = statusMessage(view.status);
  const busy = busyMessage(view);

  return (
    <Panel heading="Channel discovery">
      <div className="channel-settings" aria-busy={view.phase === 'loading' || view.phase === 'submitting'}>
        <p aria-live="polite" role="status" className="channel-settings__status">
          {busy || status}
        </p>

        {view.phase === 'load_failed' ? (
          <div role="alert">
            <p>{view.status.kind === 'authority_lost' ? statusMessage(view.status) : 'Could not load this channel’s settings.'}</p>
            <button type="button" onClick={() => controller.load()}>
              Reload settings
            </button>
          </div>
        ) : null}

        {saved !== null ? (
          <>
            <p className="channel-settings__current">
              Currently <strong>{VISIBILITY_LABEL[saved.visibility]}</strong>: listed to {AUDIENCE[saved.visibility]}.
              {view.readOnly ? ' You can view these settings but not change them.' : ''}
            </p>

            <form onSubmit={handleSubmit}>
              <fieldset ref={visibilityRef} className="channel-settings__visibility" disabled={!editable}>
                <legend>Who can find this channel</legend>
                {VISIBILITY_OPTIONS.map(option => {
                  const unavailableOption = option.value === 'public' && saved.publicDiscovery !== 'enabled';
                  return (
                    <label key={option.value} className="channel-settings__option">
                      <input
                        type="radio"
                        name="channel-settings-visibility"
                        value={option.value}
                        checked={view.draftVisibility === option.value}
                        disabled={unavailableOption}
                        aria-describedby={`channel-settings-visibility-${option.value}`}
                        onChange={() => controller.setVisibility(option.value)}
                      />
                      <span>
                        <span className="channel-settings__option-label">{option.label}</span>
                        <span id={`channel-settings-visibility-${option.value}`} className="channel-settings__option-description">
                          {unavailableOption ? 'Public listing is not enabled on this Khala service yet.' : option.description}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </fieldset>

              {view.draftVisibility !== 'secret' ? (
                <div className="channel-settings__field">
                  <label htmlFor="channel-settings-title">Listed title</label>
                  <input
                    id="channel-settings-title"
                    type="text"
                    value={view.draftTitle}
                    disabled={!editable}
                    aria-invalid={view.titleError !== null}
                    aria-describedby={view.titleError !== null ? 'channel-settings-title-error' : 'channel-settings-title-hint'}
                    onChange={event => controller.setTitle(event.target.value)}
                  />
                  {view.titleError !== null ? (
                    <p role="alert" id="channel-settings-title-error">
                      {view.titleError === 'title_required' ? 'A listed channel needs a title.' : 'That title is too long or not allowed.'}
                    </p>
                  ) : (
                    <p id="channel-settings-title-hint" className="channel-settings__hint">
                      Agents that can list this channel see this title. A distinctive title can identify the channel.
                    </p>
                  )}
                </div>
              ) : null}

              <section className="channel-settings__preview" aria-labelledby="channel-settings-preview-heading">
                <h3 id="channel-settings-preview-heading">What an eligible agent sees before joining</h3>
                <Preview preview={view.preview} />
              </section>

              <button type="submit" disabled={!editable || !dirty}>
                Save visibility
              </button>
              {dirty && editable ? <p className="channel-settings__hint">Unsaved changes.</p> : null}
            </form>

            {view.phase === 'confirming' && pendingVisibility ? (
              <div
                ref={confirmRef}
                role="alertdialog"
                aria-modal="false"
                aria-labelledby="channel-settings-confirm-heading"
                aria-describedby="channel-settings-confirm-body"
                className="channel-settings__confirm"
                onKeyDown={handleConfirmKey}
              >
                <h3 id="channel-settings-confirm-heading">
                  Make this channel {VISIBILITY_LABEL[pendingVisibility.visibility].toLowerCase()}?
                </h3>
                <p id="channel-settings-confirm-body">
                  {AUDIENCE[pendingVisibility.visibility][0]!.toUpperCase() + AUDIENCE[pendingVisibility.visibility].slice(1)} will
                  be able to see the title “{pendingVisibility.title}” and request access. No agent joins without your approval.
                </p>
                <div className="channel-settings__confirm-actions">
                  <button type="button" onClick={() => controller.cancel()}>
                    Keep {VISIBILITY_LABEL[saved.visibility].toLowerCase()}
                  </button>
                  <button type="button" onClick={() => controller.confirm()}>
                    Make {VISIBILITY_LABEL[pendingVisibility.visibility].toLowerCase()}
                  </button>
                </div>
              </div>
            ) : null}

            {view.status.kind === 'failed' && view.status.retryable && view.pending !== null && view.phase === 'editing' ? (
              <div role="alert" className="channel-settings__retry">
                <p>{statusMessage(view.status)} Your change is still pending.</p>
                <button type="button" onClick={() => controller.retry()}>
                  Retry
                </button>
              </div>
            ) : null}

            <section className="channel-settings__allowlist" aria-labelledby="channel-settings-allowlist-heading">
              <h3 id="channel-settings-allowlist-heading">Allowed agents</h3>
              <p className="channel-settings__hint">
                Allowed agents can see this channel’s listing while it is private. Identify each agent by its verified
                fingerprint; names and workspaces are reported by the agent and can be copied.
              </p>
              {saved.allowlist.length === 0 ? (
                <p>No agents are allowed yet.</p>
              ) : (
                <ul className="channel-settings__agents" aria-label="Allowed agents">
                  {saved.allowlist.map(agent => (
                    <li key={agent.principal} className="channel-settings__agent">
                      <p className="channel-settings__fingerprint">
                        <span className="channel-settings__fingerprint-label">Verified fingerprint</span> <code>{agent.fingerprint}</code>
                      </p>
                      <UntrustedLabels agent={agent} />
                      <button
                        type="button"
                        disabled={!editable || saved.revision === null || locked}
                        onClick={() => controller.revoke(agent.principal)}
                      >
                        Remove agent {agent.fingerprint}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <h4>Add a verified agent</h4>
              {saved.visibility !== 'private' ? (
                <p className="channel-settings__hint">Save this channel as private to allow specific agents.</p>
              ) : null}
              <Picker
                view={view}
                allowlisted={allowlisted}
                enabled={canEditAllowlist}
                onAllow={principal => controller.allow(principal)}
                onReload={() => controller.load()}
              />
            </section>
          </>
        ) : null}
      </div>
    </Panel>
  );
}

function Picker({
  view, allowlisted, enabled, onAllow, onReload,
}: {
  view: ChannelSettingsView;
  allowlisted: ReadonlySet<string>;
  enabled: boolean;
  onAllow: (principal: string) => void;
  onReload: () => void;
}) {
  if (view.picker.kind === 'loading') return <p>Loading your verified agents…</p>;
  if (view.picker.kind === 'failed') {
    return (
      <p>
        Could not load your verified agents.{' '}
        <button type="button" onClick={onReload}>
          Reload
        </button>
      </p>
    );
  }
  if (view.picker.principals.length === 0) {
    return (
      <div className="channel-settings__picker-empty">
        <p>No verified agents are known to your account yet.</p>
        <p>
          An agent appears here after you run its session yourself and sign in to authorize it, complete a pairing with it,
          or approve one of its access requests. To reach any other agent, share this channel’s URL instead; you still
          approve its request.
        </p>
      </div>
    );
  }
  return (
    <ul className="channel-settings__agents" aria-label="Your verified agents">
      {view.picker.principals.map(agent => {
        const already = allowlisted.has(agent.principal);
        return (
          <li key={agent.principal} className="channel-settings__agent">
            <p className="channel-settings__fingerprint">
              <span className="channel-settings__fingerprint-label">Verified fingerprint</span> <code>{agent.fingerprint}</code>
            </p>
            <p className="channel-settings__source">Known from: {SOURCE_LABEL[agent.source]}</p>
            <UntrustedLabels agent={agent} />
            {already ? (
              <p className="channel-settings__hint">Already allowed.</p>
            ) : (
              <button type="button" disabled={!enabled} onClick={() => onAllow(agent.principal)}>
                Allow agent {agent.fingerprint}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
