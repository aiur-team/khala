import { decodeContentLimits } from '@khala/contracts/messaging/index';
import { decodeDeliveryLimits } from '@khala/contracts/delivery/index';
import { createHumanApplication } from './composition/human/application';
import { createBrowserTabHandoff } from './composition/human/tab-handoff';
import { createHumanBrowserApi } from './composition/human/browser-api';
import { createOwnerCleanupConsumer } from './composition/human/cleanup-consumer';
import { readHumanEntry } from './composition/human/entry';
import { readHostedConfig } from './composition/human/hosted-config';
import { createMatrixBrowserPorts } from './composition/human/matrix-browser';
import { mountKhalaContent } from './composition/human/mount';
import { createHumanRoomRenderer } from './composition/human/room';
import { createOwnerMailboxControlsClient } from './composition/controls/owner-mailbox-client';
import { registerControls } from './composition/controls/register';
import { createOwnerMailboxReviewClient } from './composition/review/owner-mailbox-client';
import { createOwnerDeviceClient } from './composition/review/owner-device-client';
import { registerReview } from './composition/review/register';
import { registerHumanCapabilities } from './composition/human/capabilities';
import { createHumanRouteCodec } from './composition/human/routes';
import { mountHostedUnavailable } from './composition/human/unavailable';
import { createChannelAccessInboxController } from './features/channel-access/controller';
import './brand/tokens.css';
import './shell/shell.css';
import './features/create-channel/create-channel.css';
import './features/timeline/timeline.css';
import './features/channel/channel.css';
import './features/review/review.css';
import './features/agent-controls/agent-controls.css';
import './features/recovery/recovery.css';
import './features/approval-decision/approval-decision.css';
import './features/channel-access/channel-access.css';
import './main.css';

const target = document.querySelector('#app');
if (!target) throw new Error('missing Khala application mount');

// A deployment without its public origins renders an explicit unavailable
// screen; throwing here would leave the visitor a blank page.
const config = readHostedConfig(import.meta.env);
if (config.ok) startHostedApplication(target, config.appOrigin, config.homeserverOrigin, config.localDev);
else mountHostedUnavailable(target, config.missing);

function startHostedApplication(target: Element, appOrigin: string, homeserverOrigin: string, localDev: boolean): void {
  const decodedLimits = decodeContentLimits({
    maxBodyBytes: 32_768,
    maxDisplayNameBytes: 255,
    maxRoomTitleBytes: 255,
  });
  if (!decodedLimits.ok) throw new Error('invalid Matrix content limits');

  const entry = readHumanEntry(location);
  if (entry.path !== `${location.pathname}${location.search}`) history.replaceState(null, '', entry.path);

  const api = createHumanBrowserApi({ origin: appOrigin, homeserverOrigin, limits: decodedLimits.value, allowInsecureLoopback: localDev });
  const review = createOwnerMailboxReviewClient({ origin: appOrigin, csrf: api.reviewCsrf, allowInsecureLoopback: localDev });
  const controlsClient = createOwnerMailboxControlsClient({ origin: appOrigin, csrf: api.reviewCsrf, allowInsecureLoopback: localDev });
  const controlsCapability = registerControls({ client: controlsClient, bindingFor: () => null });
  const ownerDevice = createOwnerDeviceClient({ origin: appOrigin, csrf: api.reviewCsrf, allowInsecureLoopback: localDev });
  const deliveryLimits = decodeDeliveryLimits({ maxSelectionEvents: 20, maxPayloadBytes: 64 * 1024 });
  if (!deliveryLimits.ok) throw new Error('invalid review limits');
  const reviewCapability = registerReview({ client: review.review, limits: deliveryLimits.value, bindingFor: () => null });
  const matrix = createMatrixBrowserPorts({
    identity: api.identity,
    credentials: api.credentials,
    participants: api.participants,
    limits: decodedLimits.value,
    sendFence: api.roomSend,
  });
  let cleanupConsumer: ReturnType<typeof createOwnerCleanupConsumer> | null = null;
  const closure = (roomId: Parameters<typeof api.closure>[0]) => {
    const port = api.closure(roomId);
    return {
      currentCapability: port.currentCapability,
      async closeRoom(input: Parameters<typeof port.closeRoom>[0], options?: Parameters<typeof port.closeRoom>[1]) {
        const result = await port.closeRoom(input, options);
        if (result.kind === 'ok' && result.value.state === 'complete') void cleanupConsumer?.poll();
        return result;
      },
      async inspectClosure(operationId: string, options?: Parameters<typeof port.inspectClosure>[1]) {
        const result = await port.inspectClosure(operationId, options);
        if (result.kind === 'ok' && result.value.state === 'complete') void cleanupConsumer?.poll();
        return result;
      },
    };
  };
  const application = createHumanApplication({
    identity: api.identity,
    device: matrix.device,
    room: matrix.room,
    conversations: matrix.conversations,
    admission: api.admission,
    participant: matrix.participant,
    closure,
    ...(api.revocation ? { revocation: api.revocation } : {}),
    limits: decodedLimits.value,
  }, { initialPath: entry.path, tabHandoff: createBrowserTabHandoff() });
  cleanupConsumer = createOwnerCleanupConsumer({
    ownerId: () => {
      const snapshot = application.getSnapshot();
      return snapshot.phase === 'ready' ? snapshot.context.principal.ownerId : null;
    },
    requests: api.cleanupRequests,
    cleanupRoom: matrix.cleanupRoom,
    roomPresent: matrix.roomPresent,
  });
  const unsubscribeCleanup = application.subscribe(() => { void cleanupConsumer?.poll(); });
  cleanupConsumer.start();
  const routes = createHumanRouteCodec({ origin: appOrigin, basePath: '/', allowInsecureLoopback: localDev });
  const createChannelAccess = () => createChannelAccessInboxController({ requests: api.channelAccess });
  const roomRenderer = createHumanRoomRenderer(review, reviewCapability, async (context, roomId, binding) => {
    if (!binding.device) return false;
    const currentOwner = () => matrix.participant()?.ownerId === context.principal.ownerId
      && matrix.device.current().generation === context.deviceView.generation;
    if (!currentOwner()) return false;
    const proof = await matrix.ownerDeviceProof();
    if (!proof || !currentOwner() || !await ownerDevice.register(roomId, binding.bindingId, binding.generation, proof)
      || !currentOwner()) return false;
    const established = await matrix.trustAgentDevice(roomId, binding.device.userId,
      binding.device.deviceId, binding.device.fingerprint);
    return established && currentOwner();
  }, 5_000, controlsCapability);
  const mounted = mountKhalaContent({
    target,
    application,
    identity: api.identity,
    routes,
    createChannelAccess,
    mode: entry.mode,
    capabilities: registerHumanCapabilities(reviewCapability, controlsCapability),
    renderRoom: roomRenderer,
    renderChannelTools: roomRenderer.tools,
    navigateRoute(path) {
      history.pushState(null, '', path);
      application.navigate(path);
      void cleanupConsumer?.poll();
    },
  });

  const onPopState = () => {
    application.navigate(`${location.pathname}${location.search}`);
    void cleanupConsumer?.poll();
  };
  addEventListener('popstate', onPopState);
  addEventListener('pagehide', () => {
    removeEventListener('popstate', onPopState);
    unsubscribeCleanup();
    cleanupConsumer?.dispose();
    mounted.dispose();
    application.dispose();
  }, { once: true });
}
