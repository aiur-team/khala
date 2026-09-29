import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import type { ListeningController } from './listening-controller';
import { LISTENING_MODE_NAMES, grantableRoute, modeOffered } from './listening-port';

export function LocalAgentControls({ controller }: Readonly<{ controller: ListeningController }>) {
  const view = useSyncExternalStore(controller.subscribe, controller.getView, controller.getView);
  const [openId, setOpenId] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const popover = useRef<HTMLDivElement | null>(null);
  const binding = view.bindings.find(item => item.bindingId === openId);

  useEffect(() => {
    if (binding) popover.current?.querySelector<HTMLElement>('button')?.focus();
  }, [binding?.bindingId]);

  function close() { setOpenId(null); opener.current?.focus(); }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  }

  return <div className="local-agent-controls" aria-label="Agent settings">
    {view.phase === 'failed' ? <span role="alert" className="sr-only">Agent settings unavailable.</span> : null}
    {view.bindings.map(item => <button key={`${item.bindingId}:${item.generation}`} type="button"
      className="local-agent-controls__avatar aiur-shell__icon-button" aria-label={`${item.displayName} settings`}
      title={`${item.displayName} settings`} aria-expanded={openId === item.bindingId}
      onClick={event => { opener.current = event.currentTarget; setOpenId(current => current === item.bindingId ? null : item.bindingId); }}>
      {item.displayName.trim().slice(0, 1).toLocaleUpperCase()}
    </button>)}
    {binding ? <div ref={popover} className="local-agent-controls__popover" role="dialog" aria-label={`${binding.displayName} settings`} onKeyDown={onKeyDown}>
      <button type="button" className="aiur-shell__icon-button" aria-label="Close agent settings" onClick={close}>×</button>
      <h2>{binding.displayName}</h2>
      <p>{binding.paused ? 'Paused' : binding.effective ? `${binding.effective} mode` : 'Mode unavailable'}</p>
      <fieldset disabled={view.busy === binding.bindingId}>
        <legend>Listening mode</legend>
        {LISTENING_MODE_NAMES.map(mode => <label key={mode}>
          <input type="radio" name={`mode-${binding.bindingId}`} value={mode} checked={binding.requested === mode}
            disabled={!modeOffered(binding, mode)} onChange={() => void controller.setMode(binding.bindingId, mode)} />
          {mode[0]!.toUpperCase() + mode.slice(1)}
        </label>)}
      </fieldset>
      <button type="button" disabled={view.busy === binding.bindingId} onClick={() => void controller.setPaused(binding.bindingId, !binding.paused)}>
        {binding.paused ? 'Resume delivery' : 'Pause delivery'}
      </button>
      <details><summary>Mode and experimental details</summary>
        <p>Pause holds new messages; it does not stop work already in progress.</p>
        {LISTENING_MODE_NAMES.map(mode => <div key={mode}><strong>{mode}</strong>: {binding.support[mode].reason ?? binding.support[mode].status}
          {grantableRoute(binding, mode) ? <button type="button" onClick={() => controller.requestGrant(binding.bindingId, mode)}>Review experimental route</button> : null}
          {binding.experimentalGrants.some(grant => grant.mode === mode) ? <button type="button" onClick={() => void controller.revokeGrant(binding.bindingId, mode)}>Revoke experimental route</button> : null}
        </div>)}
      </details>
      {view.confirmation?.bindingId === binding.bindingId ? <div role="group" aria-label="Confirm experimental route">
        <p>Enable {view.confirmation.route.mode} using {view.confirmation.route.route} on version {view.confirmation.route.harnessVersion} (evidence {view.confirmation.route.evidenceRevision})?</p>
        <p>{view.confirmation.missingProof}</p>
        <p>This route is experimental; delivery for this version is not proved.</p>
        <button type="button" onClick={() => void controller.confirmGrant()}>Confirm experimental route</button>
        <button type="button" onClick={() => controller.cancelGrant()}>Cancel</button>
      </div> : null}
      {view.notice ? <p role="status">{view.notice}</p> : null}
      {view.failure ? <p role="alert">{view.notice}</p> : null}
    </div> : null}
  </div>;
}
