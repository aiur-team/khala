import { createRoot } from 'react-dom/client';
import '../../../brand/fonts.css';
import '../../../brand/tokens.css';
import '../../../shell/shell.css';
import '../../../ui/conversation/conversation.css';
import '../../../features/channel/channel.css';
import '../../../features/recovery/recovery.css';
import { decodeDeliveryLimits, unknownModeSupportMap, type ApprovalCommand,
  type PolicySetCommand } from '@khala/contracts/delivery/index';
import type { ChannelSnapshot, RoomPort, TimelineItem } from '@khala/contracts/messaging/index';
import type { HumanRouteContext } from '../application';
import { createHumanRoomRenderer } from '../room';
import { registerReview } from '../../review/register';
import { registerControls } from '../../controls/register';
import '../../../features/review/review.css';
import '../../../features/agent-controls/agent-controls.css';

const roomId = 'room_1' as never;
const bindingId = 'binding_1' as never;
const race = new URLSearchParams(location.search).has('race');
const lookupRace = new URLSearchParams(location.search).has('lookup');
const controlsEnabled = new URLSearchParams(location.search).has('controls');
const statusRace = new URLSearchParams(location.search).has('status-race');
const oldBinding = { bindingId, generation: 0, agentParticipantId: race ? 'Old agent' : 'My agent',
  device: { userId: '@agent:example', deviceId: 'AGENT_OLD', fingerprint: 'A'.repeat(43) } };
const newBinding = { bindingId, generation: 1, agentParticipantId: 'New agent',
  device: { userId: '@agent:example', deviceId: 'AGENT_NEW', fingerprint: 'B'.repeat(43) } };
const replacedIdentity = { ...newBinding, agentParticipantId: 'Replaced identity' };
const accountBinding = { ...newBinding, agentParticipantId: 'Other account agent',
  device: { userId: '@other:example', deviceId: 'OTHER_DEVICE', fingerprint: 'C'.repeat(43) } };
let activeBinding = oldBinding;
let lookupCount = 0;
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const item = (id: string, body: string, character: string, clientTxnId: string | null = null): TimelineItem => ({
  ref: { v: 1, roomId, eventId: id as never, authorParticipantId: 'peer_agent' as never,
    authorDeviceId: 'peer_device' as never, contentDigest: digest(character) },
  content: { v: 1, kind: 'text', body },
  participant: { participantId: 'peer_agent' as never, kind: 'agent', ownerId: 'peer_owner' as never,
    displayName: 'Peer agent', deviceIds: ['peer_device' as never] },
  clientTxnId, receivedAt: '2026-09-27T00:00:00Z',
});
const items = [item('event_a', 'Withheld A', 'a'), item('event_b', 'Approved B', 'b')];
const confirmed = sessionStorage.getItem('khala.test.send.confirmed');
if (confirmed) {
  const { clientTxnId, body } = JSON.parse(confirmed) as { clientTxnId: string; body: string };
  items.push(item(clientTxnId, body, 'c', clientTxnId));
}
const snapshot: ChannelSnapshot = { generation: 1, snapshotRevision: 'snapshot_1',
  room: { roomId, title: 'Test channel', membership: 'joined', revision: 'room_1' }, items };
