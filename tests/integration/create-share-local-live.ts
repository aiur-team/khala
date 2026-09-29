import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createControlStore } from '../../apps/control/src/runtime/control-store';
import { createMatrixHumanServices } from '../../apps/control/src/composition/human/matrix';
import { ownerMatrixUserId } from '../../apps/control/src/composition/human/matrix-identity';
import { createAdmissionService } from '../../apps/control/src/invitations';
import { createHumanHandlers, SHARE_PATH } from '../../apps/control/src/composition/human/handlers';
import type { AuthService } from '../../apps/control/src/auth';
import type { AuthPrincipal, OwnerId, RoomId } from '../../packages/contracts/src/messaging';
import { openClosureFixtureStores } from './fixtures/closure-cas';
import { startClosureSynapse } from './fixtures/closure-synapse';

const directory = await mkdtemp(path.join(os.tmpdir(), 'khala-create-share-'));
const synapse = await startClosureSynapse();
const stores = openClosureFixtureStores(path.join(directory, 'control.sqlite'));
try {
  const ownerId = 'owner_create_share_local' as OwnerId;
  const userId = ownerMatrixUserId(ownerId, synapse.serverName);
  const passwordSecret = 'create-share-local-password-secret-'.repeat(2);
  const password = createHmac('sha256', passwordSecret)
    .update('khala-matrix-password-v1\0').update(ownerId).digest('base64url');
  const browser = await synapse.provision(userId, 'BROWSER_LOCAL', password);
  const created = await synapse.api('/createRoom', browser.access_token, 'POST', {
    visibility: 'private',
    preset: 'private_chat',
    initial_state: [
      { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
      { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'joined' } },
    ],
  });
  if (typeof created.room_id !== 'string') throw new Error('create_room_id_missing');
  const roomId = created.room_id as RoomId;
  const store = createControlStore({ records: stores.records, operations: stores.operations, clock: Date.now });
  const matrix = createMatrixHumanServices({
    homeserverOrigin: 'https://matrix.invalid', serverName: synapse.serverName,
    registrationSharedSecret: 'local-registration-secret-'.repeat(2),
    passwordDerivationSecret: passwordSecret, store,
    fetch: ((input: string | URL | Request, init?: RequestInit) =>
      fetch(String(input).replace('https://matrix.invalid', synapse.baseUrl), init)) as typeof fetch,
  });
  const principal: AuthPrincipal = {
    v: 1, ownerId, providerIssuer: 'https://local.invalid', providerSubject: ownerId,
    verifiedEmail: 'local@example.test', sessionExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
  const admission = createAdmissionService({
    store, identity: { current: async () => ({ kind: 'signed_in', principal }) } as never,
    authority: matrix.authority, gateway: matrix.gateway, clock: Date.now,
    origin: 'https://khala.aiur.team', allowedOrigins: ['https://khala.aiur.team'],
    secret: 'local-invitation-secret-'.repeat(2), inviteLifetimeMs: 7 * 24 * 60 * 60_000,
  });
  const auth = { requireHumanMutation: async () => ({ kind: 'authorized', context: { principal, csrfToken: 'local' } }) } as unknown as AuthService;
  const route = createHumanHandlers(() => ({ auth, admission, messaging: matrix.sessions }))
    .find(item => item.path === SHARE_PATH);
  if (!route) throw new Error('share_route_missing');
  const request = () => new Request(`https://khala.aiur.team${SHARE_PATH}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://khala.aiur.team', 'x-khala-csrf': 'local' },
    body: JSON.stringify({ operationId: 'share_create_local_1', roomId, policy: { v: 1, kind: 'link', history: 'none' } }),
  });
  const first = await route.handle(request());
  const firstBody = await first.json() as { kind?: string; value?: { shareUrl?: string }; code?: string };
  if (first.status !== 200 || firstBody.kind !== 'ok' || !firstBody.value?.shareUrl?.includes('/join/')) {
    throw new Error(`share_http_${first.status}_${firstBody.code ?? firstBody.kind ?? 'invalid_body'}`);
  }
  const retry = await route.handle(request());
  const retryBody = await retry.json() as { value?: { shareUrl?: string } };
  if (retry.status !== 200 || retryBody.value?.shareUrl !== firstBody.value.shareUrl) {
    throw new Error(`share_retry_http_${retry.status}`);
  }
  console.log(JSON.stringify({ result: 'pass', createRoom: 'matrix_200', shareHttp: first.status,
    retryHttp: retry.status, sameLink: true, synapseVersion: synapse.version }));
} finally {
  stores.close();
  synapse.close();
  await rm(directory, { recursive: true, force: true });
}
