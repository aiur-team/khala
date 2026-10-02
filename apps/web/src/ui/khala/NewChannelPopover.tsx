// The New channel popover (RECREATION-SPEC §4.3): a name field and Create.
// Agent-first creation (the "or" row and one-liner) is [M2] and omitted.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { createCreateChannelController, type CreateChannelController } from '../../features/create-channel/controller';
import type { CreateChannelView } from '../../features/create-channel/model';
import type { CreateChannelPorts } from '../../features/create-channel/ports';
import { Popover } from './Popover';
import { useToast } from './Toast';

export type NewChannelPorts = Pick<CreateChannelPorts, 'room' | 'admission' | 'limits'>;

export const UNTITLED_CHANNEL = 'Untitled channel';

/** Creates from the typed name, or resumes a step whose outcome is unknown. */
export function createNewChannel(controller: CreateChannelController, name: string): void {
  const view = controller.getView();
  if (view.phase === 'resolving' || (view.phase === 'failed' && view.roomId !== null)) {
    controller.retry();
    return;
  }
  controller.setTitle(name.trim() || UNTITLED_CHANNEL);
  controller.submit();
}

/** The controller's message for the hint under Create, or `null`. */
export function newChannelError(view: CreateChannelView): string | null {
  if (view.titleError === 'title_too_long') return 'That name is too long.';
  if (view.titleError === 'title_invalid') return 'That name contains characters that aren’t allowed.';
  if (view.phase === 'resolving') return 'The last step did not confirm. Retry to find out what happened.';
  if (view.errorCode) return `Could not finish creating the channel (${view.errorCode}).`;
  return null;
}

/** Opens the room and toasts once the controller reports a created channel. */
export function bindNewChannel(controller: CreateChannelController, { onCreated, toast }: Readonly<{
  onCreated(roomId: string): void;
  toast(text: string): void;
}>): () => void {
  let done = false;
  return controller.subscribe(view => {
    if (done || view.phase !== 'ready' || view.roomId === null) return;
    done = true;
    toast('Created');
    onCreated(view.roomId);
  });
}

export function NewChannelForm({ name, busy, retry, error, onNameChange, onCreate }: Readonly<{
  name: string;
  busy: boolean;
  retry: boolean;
  error: string | null;
  onNameChange(name: string): void;
  onCreate(): void;
}>) {
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (!busy) onCreate();
  };
  return <>
    <div className="kh-pop-h">New channel</div>
    <input className="kh-txt" placeholder="Name (optional)" aria-label="Channel name" maxLength={60} autoComplete="off"
      value={name} disabled={busy} onChange={event => onNameChange(event.target.value)} onKeyDown={onKeyDown} />
    <button type="button" className="kh-btn pri" disabled={busy} onClick={onCreate}>{retry ? 'Retry' : 'Create'}</button>
    {error ? <div className="kh-hint kh-new-err" role="alert">{error}</div> : null}
  </>;
}

function NewChannelBody({ ports, onOpenRoom, onClose }: Readonly<{
  ports: NewChannelPorts;
  onOpenRoom(roomId: string): void;
  onClose(): void;
}>) {
  const toast = useToast();
  const controller = useMemo(() => createCreateChannelController(ports, { mode: 'on_demand' }), [ports]);
  const [view, setView] = useState(() => controller.getView());
  const [name, setName] = useState('');
  const created = useRef((roomId: string) => { onClose(); onOpenRoom(roomId); });
  useEffect(() => { created.current = roomId => { onClose(); onOpenRoom(roomId); }; }, [onClose, onOpenRoom]);
  useEffect(() => () => controller.dispose(), [controller]);
  useEffect(() => {
    setView(controller.getView());
    const unsubscribe = controller.subscribe(setView);
    const unbind = bindNewChannel(controller, { toast, onCreated: roomId => created.current(roomId) });
    return () => { unbind(); unsubscribe(); };
  }, [controller, toast]);
  return <NewChannelForm name={name} onNameChange={setName} onCreate={() => createNewChannel(controller, name)}
    busy={view.phase === 'creating' || view.phase === 'sharing'}
    retry={view.phase === 'resolving' || (view.phase === 'failed' && view.roomId !== null)}
    error={newChannelError(view)} />;
}

/** The `+` popover in the list head; the caller owns `open` and the anchor button. */
export function NewChannelPopover({ anchor, open, onClose, ports, onOpenRoom }: Readonly<{
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose(): void;
  ports: NewChannelPorts;
  onOpenRoom(roomId: string): void;
}>) {
  return <Popover anchor={anchor} open={open} onClose={onClose}>
    <NewChannelBody ports={ports} onOpenRoom={onOpenRoom} onClose={onClose} />
  </Popover>;
}
