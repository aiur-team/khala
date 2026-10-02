import { useSyncExternalStore } from 'react';
import type { Harness } from '@khala/contracts/m1/agent-join';
import { KhalaPageFrame } from '../../shell/KhalaPageFrame';
import { Panel } from '../../shell/Panel';
import type { AgentConfirmController, AgentConfirmError } from './controller';

const harnessNames: Record<Harness, string> = { claude: 'Claude Code', codex: 'Codex' };
const errors: Record<AgentConfirmError, string> = {
  not_member: 'You are not a member of this channel.',
  not_found: 'This confirmation link is not valid.',
  expired: 'This request expired. Ask your agent to run khala_join again.',
  already_confirmed_by_other: 'Another member already confirmed this agent.',
  ready_timeout: 'The agent did not finish connecting.',
  invite_failed: 'Could not add the agent to the channel.',
  unavailable: 'Khala is unavailable right now. Try again.',
  signed_out: 'Khala is unavailable right now. Try again.',
};

export function AgentConfirm({ controller, roomHref, onOpenRoom }: {
  controller: AgentConfirmController;
  roomHref: (roomId: string) => string;
  onOpenRoom: (roomId: string) => void;
}) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return (
    <KhalaPageFrame model={{ title: 'Confirm agent', labelledBy: 'agent-confirm-title' }}>
      <Panel>
        {snapshot.state === 'loading' ? <p role="status">Loading agent request…</p> : null}
        {snapshot.state === 'review' ? <>
          <p>{snapshot.view.label} ({harnessNames[snapshot.view.harness]}) wants to join {snapshot.view.channelName}.</p>
          <button type="button" onClick={() => void controller.confirm()}>Confirm</button>
        </> : null}
        {snapshot.state === 'connecting' ? <p role="status">Connecting {snapshot.view.label}… Keep this tab open.</p> : null}
        {snapshot.state === 'done' ? <>
          <p>{snapshot.view.label} joined {snapshot.view.channelName}.</p>
          <a href={roomHref(snapshot.view.roomId)} onClick={event => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            onOpenRoom(snapshot.view.roomId);
          }}>Open channel</a>
        </> : null}
        {snapshot.state === 'error' ? <>
          <p role="alert">{errors[snapshot.code]}</p>
          {['ready_timeout', 'invite_failed', 'unavailable', 'signed_out'].includes(snapshot.code)
            ? <button type="button" onClick={() => controller.retry()}>Retry</button> : null}
        </> : null}
      </Panel>
    </KhalaPageFrame>
  );
}
