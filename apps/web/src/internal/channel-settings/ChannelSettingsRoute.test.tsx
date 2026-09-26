import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RoomId } from '@khala/contracts/messaging/index';
import { ChannelSettingsPanel } from '../../features/channel-settings/ChannelSettingsPanel';
import type { ChannelSettingsController } from '../../features/channel-settings/controller';
import { createFakeCatalog } from '../../features/channel-settings/fakes';
import { INITIAL_VIEW, type ChannelSettingsView } from '../../features/channel-settings/model';
import { PickerEmptyHelp } from './ChannelSettingsRoute';

const ROOM = 'ch_1' as RoomId;

function render(picker: ChannelSettingsView['picker'], help: boolean): string {
  const view: ChannelSettingsView = {
    ...INITIAL_VIEW,
    phase: 'editing',
    readOnly: false,
    draftTitle: 'Release planning',
    picker,
    saved: {
      roomId: ROOM, channelName: 'Release planning', visibility: 'private', listedTitle: 'Release planning', revision: '1',
      allowlist: [], publicDiscovery: 'enabled', canManage: true,
    },
    draftVisibility: 'private',
  };
  const controller: ChannelSettingsController = {
    getView: () => view, subscribe: () => () => {}, load: () => {}, setVisibility: () => {}, setTitle: () => {}, save: () => {},
    confirm: () => {}, cancel: () => {}, allow: () => {}, revoke: () => {}, retry: () => {}, dispose: () => {},
  };
  return renderToStaticMarkup(
    <ChannelSettingsPanel
      ports={{ settings: createFakeCatalog().port }}
      roomId={ROOM}
      controller={controller}
      {...(help ? { pickerEmptyHelp: <PickerEmptyHelp /> } : {})}
    />,
  );
}

describe('internal picker empty state', () => {
  it('explains how to issue a descriptor without launching an agent, replacing the hosted sign-in help', () => {
    const html = render({ kind: 'ready', principals: [] }, true);
    expect(html).toContain('khala internal discovery --harness');
    expect(html).toContain('Khala does not start or select an agent');
    expect(html).not.toContain('sign in to authorize');
    expect(html).not.toContain('complete a pairing');
  });

  it('keeps the hosted help when no override is given', () => {
    expect(render({ kind: 'ready', principals: [] }, false)).toContain('complete a pairing');
  });

  it('offers no free-text or global search control', () => {
    const html = render({ kind: 'ready', principals: [] }, true);
    expect(html).not.toMatch(/type="(search|text)"[^>]*(agent|principal|search)/i);
    expect(html).not.toContain('type="search"');
  });
});
