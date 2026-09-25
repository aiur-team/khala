import { describe, expect, it } from 'vitest';
import type { RoomId } from '@khala/contracts/messaging/index';
import { createChannelSettingsController, type ChannelSettingsController } from './controller';
import { createFakeCatalog, OWNER_ID, type FakeCatalog } from './fakes';
import { isVisibilityIncrease, projectListing } from './model';

const ROOM = '!channel:example.test' as RoomId;
const OTHER_OWNER_SESSION = { ownerId: 'owner-b', principal: 'principal-peer' } as const;

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

async function loaded(catalog: FakeCatalog): Promise<ChannelSettingsController> {
  let n = 0;
  const controller = createChannelSettingsController({ settings: catalog.port }, ROOM, { createId: () => `op-${++n}` });
  controller.load();
  await settle();
  return controller;
}

describe('channel settings controller', () => {
  it('starts in loading and shows a new external channel as secret with no listing', async () => {
    const catalog = createFakeCatalog();
    const controller = createChannelSettingsController({ settings: catalog.port }, ROOM);
    expect(controller.getView().phase).toBe('loading');
    controller.load();
    await settle();
    const view = controller.getView();
    expect(view.phase).toBe('editing');
    expect(view.saved?.visibility).toBe('secret');
    expect(view.draftVisibility).toBe('secret');
    expect(view.preview).toEqual({ kind: 'not_listed' });
    expect(view.readOnly).toBe(false);
  });

  it('previews exactly the contract ChannelListing projection, including title normalization', async () => {
    const controller = await loaded(createFakeCatalog());
    controller.setVisibility('private');
    controller.setTitle('Plans‮evil\u0007');
    const preview = controller.getView().preview;
    expect(preview.kind).toBe('listed');
    if (preview.kind !== 'listed') return;
    expect(Object.keys(preview.listing).sort()).toEqual(['listingRef', 'requestState', 'serviceKind', 'title', 'v', 'visibility']);
    expect(preview.listing).toMatchObject({ v: 1, title: 'Plans�evil�', visibility: 'private', serviceKind: 'external', requestState: 'not_requested' });
  });

  it('defaults the listed title to the channel name and rejects an empty or oversized title locally', async () => {
    const catalog = createFakeCatalog();
    const controller = await loaded(catalog);
    controller.setVisibility('private');
    expect(controller.getView().draftTitle).toBe('Release planning');
    controller.setTitle('   ');
    controller.save();
    expect(controller.getView().titleError).toBe('title_required');
    controller.setTitle('x'.repeat(300));
    controller.save();
    expect(controller.getView().titleError).toBe('title_invalid');
    expect(catalog.calls.setVisibility).toHaveLength(0);
  });

  it('asks for confirmation before any increase and sends nothing until confirmed', async () => {
    const catalog = createFakeCatalog();
    const controller = await loaded(catalog);
    controller.setVisibility('private');
    controller.save();
    expect(controller.getView().phase).toBe('confirming');
    expect(catalog.calls.setVisibility).toHaveLength(0);
    controller.confirm();
    expect(controller.getView().phase).toBe('submitting');
    await settle();
    expect(catalog.calls.setVisibility).toEqual([
      { v: 1, operationId: 'op-1', roomId: ROOM, visibility: 'private', title: 'Release planning', expectedRevision: null },
    ]);
    expect(controller.getView()).toMatchObject({ phase: 'editing', status: { kind: 'saved', visibility: 'private' }, pending: null });
    expect(controller.getView().saved).toMatchObject({ visibility: 'private', listedTitle: 'Release planning', revision: '1' });
  });

  // Wrong-implementation test (RD3A): the guarded line is the confirmation
  // branch in `save()`. Reverting it submits the increase directly.
  it('selecting public and dismissing the confirmation leaves the channel secret and absent from another eligible session', async () => {
    const catalog = createFakeCatalog({ publicDiscovery: 'enabled' });
    const controller = await loaded(catalog);
    controller.setVisibility('public');
    controller.save();
    controller.cancel();
    await settle();

    expect(catalog.calls.setVisibility).toHaveLength(0);
    expect(catalog.entry().visibility).toBe('secret');
    expect(catalog.listFor(OTHER_OWNER_SESSION)).toEqual([]);
    expect(catalog.listFor({ ownerId: OWNER_ID, principal: 'principal-own' })).toEqual([]);
    const view = controller.getView();
    expect(view).toMatchObject({ phase: 'editing', draftVisibility: 'secret', pending: null, status: { kind: 'idle' } });
    expect(view.saved?.visibility).toBe('secret');
  });

  it('control: confirming public does make the channel listable to another session', async () => {
    const catalog = createFakeCatalog({ publicDiscovery: 'enabled' });
    const controller = await loaded(catalog);
    controller.setVisibility('public');
    controller.save();
    controller.confirm();
    await settle();
    expect(catalog.listFor(OTHER_OWNER_SESSION).map(listing => listing.title)).toEqual(['Release planning']);
  });

  it('treats private → public as an increase and public → secret as a decrease that saves directly', async () => {
    expect(isVisibilityIncrease('private', 'public')).toBe(true);
    expect(isVisibilityIncrease('public', 'private')).toBe(false);
    const catalog = createFakeCatalog({ initial: { visibility: 'public', listedTitle: 'Release planning' } });
    const controller = await loaded(catalog);
    controller.setVisibility('secret');
    controller.save();
    expect(controller.getView().phase).toBe('submitting');
    await settle();
    expect(catalog.calls.setVisibility[0]).toMatchObject({ visibility: 'secret', title: null, expectedRevision: '1' });
    expect(catalog.entry().visibility).toBe('secret');
  });

  it('blocks public when hosted public discovery is disabled', async () => {
    const catalog = createFakeCatalog({ publicDiscovery: 'disabled' });
    const controller = await loaded(catalog);
    controller.setVisibility('public');
    expect(controller.getView().draftVisibility).toBe('secret');
  });

  it('ignores edits and double submission while submitting', async () => {
    const catalog = createFakeCatalog({ initial: { visibility: 'private', listedTitle: 'A' } });
    const controller = await loaded(catalog);
    controller.setTitle('B');
    controller.save();
    controller.save();
    controller.setVisibility('secret');
    expect(controller.getView()).toMatchObject({ phase: 'submitting', draftTitle: 'B', draftVisibility: 'private' });
    await settle();
    expect(catalog.calls.setVisibility).toHaveLength(1);
  });

  it('refreshes a stale revision before retry and saves nothing', async () => {
    const catalog = createFakeCatalog();
    const controller = await loaded(catalog);
    catalog.bumpRevision({ visibility: 'private', listedTitle: 'Changed elsewhere' });
    controller.setVisibility('private');
    controller.setTitle('Mine');
    controller.save();
    controller.confirm();
    await settle();
    await settle();
    const view = controller.getView();
    expect(view.status).toEqual({ kind: 'stale_refreshed' });
    expect(view.saved).toMatchObject({ visibility: 'private', listedTitle: 'Changed elsewhere', revision: '1' });
    expect(view.draftTitle).toBe('Changed elsewhere');
    expect(view.pending).toBeNull();
    controller.setTitle('Mine');
    controller.save();
    await settle();
    expect(catalog.calls.setVisibility.at(-1)).toMatchObject({ expectedRevision: '1', title: 'Mine' });
    expect(catalog.calls.setVisibility.at(-1)?.operationId).not.toBe(catalog.calls.setVisibility[0]?.operationId);
    expect(catalog.entry().listedTitle).toBe('Mine');
  });

  it('returns to read-only when owner authority is lost', async () => {
    const catalog = createFakeCatalog();
    const controller = await loaded(catalog);
    catalog.revokeOwnership();
    controller.setVisibility('private');
    controller.save();
    controller.confirm();
    await settle();
    const view = controller.getView();
    expect(view).toMatchObject({ readOnly: true, pending: null, status: { kind: 'authority_lost' }, draftVisibility: 'secret' });
    controller.setVisibility('public');
    controller.save();
    expect(catalog.calls.setVisibility).toHaveLength(1);
  });

  it('is read-only when the viewer does not manage the channel on load', async () => {
    const catalog = createFakeCatalog();
    catalog.revokeOwnership();
    const controller = await loaded(catalog);
    expect(controller.getView()).toMatchObject({ phase: 'load_failed', readOnly: true, status: { kind: 'authority_lost' } });
  });

  it('keeps a retryable failure pending without implying success, and retries with the same operation ID', async () => {
    const catalog = createFakeCatalog();
    const controller = await loaded(catalog);
    catalog.failNext.push('unavailable');
    controller.setVisibility('private');
    controller.save();
    controller.confirm();
    await settle();
    let view = controller.getView();
    expect(view.status).toEqual({ kind: 'failed', code: 'unavailable', retryable: true });
    expect(view.pending).toMatchObject({ kind: 'visibility', visibility: 'private' });
    expect(view.saved?.visibility).toBe('secret');
    expect(view.draftVisibility).toBe('private');
    controller.retry();
    await settle();
    view = controller.getView();
    expect(view.status).toEqual({ kind: 'saved', visibility: 'private' });
    expect(catalog.calls.setVisibility.map(call => call.operationId)).toEqual(['op-1', 'op-1']);
  });

  it('treats a thrown port error as a retryable failure', async () => {
    const catalog = createFakeCatalog();
    const controller = await loaded(catalog);
    catalog.port.setVisibility = () => Promise.reject(new Error('network'));
    controller.setVisibility('private');
    controller.save();
    controller.confirm();
    await settle();
    expect(controller.getView()).toMatchObject({ phase: 'editing', status: { kind: 'failed', retryable: true } });
  });

  it('shows a load failure and recovers through load()', async () => {
    const catalog = createFakeCatalog();
    const read = catalog.port.read;
    catalog.port.read = () => Promise.resolve({ kind: 'unavailable', retryable: true });
    const controller = await loaded(catalog);
    expect(controller.getView().phase).toBe('load_failed');
    catalog.port.read = read;
    controller.load();
    await settle();
    expect(controller.getView().phase).toBe('editing');
  });
});

