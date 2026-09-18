// Disposable OpenID Provider standing in for the human's real OAuth provider.
// It runs the maintained `oidc-provider` implementation on loopback so the
// relying-party code exercises actual authorization-code + PKCE exchanges.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Provider from 'oidc-provider';

export type IdpAccount = { sub: string; email: string; password: string };
export type DisposableIdp = {
  issuer: string;
  client: { client_id: string; client_secret: string; redirect_uri: string };
  setEmail(sub: string, email: string): void;
  close(): Promise<void>;
};

async function formBody(request: IncomingMessage): Promise<URLSearchParams> {
  let body = '';
  for await (const chunk of request) body += chunk;
  return new URLSearchParams(body);
}

export async function startDisposableIdp(accounts: IdpAccount[], redirectUri: string): Promise<DisposableIdp> {
  const directory = new Map(accounts.map(account => [account.sub, { ...account }]));
  const client = { client_id: 'khala-web', client_secret: randomBytes(24).toString('hex'), redirect_uri: redirectUri };
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const provider = new Provider(issuer, {
    clients: [{ client_id: client.client_id, client_secret: client.client_secret, redirect_uris: [redirectUri], grant_types: ['authorization_code'], response_types: ['code'] }],
    claims: { openid: ['sub'], email: ['email', 'email_verified'] },
    scopes: ['openid', 'email'],
    pkce: { required: () => true },
    features: { devInteractions: { enabled: false } },
    cookies: { keys: [randomBytes(32).toString('hex')] },
    ttl: { Interaction: 600, Grant: 600, Session: 3600, AccessToken: 300, IdToken: 300, AuthorizationCode: 60 },
    interactions: { url: (_ctx: unknown, interaction: { uid: string }) => `/interaction/${interaction.uid}` },
    async findAccount(_ctx: unknown, sub: string) {
      const account = directory.get(sub);
      if (!account) return undefined;
      return { accountId: sub, claims: async () => ({ sub, email: account.email, email_verified: true }) };
    },
    // Consent is a real provider's business; auto-grant the requested scopes.
    async loadExistingGrant(ctx: any) {
      const grant = new ctx.oidc.provider.Grant({ clientId: ctx.oidc.client.clientId, accountId: ctx.oidc.session.accountId });
      grant.addOIDCScope('openid email');
      await grant.save();
      return grant;
    },
  });
  const callback = provider.callback();
  server.on('request', async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const match = /^\/interaction\/([\w-]+)$/.exec(new URL(request.url ?? '/', issuer).pathname);
      if (!match) return callback(request, response);
      const details = await provider.interactionDetails(request, response);
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/html' });
        return response.end(`<form method="post" action="/interaction/${details.uid}"><input name="email"><input name="password" type="password"><button>Sign in</button></form>`);
      }
      const form = await formBody(request);
      const account = [...directory.values()].find(entry => entry.email === form.get('email') && entry.password === form.get('password'));
      const result = account ? { login: { accountId: account.sub } } : { error: 'access_denied', error_description: 'invalid credentials' };
      await provider.interactionFinished(request, response, result, { mergeWithLastSubmission: false });
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  return {
    issuer,
    client,
    setEmail(sub, email) {
      const account = directory.get(sub);
      if (!account) throw new Error('unknown disposable account');
      account.email = email;
    },
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
