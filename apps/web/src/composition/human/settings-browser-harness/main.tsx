import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CLOSURE_CONSEQUENCES, type DeviceId, type OwnerId, type RoomId } from '@khala/contracts/messaging/index';
import type { RecoveryController } from '../../../features/recovery/controller';
import type { RecoveryView } from '../../../features/recovery/model';
import type { RecoveryPorts } from '../../../features/recovery/ports';
import { ConversationSettingsDisclosure } from '../ConversationSettingsDisclosure';
import { ClosureAction } from '../../../features/recovery/RecoveryPanel';
import '../../../brand/tokens.css';
import '../../../shell/shell.css';
import '../../../features/recovery/recovery.css';

function fakeController(owner: OwnerId, roomId: RoomId, deviceId: DeviceId): RecoveryController {
  let view: RecoveryView = {
    identityState: 'signed_in', deviceState: 'ready', deviceId, deviceGeneration: 1,
    history: 'available', connection: 'online', operation: { kind: 'idle' },
    recoveryModes: [], recoveryUnavailableReason: 'unsupported_substrate',
    revocationTargets: [{ targetKind: 'device', targetId: deviceId, expectedGeneration: 1 }],
    closure: { ownerId: owner, roomId, expectedRoomRevision: 1, available: true,
      unavailableReason: null, consequences: CLOSURE_CONSEQUENCES }, allowedActions: ['revoke_device', 'close_room'],
  };
  const listeners = new Set<() => void>();
  return {
    getView: () => view,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    beginRecovery: async () => null,
    beginRevocation: async () => {
      document.querySelector('#result')!.textContent = `${owner}:${roomId}:${deviceId}`;
      view = { ...view, operation: { kind: 'revocation', operationId: `${owner}:${roomId}`, state: 'outcome_unknown', reason: null } };
      listeners.forEach(listener => listener());
      return null;
    },
    beginClosure: async () => null,
    inspect: async () => null,
    cancel: () => {},
    dispose: () => {},
  };
}

const first = { owner: 'owner_a' as OwnerId, room: 'room_a' as RoomId, device: 'device_a' as DeviceId };
const second = { owner: 'owner_b' as OwnerId, room: 'room_b' as RoomId, device: 'device_b' as DeviceId };
const controllers = [fakeController(first.owner, first.room, first.device), fakeController(second.owner, second.room, second.device)];

function Harness() {
  const [index, setIndex] = useState(0);
  const [titleOpen, setTitleOpen] = useState(false);
  const selected = index === 0 ? first : second;
  return <div className="khala-content-root khala-owner-shell" data-theme="dark">
    <div className="khala-content-actions"><span>{selected.room}</span><ConversationSettingsDisclosure
      scope={`${selected.owner}:1:${selected.room}`}
      recovery={{ ports: {} as RecoveryPorts, config: { roomId: selected.room, roomRevision: 1 },
        controller: controllers[index]!, onClosureParticipationEnded: () => {} }} />
      <details onToggle={event => setTitleOpen(event.currentTarget.open)}><summary>Title</summary>
        <ClosureAction ports={{} as RecoveryPorts} config={{ roomId: selected.room, roomRevision: 1 }}
          controller={controllers[index]!} disclosureOpen={titleOpen} onClosureParticipationEnded={() => {}} />
      </details></div>
    <button type="button" onClick={() => setIndex(current => 1 - current)}>Switch conversation</button>
    <button type="button">Outside target</button><output id="result" />
  </div>;
}

createRoot(document.getElementById('root')!).render(<Harness />);
