/// <reference lib="dom" />
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { build } from '../../apps/web/node_modules/vite/dist/node/index.js';
import { createControlStore } from '../../apps/control/src/runtime/control-store';
import { ownerMatrixLocalpart, ownerMatrixUserId } from '../../apps/control/src/composition/human/matrix-identity';
import { createAgentBindingStore } from '../../apps/control/src/agent-bootstrap/store';
import { createOwnerRoomIndex } from '../../apps/control/src/agent-bootstrap/owner-room-index';
import { createChannelClosureHandlers } from '../../apps/control/src/channel-closure/handler';
import { createChannelClosureService } from '../../apps/control/src/channel-closure/service';
import { createMatrixClosureTransport } from '../../apps/control/src/channel-closure/matrix';
import { createOwnerCleanupRequests } from '../../apps/control/src/channel-closure/cleanup-requests';
import { createProtectedClosureConnector } from '../../apps/control/src/channel-closure/production';
import { createOwnerMailboxRoutes } from '../../apps/control/src/composition/owner-mailbox/routes';
import { checkProof } from '../../apps/control/src/agent-bootstrap/proof';
import { createProofSigner } from '../../packages/connector/src/bootstrap/proof';
import { agentMatrixIdentity, createMatrixAgentAdmission } from '../../apps/control/src/composition/agent/matrix-admission';
import { createOwnerRevocationRoutes } from '../../apps/control/src/composition/human/revocation';
import { createCleanupProtocolPort, createAgentRevocationCleanupRoutes } from '../../apps/control/src/composition/human/revocation-cleanup';
import { createRoomSendFence, senderIdFor } from '../../apps/control/src/composition/human/room-send-fence';
import { createProductionRevocationCleanup } from '../../apps/connector/src/composition/agent/revocation-cleanup';
import { openMatrixConnectorSubstrate } from '../../apps/connector/src/substrate/matrix';
import { createProductionOwnerMailbox } from '../../apps/connector/src/composition/agent/owner-mailbox';
import { createLocalClosureFence } from '../../apps/connector/src/composition/closure/local-fence';
import { openConnectorStorage } from '../../packages/connector/src/storage/open';
import { decodeDeliveryLimits } from '../../packages/contracts/src/delivery/index';
import type { AuthPrincipal, OwnerId, RoomId, SessionBinding } from '../../packages/contracts/src/messaging/index';
import type { AuthService } from '../../apps/control/src/auth/index';
import type { AdapterCapabilities } from '../../apps/control/src/agent-bootstrap/handler';
import { openClosureFixtureStores } from './fixtures/closure-cas';
import { startClosureSynapse } from './fixtures/closure-synapse';