describe('verified-agent allowlist', () => {
  async function privateChannel() {
    const catalog = createFakeCatalog({ initial: { visibility: 'private', listedTitle: 'Release planning' } });
    return { catalog, controller: await loaded(catalog) };
  }

  it('offers only known principals from the owner-only source, with fingerprints and sources', async () => {
    const { controller } = await privateChannel();
    const picker = controller.getView().picker;
    expect(picker.kind).toBe('ready');
    if (picker.kind !== 'ready') return;
    expect(picker.principals.map(agent => [agent.fingerprint, agent.source])).toEqual([
      ['SHA256:own-7Q2c', 'own_session'],
      ['SHA256:peer-9Xb1', 'pairing'],
    ]);
  });

  it('adds a principal bound to its inspected session generation, and the agent can then list the channel', async () => {
    const { catalog, controller } = await privateChannel();
    expect(catalog.listFor(OTHER_OWNER_SESSION)).toEqual([]);
    controller.allow('principal-peer');
    expect(controller.getView().phase).toBe('submitting');
    await settle();
    expect(catalog.calls.updateAllowlist[0]).toMatchObject({
      action: 'allow', principal: 'principal-peer', expectedSessionGeneration: 1, expectedRevision: '1',
    });
    expect(controller.getView().status).toEqual({ kind: 'allowed', fingerprint: 'SHA256:peer-9Xb1' });
    expect(controller.getView().saved?.allowlist.map(agent => agent.principal)).toEqual(['principal-peer']);
    expect(catalog.listFor(OTHER_OWNER_SESSION)).toHaveLength(1);
  });

  it('revokes a principal and removes its eligibility', async () => {
    const { catalog, controller } = await privateChannel();
    controller.allow('principal-peer');
    await settle();
    controller.revoke('principal-peer');
    await settle();
    expect(catalog.calls.updateAllowlist[1]).toMatchObject({ action: 'revoke', principal: 'principal-peer', expectedRevision: '2' });
    expect(controller.getView().saved?.allowlist).toEqual([]);
    expect(catalog.listFor(OTHER_OWNER_SESSION)).toEqual([]);
  });

  it('refuses an agent the picker did not offer, so no free-text or forged identity can be allowed', async () => {
    const { catalog, controller } = await privateChannel();
    controller.allow('principal-typed-in');
    await settle();
    expect(catalog.calls.updateAllowlist).toHaveLength(0);
  });

  it('only edits the allowlist of a saved private channel', async () => {
    const catalog = createFakeCatalog();
    const controller = await loaded(catalog);
    controller.allow('principal-own');
    await settle();
    expect(catalog.calls.updateAllowlist).toHaveLength(0);
  });

  it('refreshes settings and picker when the agent rebound since it was inspected', async () => {
    const { catalog, controller } = await privateChannel();
    catalog.rebind('principal-peer');
    controller.allow('principal-peer');
    await settle();
    await settle();
    const view = controller.getView();
    expect(view.status).toEqual({ kind: 'stale_refreshed' });
    expect(catalog.entry().allowlist).toEqual([]);
    expect(view.picker.kind === 'ready' && view.picker.principals[1]?.sessionGeneration).toBe(2);
    controller.allow('principal-peer');
    await settle();
    expect(catalog.calls.updateAllowlist.at(-1)).toMatchObject({ expectedSessionGeneration: 2 });
    expect(catalog.entry().allowlist.map(agent => agent.principal)).toEqual(['principal-peer']);
  });
});

describe('projectListing', () => {
  it('never projects a secret channel', () => {
    expect(projectListing('secret', 'Anything')).toEqual({ kind: 'not_listed' });
  });
});
