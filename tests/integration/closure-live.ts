/// <reference lib="dom" />
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
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
import { createProductionOwnerMailbox } from '../../apps/connector/src/composition/agent/owner-mailbox';
import { createLocalClosureFence } from '../../apps/connector/src/composition/closure/local-fence';
import { openConnectorStorage } from '../../packages/connector/src/storage/open';
import { decodeDeliveryLimits } from '../../packages/contracts/src/delivery/index';
import type { AuthPrincipal, OwnerId, RoomId, SessionBinding } from '../../packages/contracts/src/messaging/index';
import type { AuthService } from '../../apps/control/src/auth/index';
import type { AdapterCapabilities } from '../../apps/control/src/agent-bootstrap/handler';
import { openClosureFixtureStores } from './fixtures/closure-cas';
import { startClosureSynapse } from './fixtures/closure-synapse';

const directory = await mkdtemp(path.join(os.homedir(), '.cache', 'khala-345-live-'));
const synapse = await startClosureSynapse();
const contexts: Array<Awaited<ReturnType<typeof import('../../apps/connector/node_modules/playwright-core').chromium.launchPersistentContext>>> = [];
let server: ReturnType<typeof createHttpsServer> | null = null;
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
  const agentAUser = `@khala_closure_a:${synapse.serverName}`;
  const agentBUser = `@khala_closure_b:${synapse.serverName}`;
  const agentALogin = await synapse.provision(agentAUser, 'AGENT_A');
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
  const bindingA = { v: 1, bindingId: 'binding_closure_a', ownerId, agentParticipantId: 'agent_closure_a',
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
      return { kind: 'authorized', action, ownerId, roomId, binding: selected.binding };
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
  const browserCall = (page: BrowserPage, action: 'start' | 'poll' | 'status' | 'close') => page.evaluate(async name =>
    (window as unknown as { closureFixture: Record<string, () => unknown> }).closureFixture[name]!(), action);
  await browserCall(browserA.page, 'start');
  await browserCall(browserB.page, 'close');
  await browserB.context.close();

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
    const agentRoutes = mailboxRoutes.agent;
    const dispatchAgent = async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const route = agentRoutes.find(item => item.path === new URL(request.url).pathname);
      return route ? route.handle(request) : new Response(null, { status: 404 });
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
    const firstStop = await mailboxA.pollOnce();
    if (firstStop !== 'revoked') throw new Error('first_connector_stop_missing');
    const afterOne = await ownerPost(command);
    const afterOneBody = await afterOne.json() as { value?: { state: string } };
    if (afterOneBody.value?.state !== 'partial' || (await membership()).kind !== 'joined') throw new Error('single_receipt_left_room');
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
      ownerRoute: 'authenticated_fixture',
      marker: 'durable', indexedBindings: 2, firstReceipt: 'partial_joined', forgedReceipt: 'rejected',
      secondReceipt: 'complete_left', futureAdmission: 'blocked', futureMailboxControl: 'blocked',
      connectorLedgers: 'revoked_after_restart', cleanupRequest: 'durable',
      browserDevices: 2, offlineBrowserRestart: 'processed', sdkForget: 'both_succeeded',
      onlineCleanupAttempts: liveBrowser.attempts, restartedCleanupAttempts: offlineBrowser.attempts,
      retryOperation: 'stable' }));
  } finally { await localA.close(); if (!localBClosed) await localB.close(); }
} finally {
  await Promise.all(contexts.map(context => context.close()));
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  stores.close();
  synapse.close();
  await rm(directory, { recursive: true, force: true });
}
