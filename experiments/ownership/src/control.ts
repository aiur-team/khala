// Disposable control-plane HTTP surface. In production this would be Netlify
// functions at https://khala.aiur.team; here it listens on loopback.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { HumanSessions, OidcRelyingParty, OwnerDirectory, type PendingLogin, type RelyingPartyConfig } from './identity.ts';
import { ensureAccount, type AccountPort } from './provisioning.ts';
import { OwnershipBoundary, OwnershipError, type AdmissionPolicy } from './binding.ts';

export type ControlOptions = {
  accounts: AccountPort;
  deviceLogin: { issue(userId: string): Promise<string> };
  oidc: (origin: string) => Omit<RelyingPartyConfig, 'redirectUri'>;
  admission?: AdmissionPolicy;
  now?: () => number;
};

export type Control = {
  origin: string;
  callbackUrl: string;
  boundary: OwnershipBoundary;
  owners: OwnerDirectory;
  humanUserId(ownerId: string): string | undefined;
  close(): Promise<void>;
};

function cookies(request: IncomingMessage): Map<string, string> {
  return new Map((request.headers.cookie ?? '').split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const index = part.indexOf('=');
    return [part.slice(0, index), part.slice(index + 1)] as [string, string];
  }));
}

async function jsonBody(request: IncomingMessage): Promise<any> {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw new OwnershipError('body_too_large', 413);
  }
  try { return body ? JSON.parse(body) : {}; } catch { throw new OwnershipError('invalid_json'); }
}

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  response.end(JSON.stringify(body));
}

function redirect(response: ServerResponse, location: string, headers: Record<string, string | string[]> = {}) {
  response.writeHead(302, { location, 'cache-control': 'no-store', ...headers });
  response.end();
}

// Only relative same-origin paths may be resumed after sign-in.
function safeReturn(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : '/';
}