const combined = process.argv.includes('--revoke-then-close');
const directory = await mkdtemp(path.join(os.homedir(), '.cache', 'khala-345-live-'));
const synapse = await startClosureSynapse();
const contexts: Array<Awaited<ReturnType<typeof import('../../apps/connector/node_modules/playwright-core').chromium.launchPersistentContext>>> = [];
let server: ReturnType<typeof createHttpsServer> | null = null;
let agentSubstrate: Awaited<ReturnType<typeof openMatrixConnectorSubstrate>> | null = null;
const stores = openClosureFixtureStores(path.join(directory, 'control.sqlite'));
try {
  const registrationProbe = await synapse.probeSharedSecretRegistration('khala_b3duZXJfcHJvYmU');
  const escapedRegistrationProbe = await synapse.probeSharedSecretRegistration(ownerMatrixLocalpart('owner_probe' as OwnerId));
  if (registrationProbe.status !== 200 || !registrationProbe.lowercaseUserId
    || registrationProbe.loginStatus !== 200 || !registrationProbe.loginUserIdLowercase
    || escapedRegistrationProbe.status !== 200 || !escapedRegistrationProbe.exactUserId
    || escapedRegistrationProbe.loginStatus !== 200 || !escapedRegistrationProbe.loginUserIdExact) {
    throw new Error('production_registration_probes_unexpected');
  }
  const ownerId = 'owner_closure' as OwnerId;
  const ownerUserId = ownerMatrixUserId(ownerId, synapse.serverName);
  const controlLogin = await synapse.provision(ownerUserId, 'KHALA_CONTROL_LIVE');
  const browserALogin = await synapse.loginDevice(ownerUserId, controlLogin.password, 'OWNER_A');
  const browserBLogin = await synapse.loginDevice(ownerUserId, controlLogin.password, 'OWNER_B');
  const agentAIdentity = agentMatrixIdentity(ownerId, { harness: 'claude', sessionId: 'closure_a' } as never, synapse.serverName);
  const agentAUser = combined ? agentAIdentity.userId : `@khala_closure_a:${synapse.serverName}`;
  const agentBUser = `@khala_closure_b:${synapse.serverName}`;
  const agentPasswordSecret = '345-combined-agent-password-secret-'.repeat(2);
  const agentAPassword = createHmac('sha256', agentPasswordSecret).update('khala-matrix-agent-password-v1\0')
    .update(agentAUser).digest('base64url');
  const agentALogin = await synapse.provision(agentAUser, 'AGENT_A', combined ? agentAPassword : undefined);
  const agentBLogin = await synapse.provision(agentBUser, 'AGENT_B');
  const created = await synapse.api('/createRoom', controlLogin.access_token, 'POST', {
    visibility: 'private', invite: [agentAUser, agentBUser], initial_state: [
      { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
    ],
  });
  if (typeof created.room_id !== 'string') throw new Error('room_missing');
  const roomId = created.room_id as RoomId;
  await synapse.api(`/join/${encodeURIComponent(roomId)}`, agentALogin.access_token, 'POST', {});
  await synapse.api(`/join/${encodeURIComponent(roomId)}`, agentBLogin.access_token, 'POST', {});
  const principal = (id: OwnerId): AuthPrincipal => ({ v: 1, ownerId: id, providerIssuer: 'https://local-oidc.invalid',
    providerSubject: id, verifiedEmail: `${id}@example.test`, sessionExpiresAt: new Date(Date.now() + 3600_000).toISOString() });
  let appOrigin = '';
  const authenticate = (request: Request) => {
    const id = request.headers.get('cookie')?.includes('owner_session=fixture_owner') ? ownerId
      : request.headers.get('cookie')?.includes('owner_session=other_owner') ? 'other_owner' as OwnerId : null;
    return id ? { kind: 'authenticated' as const, context: { principal: principal(id) } } : { kind: 'signed_out' as const };
  };
  const auth = {
    async authenticateRequest(request: Request) { return authenticate(request); },
    async requireHumanMutation(request: Request) {
      const result = authenticate(request);
      if (result.kind !== 'authenticated') return { kind: 'refused', code: 'signed_out' };
      if (request.headers.get('origin') !== appOrigin
        || request.headers.get('x-csrf-token') !== 'closure-live-csrf') return { kind: 'refused', code: 'csrf_mismatch' };
      return { kind: 'authorized', context: result.context };
    },
  } as unknown as AuthService;
  const now = () => Date.now();
  const store = createControlStore({ records: stores.records, operations: stores.operations, clock: now });
  const bindingA = { v: 1, bindingId: 'binding_closure_a', ownerId, agentParticipantId: combined ? agentAIdentity.participantId : 'agent_closure_a',
    deviceId: 'AGENT_A', harness: 'claude', sessionId: 'closure_a', generation: 1 } as SessionBinding;
  const bindingB = { v: 1, bindingId: 'binding_closure_b', ownerId, agentParticipantId: 'agent_closure_b',
    deviceId: 'AGENT_B', harness: 'codex', sessionId: 'closure_b', generation: 1 } as SessionBinding;
  const bindings = createAgentBindingStore({ store });
  const index = createOwnerRoomIndex(store);
  for (const binding of [bindingA, bindingB]) {
    const put = await bindings.putParticipant({ ownerId, roomId, agentParticipantId: binding.agentParticipantId,
      expectedBindingId: null, record: { binding, revokedGeneration: null, capability: null } });
    if (put.kind !== 'applied' || (await index.activate(binding, roomId)).kind !== 'ok') throw new Error('binding_fixture_failed');
  }
  const authoritySecret = randomBytes(32).toString('hex');
  const tokenA = randomBytes(24).toString('base64url');
  const tokenB = randomBytes(24).toString('base64url');
  const signerA = createProofSigner(generateKeyPairSync('ed25519').privateKey);
  const signerB = createProofSigner(generateKeyPairSync('ed25519').privateKey);
  const proofs = new Set<string>();
  const capabilityDigest = (token: string) => createHash('sha256')
    .update(`khala.agent-bootstrap.capability-ref.v1\0${token}`).digest('base64url');
  if (combined) {
    const updated = await bindings.updateBinding(bindingA.bindingId, record => ({ ...record, capability: capabilityDigest(tokenA) }));
    if (updated !== 'applied') throw new Error('combined_capability_seed_failed');
  }
  const capabilities = {
    async authorize(request: Request, action: string) {
      const presented = request.headers.get('authorization');
      const selected = presented === `DPoP ${tokenA}` ? { binding: bindingA, token: tokenA, signer: signerA }
        : presented === `DPoP ${tokenB}` ? { binding: bindingB, token: tokenB, signer: signerB } : null;
      if (!selected || !['receive_released', 'ack_delivery'].includes(action)) return { kind: 'refused', status: 401, code: 'invalid_capability' };
      const checked = checkProof(request.headers.get('dpop'), { method: request.method, url: request.url,
        jkt: selected.signer.jkt, accessToken: selected.token, nowMs: now() });
      if (checked.kind !== 'valid' || proofs.has(checked.jti)) return { kind: 'refused', status: 401, code: 'invalid_proof' };
      proofs.add(checked.jti);
      const found = await bindings.locateBinding(selected.binding.bindingId);
      if (found.kind !== 'found' || found.record.revokedGeneration !== null) return { kind: 'refused', status: 403, code: 'binding_revoked' };
      return { kind: 'authorized', action, ownerId, roomId, binding: selected.binding };
    },
    async lookupBinding(bindingId: string) {
      const found = await bindings.locateBinding(bindingId);
      return found.kind === 'found' ? { kind: 'found', ownerId, deviceId: found.record.binding.deviceId,
        generation: found.record.revokedGeneration ?? found.record.binding.generation,
        status: found.record.revokedGeneration === null ? 'active' : 'revoked' } : { kind: 'absent' };
    },
    async disableBinding(input: { bindingId: string; expectedGeneration: number; revokedGeneration: number }) {
      const updated = await bindings.updateBinding(input.bindingId, record =>
        record.revokedGeneration === null && record.binding.generation === input.expectedGeneration
          ? { ...record, revokedGeneration: input.revokedGeneration, capability: null } : null);
      return { kind: updated === 'applied' ? 'applied' : 'stale' };
    },
    async revokeAdapterCapability() { return { kind: 'applied' }; },
    async authorizeRevocationCleanup(request: Request) {
      if (!combined || request.headers.get('authorization') !== `DPoP ${tokenA}`
        || request.headers.get('x-khala-binding-id') !== bindingA.bindingId) {
        return { kind: 'refused', status: 401, code: 'invalid_capability' };
      }
      const checked = checkProof(request.headers.get('dpop'), { method: request.method, url: request.url,
        jkt: signerA.jkt, accessToken: tokenA, nowMs: now() });
      if (checked.kind !== 'valid' || proofs.has(checked.jti)) return { kind: 'refused', status: 401, code: 'invalid_proof' };
      proofs.add(checked.jti);
      const found = await bindings.locateBinding(bindingA.bindingId);
      return found.kind === 'found' && found.record.revokedGeneration === bindingA.generation + 1
        ? { kind: 'authorized', ownerId, roomId, binding: bindingA,
          revokedGeneration: found.record.revokedGeneration, capabilityDigest: capabilityDigest(tokenA) }
        : { kind: 'refused', status: 401, code: 'binding_not_revoked' };
    },
  } as unknown as AdapterCapabilities;
  async function membership() {
    try {
      const response = await synapse.api(`/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(ownerUserId)}`,
        controlLogin.access_token, 'GET');
      return response.membership === 'join' ? { kind: 'joined' as const } : { kind: 'absent' as const };
    } catch { return { kind: 'unavailable' as const }; }
  }
  const mailboxRoutes = createOwnerMailboxRoutes({ auth, store, capabilities, clock: now, authoritySecret,
    gateway: { inspectMembership: async () => membership() } as never,
    inspectOwnerMembership: async () => membership(), lookupAgentDevice: async () => null });
  const sessionIssuer = { async issue() { return { kind: 'ok' as const, session: {
    homeserverOrigin: synapse.baseUrl, userId: ownerUserId, accessToken: controlLogin.access_token,
    deviceId: 'KHALA_CONTROL_LIVE' as never, publishedFingerprint: null,
  } }; }, async resolveParticipants() { return { kind: 'unavailable' as const }; } };
  const closure = createChannelClosureHandlers({ auth,
    cleanupRequests: ownerPrincipal => createOwnerCleanupRequests(store, ownerPrincipal.ownerId).list(),
    service: ownerPrincipal => createChannelClosureService({ principal: ownerPrincipal, store,
      transport: createMatrixClosureTransport({ principal: ownerPrincipal, sessions: sessionIssuer,
        homeserverOrigin: 'https://matrix.invalid',
        fetch: ((input: string | URL | Request, init?: RequestInit) => fetch(String(input).replace('https://matrix.invalid', synapse.baseUrl), init)) as typeof fetch,
        connector: createProtectedClosureConnector({ store, principal: ownerPrincipal, clock: now, authoritySecret }),
        cleanup: createOwnerCleanupRequests(store, ownerPrincipal.ownerId),
      }),
    }),
  });

  const peerRoot = path.resolve('apps/web/fixtures/closure-live');
  const peerBundle = path.join(directory, 'browser-bundle');
  await build({ root: peerRoot, configFile: false, logLevel: 'error', build: { outDir: peerBundle, emptyOutDir: true } });
  const cert = path.join(directory, 'server.crt');
  const key = path.join(directory, 'server.key');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-subj', '/CN=127.0.0.1', '-days', '1'], { stdio: 'ignore' });
  server = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) }, async (incoming, outgoing) => {
    const pathname = new URL(incoming.url ?? '/', appOrigin).pathname;
    try {
      if (pathname === '/api/human/channel-closure') {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const request = new Request(`${appOrigin}${incoming.url}`, { method: incoming.method ?? 'GET',
          headers: incoming.headers as HeadersInit,
          ...(incoming.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
        const response = await closure[0]!.handle(request);
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, name) => { responseHeaders[name] = value; });
        outgoing.writeHead(response.status, responseHeaders).end(Buffer.from(await response.arrayBuffer()));
        return;
      }
      const filename = path.resolve(peerBundle, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!filename.startsWith(`${peerBundle}${path.sep}`)) { outgoing.writeHead(404).end(); return; }
      const bytes = await readFile(filename);
      outgoing.writeHead(200, { 'content-type': filename.endsWith('.js') ? 'text/javascript'
        : filename.endsWith('.wasm') ? 'application/wasm' : 'text/html' }).end(bytes);
    } catch { if (!outgoing.headersSent) outgoing.writeHead(503).end(); }
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('app_server_unavailable');
  appOrigin = `https://127.0.0.1:${address.port}`;
  const requireDriver = createRequire(path.resolve('apps/connector/package.json'));
  const { chromium } = requireDriver('playwright-core') as typeof import('../../apps/connector/node_modules/playwright-core');
  type BrowserPage = Awaited<ReturnType<(typeof contexts)[number]['newPage']>>;
  async function openBrowser(name: string, login: typeof browserALogin) {
    const context = await chromium.launchPersistentContext(path.join(directory, name), {
      executablePath: '/usr/bin/chromium', headless: true, ignoreHTTPSErrors: true,
    });
    contexts.push(context);
    await context.addCookies([{ name: 'owner_session', value: 'fixture_owner', url: appOrigin }]);
    const page = await context.newPage();
    await page.goto(appOrigin);
    await page.waitForFunction(() => !!(window as unknown as { closureFixture?: unknown }).closureFixture);
    const opened = await page.evaluate(async input => (window as unknown as { closureFixture: {
      open(input: unknown): Promise<{ roomKnown: boolean; deviceId: string }> } }).closureFixture.open(input), {
      appOrigin, baseUrl: synapse.baseUrl, ownerId, userId: ownerUserId, deviceId: login.device_id,
      accessToken: login.access_token, roomId, storeName: name,
    });
    if (!opened.roomKnown || opened.deviceId !== login.device_id) throw new Error('owner_browser_room_missing');
    return { context, page };
  }
  const browserA = await openBrowser('browser-a', browserALogin);
  const browserB = await openBrowser('browser-b', browserBLogin);
  const substrateBundle = path.join(directory, 'substrate-browser');
  if (combined) await build({ root: path.resolve('apps/connector/substrate-browser'),
    configFile: false, logLevel: 'error',
    build: { outDir: substrateBundle, emptyOutDir: true } });
  agentSubstrate = combined ? await openMatrixConnectorSubstrate({ baseUrl: synapse.baseUrl,
    userId: agentAUser, deviceId: agentALogin.device_id, accessToken: agentALogin.access_token, roomId,
    profileDirectory: path.join(directory, 'agent-substrate'), participantIdFor: () => null,
    chromiumExecutablePath: '/usr/bin/chromium', browserBundleDirectory: substrateBundle,
    browserDriverDirectory: path.resolve('apps/connector/node_modules/playwright-core'),
  }) : null;
  const browserCall = (page: BrowserPage, action: 'start' | 'poll' | 'status' | 'close' | 'discard') => page.evaluate(async name =>
    (window as unknown as { closureFixture: Record<string, () => unknown> }).closureFixture[name]!(), action);
  await browserCall(browserA.page, 'start');
  if (!combined) {
    await browserCall(browserB.page, 'close');
    await browserB.context.close();
  }

  const limits = decodeDeliveryLimits({ maxPayloadBytes: 64 * 1024, maxSelectionEvents: 32 });
  if (!limits.ok) throw new Error('connector_limits_invalid');
  const localA = await openConnectorStorage({ directory: path.join(directory, 'connector-a'), mode: 'create', limits: limits.value });
  const localB = await openConnectorStorage({ directory: path.join(directory, 'connector-b'), mode: 'create', limits: limits.value });
  let localBClosed = false;
  try {
    for (const [local, binding] of [[localA, bindingA], [localB, bindingB]] as const) {
      const stored = await local.ledger.transaction(tx => tx.putBinding(binding));
      if (stored.kind !== 'inserted') throw new Error('connector_binding_failed');
    }
    const stopA = createLocalClosureFence({ storage: localA, binding: bindingA, roomId,
      stateDirectory: path.join(directory, 'connector-a'), clock: now, quiesce: async () => {} });
    const stopB = createLocalClosureFence({ storage: localB, binding: bindingB, roomId,
      stateDirectory: path.join(directory, 'connector-b'), clock: now, quiesce: async () => {} });
    const matrixAgents = combined ? createMatrixAgentAdmission({
      homeserverOrigin: 'https://matrix.invalid', serverName: synapse.serverName,
      registrationSharedSecret: '345-combined-registration-secret-'.repeat(2),
      passwordDerivationSecret: agentPasswordSecret,
      invitationHmacSecret: '345-combined-invitation-secret-'.repeat(2),
      store, clock: now,
      fetch: ((input: string | URL | Request, init?: RequestInit) =>
        fetch(String(input).replace('https://matrix.invalid', synapse.baseUrl), init)) as typeof fetch,
    }) : null;
    let agentKey: string | null = null;
    if (matrixAgents) {
      for (let attempt = 0; attempt < 30 && !agentKey; attempt++) {
        agentKey = await matrixAgents.publishedDeviceIdentityKey(bindingA);
        if (!agentKey) await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (!agentKey) throw new Error('combined_agent_device_key_missing');
    }
    let removalCalled = 0;
    let localStopReceiptObserved = false;
    let endpointRemovalAfterReceipt = false;
    let endpointRemoval: string | null = null;
    let revocationEndpoint: string | null = null;
    let cleanupHttpStatus = 0;
    let resultHttpStatus = 0;
    let roster: Array<{ senderId: string; deviceId: string; deviceKey: string }> = [];
    const revocationRoutes = combined && matrixAgents ? createOwnerRevocationRoutes({
      auth, store, capabilities: capabilities as never,
      deviceIdentityKey: binding => matrixAgents.publishedDeviceIdentityKey(binding),
      inspectOwnerMembership: async () => membership(),
      async inspectRoomSenderDevices() {
        const query = await synapse.api('/keys/query', controlLogin.access_token, 'POST', {
          device_keys: { [ownerUserId]: [], [agentAUser]: [], [agentBUser]: [] },
        }) as { device_keys?: Record<string, Record<string, { keys?: Record<string, string> }>> };
        const senders = Object.entries(query.device_keys ?? {}).flatMap(([userId, devices]) =>
          Object.entries(devices).flatMap(([deviceId, value]) => {
            const deviceKey = value.keys?.[`curve25519:${deviceId}`];
            return typeof deviceKey === 'string' ? [{ senderId: senderIdFor(userId, deviceId), deviceId, deviceKey }] : [];
          }));
        roster = senders;
        return senders.some(sender => sender.deviceId === bindingA.deviceId)
          ? { kind: 'ok' as const, senders } : { kind: 'unavailable' as const };
      },
      protocolFor: selectedOwner => createCleanupProtocolPort(store, selectedOwner, {
        async remove(input) {
          removalCalled += 1;
          return input.bindingId === bindingA.bindingId && input.deviceKey === agentKey
            ? matrixAgents.removePublishedDeviceWithUIA(bindingA, input.deviceKey) : 'unavailable';
        },
        async status(input) {
          return input.bindingId === bindingA.bindingId && input.deviceKey === agentKey
            ? matrixAgents.inspectPublishedDevice(bindingA, input.deviceKey) : 'unavailable';
        },
      }),
    }) : [];
    const revocationCleanupRoutes = combined ? createAgentRevocationCleanupRoutes({ store,
      capabilities: capabilities as never }) : [];
    const agentRoutes = mailboxRoutes.agent;
    const dispatchAgent = async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const pathname = new URL(request.url).pathname;
      const audit = pathname === '/api/agent/revocation/result' ? request.clone() : null;
      const route = [...agentRoutes, ...revocationCleanupRoutes].find(item => item.path === pathname);
      const response = route ? await route.handle(request) : new Response(null, { status: 404 });
      if (pathname === '/api/agent/revocation/cleanup') cleanupHttpStatus = response.status;
      if (pathname === '/api/agent/revocation/result') resultHttpStatus = response.status;
      if (audit && response.status === 200) {
        const body = await audit.json() as { removal?: string | null };
        if (body.removal === null) localStopReceiptObserved = true;
      }
      return response;
    };
    const capability = (binding: SessionBinding, token: string) => async () => ({ token,
      scope: ['receive_released', 'ack_delivery'] as const, bindingId: binding.bindingId,
      generation: binding.generation, expiresAt: now() + 3600_000 });
    const mailboxA = createProductionOwnerMailbox({ appOrigin, binding: bindingA, signer: signerA,
      capability: capability(bindingA, tokenA), stop: request => stopA.stop(request),
      onRevoked: async () => {}, fetch: dispatchAgent as typeof fetch });
    const mailboxB = createProductionOwnerMailbox({ appOrigin, binding: bindingB, signer: signerB,
      capability: capability(bindingB, tokenB), stop: request => stopB.stop(request),
      onRevoked: async () => {}, fetch: dispatchAgent as typeof fetch });
    const revokeOperationId = 'revoke_then_close_live_344_345';
    const revokeBody = { operationId: revokeOperationId, targetKind: 'binding',
      targetId: bindingA.bindingId, expectedGeneration: bindingA.generation };
    const revoke = async () => {
      const selected = revocationRoutes.find(route => route.path === '/api/human/revocation/revoke');
      if (!selected) throw new Error('combined_revocation_route_missing');
      const response = await selected.handle(new Request(`${appOrigin}${selected.path}`, {
        method: 'POST', headers: { cookie: 'owner_session=fixture_owner', origin: appOrigin,
          'x-csrf-token': 'closure-live-csrf', 'content-type': 'application/json' }, body: JSON.stringify(revokeBody),
      }));
      if (response.status !== 200) throw new Error(`combined_revoke_http_${response.status}`);
      return response.json() as Promise<{ kind: string; value?: { state: string } }>;
    };
    const revocationStatus = async () => {
      const selected = revocationRoutes.find(route => route.path === '/api/human/revocation/status');
      if (!selected) throw new Error('combined_revocation_status_missing');
      const response = await selected.handle(new Request(`${appOrigin}${selected.path}?operationId=${revokeOperationId}`,
        { headers: { cookie: 'owner_session=fixture_owner' } }));
      if (response.status !== 200) throw new Error(`combined_revocation_status_http_${response.status}`);
      return response.json() as Promise<{ kind: string; value?: { control: string; removal: string; rotation: string; endpoint: string } }>;
    };
    const sendCanary = (body: string) => browserA.page.evaluate(async message =>
      (window as unknown as { closureFixture: { send(body: string): Promise<string> } }).closureFixture.send(message), body);
    const outboundSession = async (eventId: string) => {
      const event = await synapse.api(`/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`,
        controlLogin.access_token, 'GET');
      const content = event.content as { session_id?: string } | undefined;
      if (event.type !== 'm.room.encrypted' || typeof content?.session_id !== 'string') {
        throw new Error('combined_ciphertext_missing_session');
      }
      return content.session_id;
    };
    const beforeSession = combined ? await outboundSession(await sendCanary('before-revocation-canary')) : null;
    if (combined) {
      const firstRevocation = await revoke();
      const firstStatus = await revocationStatus();
      if (firstRevocation.kind !== 'ok' || firstStatus.value?.control !== 'disabled'
        || firstStatus.value?.removal !== 'removed'
        || await matrixAgents!.inspectPublishedDevice(bindingA, agentKey!) !== 'removed') {
        throw new Error(`combined_revoke_control_not_disabled_${firstRevocation.kind}_${firstStatus.value?.control ?? 'missing'}`);
      }
      const revoked = await bindings.locateBinding(bindingA.bindingId);
      if (revoked.kind !== 'found' || revoked.record.revokedGeneration !== bindingA.generation + 1
        || localStopReceiptObserved || removalCalled < 1) throw new Error('combined_offline_removal_or_stop_state_wrong');
      const ordinaryPoll = `${appOrigin}/api/agent/owner-mailbox/poll`;
      const deniedBeforeClosure = await dispatchAgent(ordinaryPoll, { method: 'GET', headers: {
        authorization: `DPoP ${tokenA}`, dpop: signerA.proof('GET', ordinaryPoll, tokenA), origin: appOrigin,
      } });
      if (deniedBeforeClosure.status !== 403) throw new Error('combined_revoked_ordinary_poll_allowed');
    }
    const operationId = 'close_live_operation_345';
    const command = { operationId, ownerId, roomId, expectedRoomRevision: 0 };
    const ownerPost = (value: unknown, cookie = 'owner_session=fixture_owner') => closure[0]!.handle(new Request(`${appOrigin}/api/human/channel-closure`, {
      method: 'POST', headers: { cookie, origin: appOrigin, 'x-csrf-token': 'closure-live-csrf',
        'content-type': 'application/json' }, body: JSON.stringify(value),
    }));
    const wrongOwner = await ownerPost(command, 'owner_session=other_owner');
    const staleRevision = await ownerPost({ ...command, expectedRoomRevision: 1 });
    const wrongRoom = await ownerPost({ ...command, roomId: '!other-room:khala-closure.invalid' });
    if (wrongOwner.status !== 403 || staleRevision.status !== 400 && staleRevision.status !== 409
      || wrongRoom.status === 200) {
      throw new Error('owner_or_revision_refusal_missing');
    }
    const first = await ownerPost(command);
    const firstBody = await first.json() as { value?: { state: string } };
    if (first.status !== 200 || firstBody.value?.state !== 'partial') throw new Error('initial_closure_not_partial');
    const marker = await index.inspect(ownerId, roomId);
    if (marker.kind !== 'ok' || !marker.value?.marker || marker.value.marker.operationId !== operationId) throw new Error('closure_marker_missing');
    const newBinding = { ...bindingA, bindingId: 'binding_after_marker', agentParticipantId: 'agent_after_marker' } as SessionBinding;
    if ((await index.activate(newBinding, roomId)).kind !== 'closed') throw new Error('post_marker_admission_accepted');
    if (combined) {
      if (await mailboxB.pollOnce() !== 'revoked') throw new Error('combined_surviving_binding_stop_missing');
      const withoutA = await ownerPost(command);
      const withoutABody = await withoutA.json() as { value?: { state: string } };
      if (withoutABody.value?.state !== 'partial' || localStopReceiptObserved
        || (await membership()).kind !== 'joined') throw new Error('combined_absent_local_stop_did_not_hold_closure');
    }
    let firstStop: string;
    if (combined) {
      const cleanup = createProductionRevocationCleanup({ appOrigin, binding: bindingA, signer: signerA,
        existingCapability: capability(bindingA, tokenA),
        stop: operationId => stopA.stop({ operationId, ownerId, roomId, expectedRoomRevision: 0 }),
        async removeOwnDevice(deviceKey) {
          endpointRemovalAfterReceipt = localStopReceiptObserved;
          endpointRemoval = await agentSubstrate!.removeOwnDevice(deviceKey);
          return endpointRemoval as 'removed' | 'replaced' | 'reauthentication_required' | 'forbidden' | 'unavailable';
        },
        fetch: dispatchAgent as typeof fetch,
      });
      firstStop = await cleanup.pollOnce();
      if (!localStopReceiptObserved || !endpointRemovalAfterReceipt || endpointRemoval === null) {
        throw new Error(`combined_local_stop_result_missing_${firstStop}_${cleanupHttpStatus}_${resultHttpStatus}`);
      }
    } else firstStop = await mailboxA.pollOnce();
    if (combined ? !['pending', 'complete'].includes(firstStop) : firstStop !== 'revoked') {
      throw new Error('first_connector_stop_missing');
    }
    if (!combined) {
      const afterOne = await ownerPost(command);
      const afterOneBody = await afterOne.json() as { value?: { state: string } };
      if (afterOneBody.value?.state !== 'partial' || (await membership()).kind !== 'joined') throw new Error('single_receipt_left_room');
    }
    if (combined) {
      const fence = createRoomSendFence(store);
      const held = await fence.inspect(roomId);
      if (held.kind !== 'found' || held.value.hold?.operationId !== revokeOperationId
        || !beforeSession) throw new Error('combined_rotation_hold_missing');
      for (const browser of [browserA, browserB]) {
        await browserCall(browser.page, 'discard');
        const deviceId = browser === browserA ? browserALogin.device_id : browserBLogin.device_id;
        const sender = roster.find(item => item.deviceId === deviceId);
        if (!sender || await fence.acknowledgeRotation(roomId, sender, revokeOperationId,
          held.value.hold.epoch) !== 'applied') throw new Error('combined_sender_rotation_missing');
      }
      if (await fence.rotationStatus(roomId, revokeOperationId) !== 'rotated') throw new Error('combined_rotation_pending');
      const completedRevocation = await revoke();
      const finalStatus = await revocationStatus();
      revocationEndpoint = finalStatus.value?.endpoint ?? null;
      if (completedRevocation.kind !== 'ok' || finalStatus.value?.removal !== 'removed'
        || finalStatus.value.rotation !== 'rotated') {
        throw new Error('combined_revocation_not_rotated');
      }
      const afterSession = await outboundSession(await sendCanary('after-revocation-canary'));
      if (afterSession === beforeSession) throw new Error('combined_outbound_session_unchanged');
      await browserCall(browserB.page, 'close');
      await browserB.context.close();
    }
    if (!combined) {
      // A forged B receipt cannot replace B's actual local stop. The protected route validates exact generation.
      const completeUrl = `${appOrigin}/api/agent/owner-mailbox/complete`;
      const forged = await dispatchAgent(completeUrl, { method: 'POST', headers: {
        authorization: `DPoP ${tokenB}`, dpop: signerB.proof('POST', completeUrl, tokenB),
        'content-type': 'application/json', origin: appOrigin,
      }, body: JSON.stringify({ bindingId: bindingB.bindingId, operationId, outcome: { kind: 'stopped', receipt: {
        ...command, bindingId: bindingB.bindingId, bindingGeneration: bindingB.generation + 1,
        state: 'stopped', cleanupRequested: true,
      } } }) });
      if (forged.status !== 409 || (await membership()).kind !== 'joined') throw new Error('forged_receipt_accepted');
      const secondStop = await mailboxB.pollOnce();
      if (secondStop !== 'revoked') throw new Error('second_connector_stop_missing');
    }
    const final = await ownerPost(command);
    const finalBody = await final.json() as { value?: { state: string; reason: string | null } };
    if (final.status !== 200 || finalBody.value?.state !== 'complete' || finalBody.value.reason !== null) throw new Error('closure_not_complete');
    const joinedAfterClosure = await synapse.api('/joined_rooms', controlLogin.access_token, 'GET');
    if (!Array.isArray(joinedAfterClosure.joined_rooms) || joinedAfterClosure.joined_rooms.includes(roomId)) {
      throw new Error('owner_still_joined_after_complete');
    }
    for (const [binding, token, signer] of [[bindingA, tokenA, signerA], [bindingB, tokenB, signerB]] as const) {
      const pollUrl = `${appOrigin}/api/agent/owner-mailbox/poll`;
      const denied = await dispatchAgent(pollUrl, { method: 'GET', headers: {
        authorization: `DPoP ${token}`, dpop: signer.proof('GET', pollUrl, token), origin: appOrigin,
      } });
      if (denied.status !== 403) throw new Error(`future_agent_release_allowed_${binding.bindingId}`);
    }
    const stoppedA = await localA.ledger.transaction(tx => tx.readApprovalSnapshot({ bindingId: bindingA.bindingId, selection: [] }));
    const stoppedB = await localB.ledger.transaction(tx => tx.readApprovalSnapshot({ bindingId: bindingB.bindingId, selection: [] }));
    if (stoppedA?.kind !== 'revoked' || stoppedB?.kind !== 'revoked') throw new Error('connector_ledger_not_revoked');
    const ordinary = mailboxRoutes.human.find(item => item.path === '/api/human/owner-mailbox/submit')!;
    const releaseAfterMarker = await ordinary.handle(new Request(`${appOrigin}${ordinary.path}`, { method: 'POST',
      headers: { cookie: 'owner_session=fixture_owner', origin: appOrigin, 'x-csrf-token': 'closure-live-csrf',
        'content-type': 'application/json' },
      body: JSON.stringify({ bindingId: bindingA.bindingId, operationId: 'status_after_stop', kind: 'controls_status',
        body: { bindingId: bindingA.bindingId } }),
    }));
    if (releaseAfterMarker.status !== 403) throw new Error('future_mailbox_control_accepted');
    const cleanupRead = await closure[0]!.handle(new Request(`${appOrigin}/api/human/channel-closure?cleanup=1`,
      { headers: { cookie: 'owner_session=fixture_owner' } }));
    const cleanupBody = await cleanupRead.json() as { value?: unknown[] };
    if (cleanupRead.status !== 200 || cleanupBody.value?.length !== 1
      || JSON.stringify(cleanupBody.value[0]) !== JSON.stringify(command)) throw new Error('cleanup_request_missing');
    const browserHttp = await browserA.page.evaluate(async () => {
      const response = await fetch('/api/human/channel-closure?cleanup=1', { credentials: 'same-origin' });
      const body: unknown = await response.json();
      return { status: response.status, kind: typeof body === 'object' && body !== null && 'kind' in body ? body.kind : null,
        count: typeof body === 'object' && body !== null && 'value' in body && Array.isArray(body.value) ? body.value.length : -1 };
    });
    if (browserHttp.status !== 200 || browserHttp.kind !== 'ok' || browserHttp.count !== 1) {
      throw new Error(`browser_cleanup_http_${browserHttp.status}_${browserHttp.kind}_${browserHttp.count}`);
    }
    let liveBrowser = { attempts: 0, successes: 0, roomKnown: true };
    for (let attempt = 0; attempt < 30 && liveBrowser.successes < 1; attempt++) {
      await browserCall(browserA.page, 'poll');
      liveBrowser = await browserCall(browserA.page, 'status') as typeof liveBrowser;
      if (liveBrowser.successes < 1) await new Promise(resolve => setTimeout(resolve, 500));
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      await browserCall(browserA.page, 'poll');
      liveBrowser = await browserCall(browserA.page, 'status') as typeof liveBrowser;
    }
    if (liveBrowser.attempts < 1 || liveBrowser.successes < 1 || liveBrowser.roomKnown) {
      throw new Error(`online_browser_cleanup_failed_${liveBrowser.attempts}_${liveBrowser.successes}_${liveBrowser.roomKnown}`);
    }
    const restartedBrowser = await openBrowser('browser-b', browserBLogin);
    await browserCall(restartedBrowser.page, 'start');
    let offlineBrowser = { attempts: 0, successes: 0, roomKnown: true };
    for (let attempt = 0; attempt < 30 && offlineBrowser.successes < 1; attempt++) {
      await browserCall(restartedBrowser.page, 'poll');
      offlineBrowser = await browserCall(restartedBrowser.page, 'status') as typeof offlineBrowser;
      if (offlineBrowser.successes < 1) await new Promise(resolve => setTimeout(resolve, 500));
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      await browserCall(restartedBrowser.page, 'poll');
      offlineBrowser = await browserCall(restartedBrowser.page, 'status') as typeof offlineBrowser;
    }
    if (offlineBrowser.attempts < 1 || offlineBrowser.successes < 1 || offlineBrowser.roomKnown) {
      throw new Error(`restarted_browser_cleanup_failed_${offlineBrowser.attempts}_${offlineBrowser.successes}_${offlineBrowser.roomKnown}_${(offlineBrowser as typeof offlineBrowser & { membership?: string }).membership ?? 'none'}_${(offlineBrowser as typeof offlineBrowser & { syncState?: string }).syncState ?? 'none'}_${(offlineBrowser as typeof offlineBrowser & { absentImmediatelyAfterForget?: boolean }).absentImmediatelyAfterForget ?? 'unknown'}`);
    }
    const repeat = await ownerPost(command);
    const repeatBody = await repeat.json() as { value?: { state: string; operationId: string } };
    if (repeatBody.value?.state !== 'complete' || repeatBody.value.operationId !== operationId) throw new Error('retry_identity_changed');
    await localB.close();
    localBClosed = true;
    const restartedLedger = await openConnectorStorage({ directory: path.join(directory, 'connector-b'), mode: 'existing', limits: limits.value });
    try {
      const prior = await restartedLedger.ledger.transaction(tx => tx.readApprovalSnapshot({ bindingId: bindingB.bindingId, selection: [] }));
      if (prior?.kind !== 'revoked') throw new Error('restarted_connector_reopened_delivery');
    } finally { await restartedLedger.close(); }
    console.log(JSON.stringify({ synapseVersion: synapse.version,
      registrationProbe: 'mixed_case_canonicalized', escapedRegistrationProbe: 'exact_login',
      ownerRoute: combined ? 'revocation_then_closure_authenticated_fixture' : 'authenticated_fixture',
      marker: 'durable', indexedBindings: 2,
      ...(combined ? { absentRevokedStop: 'partial_joined_with_other_stop',
        exactDeviceRemoval: 'synapse_verified', localStop: 'durable_control_receipt',
        endpointRemovalAfterReceipt, endpointRemoval, roomSenderRotation: 'all_verified',
        sdkOutboundSession: 'changed', revocationControl: 'disabled', revocationRotation: 'rotated',
        revocationEndpoint, ordinaryPollBeforeClosure: 'blocked' }
        : { firstReceipt: 'partial_joined', forgedReceipt: 'rejected' }),
      secondReceipt: 'complete_left', futureAdmission: 'blocked', futureMailboxControl: 'blocked',
      connectorLedgers: 'revoked_after_restart', cleanupRequest: 'durable',
      browserDevices: 2, offlineBrowserRestart: 'processed', sdkForget: 'both_succeeded',
      onlineCleanupAttempts: liveBrowser.attempts, restartedCleanupAttempts: offlineBrowser.attempts,
      retryOperation: 'stable' }));
  } finally { await localA.close(); if (!localBClosed) await localB.close(); }
} finally {
  await agentSubstrate?.close();
  await Promise.all(contexts.map(context => context.close()));
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  stores.close();
  synapse.close();
  await rm(directory, { recursive: true, force: true });
}
