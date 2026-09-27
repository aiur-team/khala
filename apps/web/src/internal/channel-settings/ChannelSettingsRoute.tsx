import { useMemo } from 'react';
import type { RoomId } from '@khala/contracts/messaging/index';
import { ChannelSettingsPanel } from '../../features/channel-settings/ChannelSettingsPanel';
import type { ChannelSettingsPort } from '../../features/channel-settings/ports';
import { KhalaPageFrame } from '../../shell/KhalaPageFrame';

/** Shown when the picker is empty. Khala never launches or selects an agent, so this only says how a descriptor is issued. */
export function PickerEmptyHelp() {
  return (
    <>
      <p>
        An agent appears here after you issue it a discovery descriptor from your own terminal. Run this yourself, in
        the agent’s session; Khala does not start or select an agent for you:
      </p>
      <pre><code>khala internal discovery --harness &lt;name&gt; --session &lt;id&gt;</code></pre>
      <p>
        A new descriptor is selectable here as soon as it is issued, before that agent has joined anything. Only you can see this list.
      </p>
    </>
  );
}

export function ChannelSettingsRoute({ settings, roomId, channelHref }: {
  settings: ChannelSettingsPort;
  roomId: RoomId;
  channelHref: string;
}) {
  const ports = useMemo(() => ({ settings }), [settings]);
  return (
    <KhalaPageFrame model={{ title: 'Channel discovery settings', labelledBy: 'khala-channel-settings-title' }}>
      <p><a className="internal-owner-link" href={channelHref}>Back to channel</a></p>
      <ChannelSettingsPanel ports={ports} roomId={roomId} pickerEmptyHelp={<PickerEmptyHelp />} />
    </KhalaPageFrame>
  );
}