export async function startControl(options: ControlOptions): Promise<Control> {
  const now = options.now ?? Date.now;
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const callbackUrl = `${origin}/api/human/auth/callback`;
  const secureFlag = origin.startsWith('https://') ? '; Secure' : '';
  // Resolved lazily so a disposable IdP can register this callback after startup.
  let relyingParty: OidcRelyingParty | undefined;
  const rp = () => (relyingParty ??= new OidcRelyingParty({ ...options.oidc(origin), redirectUri: callbackUrl }));
  const owners = new OwnerDirectory();
  const sessions = new HumanSessions(now);
  const humanAccounts = new Map<string, string>();
  const logins = new Map<string, PendingLogin & { returnTo: string; expiresAt: number }>();
  const boundary = new OwnershipBoundary({ origin, accounts: options.accounts, deviceLogin: options.deviceLogin, admission: options.admission, now });

  const human = (request: IncomingMessage, requireCsrf: boolean) => {
    const sid = cookies(request).get('khala_session');
    const session = requireCsrf ? sessions.authenticate(sid, request.headers['x-khala-csrf'] as string | undefined) : sessions.lookup(sid);
    if (!session) throw new OwnershipError('human_session_required', 401);
    return session;
  };

  server.on('request', async (request, response) => {
    const url = new URL(request.url ?? '/', origin);
    const route = `${request.method} ${url.pathname}`;
    try {
      if (route === 'GET /api/human/auth/login') {
        const { url: authorize, pending } = await rp().start();
        const handle = randomBytes(24).toString('base64url');
        logins.set(handle, { ...pending, returnTo: safeReturn(url.searchParams.get('return_to')), expiresAt: now() + 600_000 });
        return redirect(response, authorize, { 'set-cookie': `khala_login=${handle}; HttpOnly; SameSite=Lax; Path=/api/human/auth${secureFlag}` });
      }
      if (route === 'GET /api/human/auth/callback') {
        const handle = cookies(request).get('khala_login');
        const pending = handle ? logins.get(handle) : undefined;
        if (handle) logins.delete(handle);
        if (!pending || pending.expiresAt <= now()) throw new OwnershipError('login_expired', 400);
        const owner = owners.resolve(await rp().finish(url, pending));
        humanAccounts.set(owner.ownerId, await ensureAccount(options.accounts, owner.ownerId, 'human', owner.email ?? 'Khala user'));
        const { sid } = sessions.create(owner.ownerId);
        return redirect(response, pending.returnTo, { 'set-cookie': [
          `khala_session=${sid}; HttpOnly; SameSite=Lax; Path=/${secureFlag}`,
          `khala_login=; Max-Age=0; Path=/api/human/auth${secureFlag}`,
        ] });
      }
      if (route === 'GET /') {
        response.writeHead(200, { 'content-type': 'text/html' });
        return response.end('<p>Khala</p>');
      }
      if (route === 'GET /api/human/me') {
        const session = human(request, false);
        const owner = owners.get(session.ownerId)!;
        return send(response, 200, { ownerId: owner.ownerId, email: owner.email, csrf: session.csrf, messagingUserId: humanAccounts.get(owner.ownerId), ...boundary.projection(owner.ownerId) });
      }
      if (route === 'POST /api/human/messaging/device-login') {
        const session = human(request, true);
        return send(response, 200, { loginToken: await options.deviceLogin.issue(humanAccounts.get(session.ownerId)!) });
      }
      if (route === 'POST /api/human/chats') {
        const session = human(request, true);
        const { roomId, name } = await jsonBody(request);
        if (typeof roomId !== 'string' || !roomId.startsWith('!')) throw new OwnershipError('invalid_room');
        if (options.accounts.roomHasMember && !(await options.accounts.roomHasMember(roomId, humanAccounts.get(session.ownerId)!))) throw new OwnershipError('not_room_member', 403);
        const chat = boundary.createChat(session.ownerId, roomId, typeof name === 'string' ? name.slice(0, 80) : 'Chat');
        return send(response, 201, { shareUrl: boundary.shareUrl(chat) });
      }
      if (route === 'POST /api/human/approvals') {
        const session = human(request, true);
        const { bindingId } = await jsonBody(request);
        return send(response, 200, boundary.approve(session.ownerId, String(bindingId)));
      }
      const link = /^\/c\/([A-Za-z0-9_-]{22})$/.exec(url.pathname);
      if (request.method === 'GET' && link) {
        const descriptor = boundary.descriptor(link[1]);
        if ((request.headers.accept ?? '').includes('application/json')) return send(response, 200, descriptor);
        response.writeHead(200, { 'content-type': 'text/html' });
        return response.end('<p>Sign in to join this Khala chat.</p>');
      }
      if (route === 'GET /api/agent/bind') {
        const session = sessions.lookup(cookies(request).get('khala_session'));
        // Link possession without a signed-in owner never yields a code.
        if (!session) return redirect(response, `/api/human/auth/login?return_to=${encodeURIComponent(url.pathname + url.search)}`);
        let claim: unknown;
        try { claim = JSON.parse(Buffer.from(url.searchParams.get('session') ?? '', 'base64url').toString() || 'null'); } catch { claim = undefined; }
        const parameters = url.searchParams;
        const target = boundary.authorize(session.ownerId, {
          linkId: parameters.get('link') ?? '', session: (claim ?? undefined) as never, jkt: parameters.get('jkt') ?? '',
          redirectUri: parameters.get('redirect_uri') ?? '', codeChallenge: parameters.get('code_challenge') ?? '', state: parameters.get('state') ?? '',
        });
        return redirect(response, target);
      }
      if (route === 'POST /api/agent/bind/token') {
        const body = await jsonBody(request);
        const token = await boundary.exchange({ code: String(body.code), codeVerifier: String(body.code_verifier), session: body.session, proof: request.headers.dpop as string | undefined });
        return send(response, 200, { bootstrap_token: token, token_type: 'DPoP', expires_in: 60 });
      }
      if (route === 'POST /api/agent/bootstrap/redeem') {
        const body = await jsonBody(request);
        const token = /^DPoP (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
        const result = await boundary.redeem({ token, proof: request.headers.dpop as string | undefined, session: body.session, operationId: String(body.operation_id) });
        return send(response, 200, result);
      }
      const action = /^\/api\/agent\/actions\/([a-z_]+)$/.exec(url.pathname);
      if (request.method === 'POST' && action) {
        const token = /^DPoP (.+)$/.exec(request.headers.authorization ?? '')?.[1];
        return send(response, 200, await boundary.authorizeAgentAction(token, request.headers.dpop as string | undefined, action[1], `${origin}${url.pathname}`));
      }
      send(response, 404, { error: 'not_found' });
    } catch (error) {
      if (error instanceof OwnershipError) return send(response, error.status, { error: error.code });
      // Never echo library errors: they may carry token-bearing detail.
      send(response, 500, { error: 'internal' });
    }
  });

  return {
    origin, callbackUrl, boundary, owners,
    humanUserId: ownerId => humanAccounts.get(ownerId),
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