let command: ApprovalCommand | null = null;
let controlVersion = 3;
let controlPaused = false;
const controlCommands: PolicySetCommand[] = [];
let allowOldStatus: (() => void) | null = null;
const oldStatus = new Promise<void>(resolve => { allowOldStatus = resolve; });
let oldStatusReturned = false;
const roomListeners = new Set<(value: ChannelSnapshot) => void>();
const room = {
  observe(_roomId: unknown, listener: (value: ChannelSnapshot) => void) {
    roomListeners.add(listener);
    queueMicrotask(() => listener(snapshot));
    return () => roomListeners.delete(listener);
  },
  async timeline() { return { kind: 'ok', value: { items, nextCursor: null, generation: 1 } }; },
  async send({ clientTxnId, content }: { clientTxnId: string; content: { body: string } }) {
    const original = sessionStorage.getItem('khala.test.send.pending-txn');
    if (content.body.startsWith('__reload_pending') && original === null) {
      sessionStorage.setItem('khala.test.send.pending-txn', clientTxnId);
      return new Promise<never>(() => {});
    }
    if (original !== null && original !== clientTxnId) return { kind: 'rejected', code: 'operation_mismatch' };
    const sent = item(clientTxnId, content.body, 'c', clientTxnId);
    items.push(sent);
    sessionStorage.setItem('khala.test.send.confirmed', JSON.stringify({ clientTxnId, body: content.body }));
    for (const listener of roomListeners) listener(snapshot);
    return { kind: 'ok', value: { clientTxnId, state: 'accepted', eventRef: sent.ref } };
  },
} as unknown as RoomPort;
const shareRequests: Array<{ roomId: string; policy: { kind: string; email?: string } }> = [];
const context = { generation: 1, room, principal: { ownerId: 'owner_1' },
  admission: { async share(input: { roomId: string; policy: { kind: string; email?: string } }) {
    shareRequests.push({ roomId: input.roomId, policy: input.policy });
    return { kind: 'ok' as const, value: { inviteRef: `invite_${shareRequests.length}`,
      shareUrl: `https://khala.example/join/invite_${shareRequests.length}`, expiresAt: null } };
  } },
  participant: () => ({ participantId: 'human_1', ownerId: 'owner_1', kind: 'human', displayName: 'Owner', deviceIds: [] }),
  identity: { current: async () => ({ kind: 'signed_in', principal: { ownerId: 'owner_1' } }) },
  device: { current: () => ({ state: 'ready', deviceId: 'device_1', generation: 1 }), observe: () => () => undefined },
} as unknown as HumanRouteContext;
let releaseOldLookup: (() => void) | null = null;
const oldLookup = new Promise<void>(resolve => { releaseOldLookup = resolve; });
let oldLookupReturned = false;
const review = {
  async bindings() {
    lookupCount += 1;
    const selected = activeBinding;
    if (lookupRace && lookupCount === 1) { await oldLookup; oldLookupReturned = true; }
    return [selected];
  },
  review: {
    async preview() { return { kind: 'ok' as const, body: { v: 1, bindingId, bindingGeneration: 0,
      policyVersion: 3, pending: items.map(value => value.ref), receipts: [] } }; },
    async approve(value: ApprovalCommand) { command = value; return { kind: 'answered' as const,
      body: { ok: true, releaseIds: ['release_b'] } }; },
  },
};
let allowTrust: (() => void) | null = null;
const trustReady = new Promise<void>(resolve => { allowTrust = resolve; });
let allowOld: (() => void) | null = null;
const oldTrust = new Promise<void>(resolve => { allowOld = resolve; });
let oldTrustReturned = false;
let allowReplacement: (() => void) | null = null;
const replacementTrust = new Promise<void>(resolve => { allowReplacement = resolve; });
let allowAccount: (() => void) | null = null;
const accountTrust = new Promise<void>(resolve => { allowAccount = resolve; });
declare global { interface Window {
  __shareRequests: () => readonly { roomId: string; policy: { kind: string; email?: string } }[];
  __roomReviewCommand: () => ApprovalCommand | null;
  __allowReviewTrust: () => void;
  __reviewLookupCount: () => number;
  __releaseOldLookup: () => void;
  __oldLookupReturned: () => boolean;
  __setReviewBinding: (kind: 'new' | 'replacement') => void;
  __releaseOldTrust: () => void;
  __oldTrustReturned: () => boolean;
  __releaseReplacementTrust: () => void;
  __switchReviewAccount: () => void;
  __switchReviewDevice: () => void;
  __releaseAccountTrust: () => void;
  __controlCommands: () => readonly PolicySetCommand[];
  __releaseOldStatus: () => void;
  __oldStatusReturned: () => boolean;
} }
window.__shareRequests = () => shareRequests;
window.__roomReviewCommand = () => command;
window.__allowReviewTrust = () => allowTrust?.();
window.__reviewLookupCount = () => lookupCount;
window.__releaseOldLookup = () => releaseOldLookup?.();
window.__oldLookupReturned = () => oldLookupReturned;
window.__setReviewBinding = kind => { activeBinding = kind === 'new' ? newBinding : replacedIdentity; };
window.__releaseOldTrust = () => allowOld?.();
window.__oldTrustReturned = () => oldTrustReturned;
window.__releaseReplacementTrust = () => allowReplacement?.();
window.__releaseAccountTrust = () => allowAccount?.();
window.__controlCommands = () => controlCommands;
window.__releaseOldStatus = () => allowOldStatus?.();
window.__oldStatusReturned = () => oldStatusReturned;
const limits = decodeDeliveryLimits({ maxSelectionEvents: 20, maxPayloadBytes: 64 * 1024 });
if (!limits.ok) throw new Error('invalid review limits');
const capability = registerReview({ client: review.review, limits: limits.value, bindingFor: () => null });
const controls = registerControls({ client: {
  async status(requested) {
    const selected = activeBinding;
    const ownerId = selected === accountBinding ? 'owner_2' : 'owner_1';
    if (statusRace && selected === oldBinding) { await oldStatus; oldStatusReturned = true; }
    if (requested !== selected.bindingId) return { kind: 'refused' as const, code: 'forbidden' as const };
    return { kind: 'ok' as const, body: {
      v: 1, binding: { v: 1, bindingId: selected.bindingId, ownerId,
        agentParticipantId: selected.agentParticipantId, deviceId: 'device_agent',
        harness: 'codex', sessionId: `session_${selected.generation}`, generation: selected.generation },
      bindingStatus: 'active', capabilities: { v: 3, harness: 'codex', version: '0.157.1',
        adapterVersion: '0.157.1', support: 'tested', existingSession: 'native_cli_queue',
        immediateNotification: 'native_cli_queue', busy: 'queue', receiptEvidence: [],
        reconcileByReleaseId: 'while_queued', limits: limits.value, evidenceRef: 'native-proof',
        modes: unknownModeSupportMap('test', 'no primary mode proof', '0.157.1'), acknowledgement: 'unknown' },
      policy: { bindingId: selected.bindingId, generation: selected.generation,
        effectiveVersion: controlVersion, effectiveMode: 'review', paused: controlPaused },
      requested: null, busy: false, latestReceipt: null,
    } };
  },
  async setPolicy(next) {
    controlCommands.push(next);
    if (next.expectedBindingGeneration !== activeBinding.generation
      || next.expectedPolicyVersion !== controlVersion) return { kind: 'answered' as const, body: {
        v: 1, commandId: next.commandId, bindingId: next.bindingId, generation: activeBinding.generation,
        requestedVersion: null, effectiveVersion: controlVersion, connectorState: 'rejected', errorCode: 'stale_policy',
      } };
    controlVersion += 1;
    controlPaused = next.paused;
    return { kind: 'answered' as const, body: {
      v: 1, commandId: next.commandId, bindingId: next.bindingId, generation: next.expectedBindingGeneration,
      requestedVersion: controlVersion, effectiveVersion: controlVersion, connectorState: 'effective', errorCode: null,
    } };
  },
}, bindingFor: () => null, refreshMs: 75 });
let attachment = capability.attach(context);
let controlsAttachment = controls.attach(context);
const trustBinding: Parameters<typeof createHumanRoomRenderer>[2] = async (_context, _roomId, binding) => {
  if (!race) { await trustReady; return true; }
  if (binding.agentParticipantId === oldBinding.agentParticipantId) { await oldTrust; oldTrustReturned = true; }
  if (binding.agentParticipantId === replacedIdentity.agentParticipantId) await replacementTrust;
  if (binding.agentParticipantId === accountBinding.agentParticipantId) await accountTrust;
  return true;
};
const refreshMs = race || controlsEnabled ? 75 : 5_000;
const renderer = createHumanRoomRenderer(review, capability, trustBinding, refreshMs, controlsEnabled ? controls : undefined);
const route = { kind: 'channel' as const, path: '/channels/room_1', roomId };
const root = createRoot(document.getElementById('app')!);
const toolsRoute = new URLSearchParams(location.search).has('tools');
const testSurface = (currentContext: HumanRouteContext) => toolsRoute
  ? <div className="khala-content-root khala-owner-shell" data-theme="dark"><main className="khala-content-main" aria-label="Channel care route">{renderer.tools(currentContext, route)}</main></div>
  : <>{renderer(currentContext, route)}<aside aria-label="Channel care route">{renderer.tools(currentContext, route)}</aside></>;
root.render(testSurface(context));
window.__switchReviewAccount = () => {
  activeBinding = accountBinding;
  controlVersion = 3;
  controlPaused = false;
  attachment.dispose();
  controlsAttachment.dispose();
  const nextContext = { ...context, generation: 2, principal: { ownerId: 'owner_2' },
    participant: () => ({ participantId: 'human_2', ownerId: 'owner_2', kind: 'human', displayName: 'Other owner', deviceIds: [] }) } as unknown as HumanRouteContext;
  attachment = capability.attach(nextContext);
  controlsAttachment = controls.attach(nextContext);
  root.render(testSurface(nextContext));
};
window.__switchReviewDevice = () => {
  const nextContext = { ...context, generation: 2,
    device: { ...context.device, current: () => ({ state: 'ready', deviceId: 'device_2', generation: 2 }),
      observe: () => () => undefined } } as unknown as HumanRouteContext;
  root.render(testSurface(nextContext));
};
