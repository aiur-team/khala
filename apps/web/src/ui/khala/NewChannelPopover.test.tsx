import { decodeContentLimits, ok, type ChannelPort, type RoomId } from '@khala/contracts/messaging/index';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createCreateChannelController } from '../../features/create-channel/controller';
import { bindNewChannel, createNewChannel, NewChannelForm, newChannelError } from './NewChannelPopover';

const decoded = decodeContentLimits({ maxBodyBytes: 32_768, maxDisplayNameBytes: 255, maxRoomTitleBytes: 255 });
if (!decoded.ok) throw new Error('invalid test limits');
const limits = decoded.value;

function controllerWith(create: ChannelPort['create']) {
  const room = { create } as unknown as ChannelPort;
  return createCreateChannelController({ room, admission: {} as never, limits },{ mode: 'on_demand', createId: () => 'op_1' });
}

const created = (title: string | null) => ok({ roomId: '!new:khala.local' as RoomId, title, membership: 'joined' as const, revision: 'rev_1' });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function form(props: Partial<Parameters<typeof NewChannelForm>[0]> = {}) {
  return <NewChannelForm name="" busy={false} retry={false} error={null} onNameChange={vi.fn()} onCreate={vi.fn()} {...props} />;
}

function findInput(node: ReactNode): ReactElement<{ onKeyDown(event: unknown): void }> | undefined {
  if (!isValidElement<{ children?: ReactNode }>(node)) return Array.isArray(node) ? node.map(findInput).find(Boolean) : undefined;
  if (node.type === 'input') return node as ReactElement<{ onKeyDown(event: unknown): void }>;
  return findInput(node.props.children);
}

describe('NewChannelPopover', () => {
  it('renders the head, name field and Create, with no agent-first row', () => {
    const html = renderToStaticMarkup(form());
    expect(html).toBe('<div class="kh-pop-h">New channel</div>'
      + '<input class="kh-txt" placeholder="Name (optional)" aria-label="Channel name" maxLength="60" autoComplete="off" value=""/>'
      + '<button type="button" class="kh-btn pri">Create</button>');
    expect(html).not.toContain('kh-or');
    expect(html).not.toContain('kh-oneliner');
  });

  it('creates an empty name as Untitled channel', async () => {
    const create = vi.fn(async ({ title }: { title: string | null }) => created(title));
    const controller = controllerWith(create);
    createNewChannel(controller, '   ');
    await settle();
    expect(create).toHaveBeenCalledWith({ operationId: 'op_1', title: 'Untitled channel' });
  });

  it('submits on Enter in the name field', () => {
    const onCreate = vi.fn();
    const input = findInput(NewChannelForm({ name: 'Launch', busy: false, retry: false, error: null, onNameChange: vi.fn(), onCreate }));
    const preventDefault = vi.fn();
    input!.props.onKeyDown({ key: 'a', preventDefault });
    expect(onCreate).not.toHaveBeenCalled();
    input!.props.onKeyDown({ key: 'Enter', preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it('opens the created room and toasts Created', async () => {
    const controller = controllerWith(async ({ title }) => created(title));
    const onCreated = vi.fn();
    const toast = vi.fn();
    bindNewChannel(controller, { onCreated, toast });
    createNewChannel(controller, 'Launch');
    await settle();
    expect(onCreated).toHaveBeenCalledExactlyOnceWith('!new:khala.local');
    expect(toast).toHaveBeenCalledExactlyOnceWith('Created');
  });

  it('shows the controller’s error under Create', async () => {
    const controller = controllerWith(async () => ({ kind: 'rejected', code: 'forbidden' }));
    createNewChannel(controller, 'Launch');
    await settle();
    const error = newChannelError(controller.getView());
    expect(error).toBe('Could not finish creating the channel (forbidden).');
    expect(renderToStaticMarkup(form({ error }))).toContain('<div class="kh-hint kh-new-err" role="alert">Could not finish creating the channel (forbidden).</div>');
  });

  it('reports an invalid name and lets the owner fix it', async () => {
    const create = vi.fn(async ({ title }: { title: string | null }) => created(title));
    const controller = controllerWith(create);
    createNewChannel(controller, 'x'.repeat(300));
    expect(newChannelError(controller.getView())).toBe('That name is too long.');
    createNewChannel(controller, 'Launch');
    await settle();
    expect(create).toHaveBeenCalledWith({ operationId: 'op_1', title: 'Launch' });
  });

  it('retries a create whose outcome is unknown', async () => {
    const create = vi.fn<ChannelPort['create']>().mockResolvedValueOnce({ kind: 'outcome_unknown' } as never)
      .mockImplementation(async ({ title }) => created(title));
    const controller = controllerWith(create);
    createNewChannel(controller, 'Launch');
    await settle();
    expect(controller.getView().phase).toBe('resolving');
    createNewChannel(controller, 'Ignored while resolving');
    await settle();
    expect(create).toHaveBeenLastCalledWith({ operationId: 'op_1', title: 'Launch' });
    expect(controller.getView().phase).toBe('ready');
  });
});
