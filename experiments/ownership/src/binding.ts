// Ownership boundary: joins a verified human owner, a room admitted through a
// public chat link, an existing harness session and an endpoint key.
//
// Trust path (candidate, G-ADMISSION still open): the agent's local endpoint
// opens the owner's already signed-in browser at the bind URL with an
// RFC 8252 loopback redirect, PKCE and the thumbprint of its own key. The
// browser's Khala session cookie is the owner evidence; the public link is
// only a room reference. The resulting bootstrap token is one-time, short
// lived and sender-constrained (DPoP-shaped proof, RFC 9449 semantics).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, calculateJwkThumbprint, decodeProtectedHeader, generateKeyPair, jwtVerify, importJWK, type CryptoKey, type JWK } from 'jose';
import { ensureAccount, type AccountPort } from './provisioning.ts';

export type SessionClaim = { harness: string; id: string; generation: number };
export type BindRequest = {
  linkId: string;
  session: SessionClaim | undefined;
  jkt: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
};
export type Chat = { linkId: string; roomId: string; ownerId: string; name: string };
export type Binding = {
  bindingId: string;
  ownerId: string;
  roomId: string;
  agentUserId: string;
  session: SessionClaim;
  jkt: string;
  operationId: string;
};

// Model-facing adapter capabilities (docs/research/04-identity-trust.md).
// Approval and policy mutation are deliberately absent.
export const AGENT_CAPABILITIES = ['publish_own', 'receive_released', 'ack_delivery'] as const;
export const BOOTSTRAP_AUDIENCE = 'khala:owner-endpoint-bootstrap';
export const ADAPTER_AUDIENCE = 'khala:agent-adapter';

export class OwnershipError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const fail = (code: string, status = 400): never => { throw new OwnershipError(code, status); };
const same = (left: string, right: string) => left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const sameSession = (left: SessionClaim, right: SessionClaim) => left.harness === right.harness && left.id === right.id && left.generation === right.generation;

export function isLoopbackRedirect(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]') && url.port !== ''
    && url.username === '' && url.password === '' && url.hash === '';
}

export function validSession(session: unknown): session is SessionClaim {
  const candidate = session as SessionClaim | undefined;
  return !!candidate && typeof candidate.harness === 'string' && /^[a-z][a-z0-9-]{1,31}$/.test(candidate.harness)
    && typeof candidate.id === 'string' && candidate.id.length > 0 && candidate.id.length <= 200
    && Number.isSafeInteger(candidate.generation) && candidate.generation >= 0;
}

type PendingCode = { ownerId: string; roomId: string; request: BindRequest; expiresAt: number; used: boolean };
type Redemption = { operationId: string; jkt: string; result: BootstrapResult };
export type BootstrapResult = { binding: Binding; adapterToken: string; deviceLogin: { loginToken: string } };
export type AdmissionPolicy = (ownerId: string, chat: Chat) => boolean;

export type BoundaryOptions = {
  origin: string;
  accounts: AccountPort;
  deviceLogin: { issue(userId: string): Promise<string> };
  now?: () => number;
  // G-ADMISSION: which signed-in humans a link admits is a product decision.
  admission?: AdmissionPolicy;
};

export class OwnershipBoundary {
  readonly origin: string;
  private readonly now: () => number;
  private readonly accounts: AccountPort;
  private readonly deviceLogin: BoundaryOptions['deviceLogin'];
  private readonly admission: AdmissionPolicy;
  private readonly chats = new Map<string, Chat>();
  private readonly codes = new Map<string, PendingCode>();
  private readonly usedJtis = new Map<string, number>();
  private readonly redemptions = new Map<string, Redemption>();
  private readonly bindings = new Map<string, Binding>();
  private signingKey?: { privateKey: CryptoKey; publicKey: CryptoKey };

  constructor(options: BoundaryOptions) {
    this.origin = options.origin;
    this.accounts = options.accounts;
    this.deviceLogin = options.deviceLogin;
    this.now = options.now ?? Date.now;
    this.admission = options.admission ?? (() => true);
  }

  private async keys() {
    this.signingKey ??= await generateKeyPair('ES256');
    return this.signingKey;
  }

  private seconds() {
    return Math.floor(this.now() / 1000);
  }

  // The chat link carries only an unguessable room reference.
  createChat(ownerId: string, roomId: string, name: string): Chat {
    const chat = { linkId: randomBytes(16).toString('base64url'), roomId, ownerId, name };
    this.chats.set(chat.linkId, chat);
    return chat;
  }

  shareUrl(chat: Chat): string {
    return `${this.origin}/c/${chat.linkId}`;
  }

  // Public descriptor for whoever holds the link: no room ID, owner or secrets.
  descriptor(linkId: string) {
    if (!this.chats.has(linkId)) fail('unknown_link', 404);
    return { version: 1, link: linkId, bind: `${this.origin}/api/agent/bind`, methods: ['loopback-browser-v1'] };
  }

  // Called from the owner's browser: `ownerId` comes from the Khala session cookie only.
  authorize(ownerId: string, request: BindRequest): string {
    const chat = this.chats.get(request.linkId) ?? fail('unknown_link', 404);
    if (!isLoopbackRedirect(request.redirectUri)) fail('redirect_not_loopback');
    if (!/^[A-Za-z0-9_-]{43}$/.test(request.codeChallenge)) fail('invalid_code_challenge');
    if (!/^[A-Za-z0-9_-]{43}$/.test(request.jkt)) fail('invalid_key_thumbprint');
    // Never substitute a fresh conversation for the missing existing session.
    if (!validSession(request.session)) fail('harness_session_missing');
    if (!this.admission(ownerId, chat)) fail('not_admitted', 403);
    this.assertNoConflict(ownerId, chat.roomId, request.session!);
    const code = randomBytes(32).toString('base64url');
    this.codes.set(code, { ownerId, roomId: chat.roomId, request, expiresAt: this.now() + 60_000, used: false });
    const target = new URL(request.redirectUri);
    target.searchParams.set('code', code);
    target.searchParams.set('state', request.state);
    return target.href;
  }

  private assertNoConflict(ownerId: string, roomId: string, session: SessionClaim) {
    const current = this.bindings.get(JSON.stringify([ownerId, roomId]));
    // Another session of the same owner cannot silently take over; re-pairing is an explicit owner flow.
    if (current && !sameSession(current.session, session)) fail('binding_conflict', 409);
  }

  // Verifies a DPoP-shaped proof: signed by the endpoint key, for this exact request, fresh and unused.
  private async verifyProof(proof: string | undefined, method: string, url: string, expectedJkt: string, accessToken?: string) {
    if (!proof) fail('proof_required', 401);
    let header: ReturnType<typeof decodeProtectedHeader>;
    try { header = decodeProtectedHeader(proof!); } catch { return fail('invalid_proof', 401); }
    if (header.typ !== 'dpop+jwt' || header.alg !== 'EdDSA' || !header.jwk) fail('invalid_proof', 401);
    const jwk = header.jwk as JWK;
    if (!same(await calculateJwkThumbprint(jwk), expectedJkt)) fail('proof_key_mismatch', 401);
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(proof!, await importJWK(jwk, 'EdDSA'), { typ: 'dpop+jwt', maxTokenAge: 60, currentDate: new Date(this.now()) }));
    } catch { return fail('invalid_proof', 401); }
    if (payload.htm !== method || payload.htu !== url) fail('proof_target_mismatch', 401);
    if (typeof payload.jti !== 'string' || this.usedJtis.has(`proof:${payload.jti}`)) fail('proof_replayed', 401);
    if (accessToken !== undefined && payload.ath !== createHash('sha256').update(accessToken).digest('base64url')) fail('proof_token_mismatch', 401);
    this.usedJtis.set(`proof:${payload.jti}`, this.now());
  }

  // Loopback endpoint exchanges the one-time code for a bootstrap token.
  async exchange(input: { code: string; codeVerifier: string; session: SessionClaim; proof: string | undefined }): Promise<string> {
    const pending = this.codes.get(input.code) ?? fail('invalid_grant');
    if (pending.used) {
      this.codes.delete(input.code);
      fail('invalid_grant');
    }
    pending.used = true;
    if (pending.expiresAt <= this.now()) fail('invalid_grant');
    const challenge = createHash('sha256').update(input.codeVerifier).digest('base64url');
    if (!same(challenge, pending.request.codeChallenge)) fail('invalid_grant');
    await this.verifyProof(input.proof, 'POST', `${this.origin}/api/agent/bind/token`, pending.request.jkt);
    if (!validSession(input.session) || !sameSession(input.session, pending.request.session!)) fail('session_mismatch');
    const iat = this.seconds();
    return new SignJWT({
      cnf: { jkt: pending.request.jkt },
      khala: { room: pending.roomId, session: pending.request.session, capabilities: AGENT_CAPABILITIES },
    }).setProtectedHeader({ alg: 'ES256', typ: 'khala-bootstrap+jwt' }).setIssuer(this.origin).setAudience(BOOTSTRAP_AUDIENCE)
      .setSubject(pending.ownerId).setIssuedAt(iat).setExpirationTime(iat + 60).setJti(randomBytes(16).toString('hex'))
      .sign((await this.keys()).privateKey);
  }

  // Endpoint redeems its bootstrap token once; a retried operation returns the same outcome.
  async redeem(input: { token: string; proof: string | undefined; session: SessionClaim; operationId: string }): Promise<BootstrapResult> {
    let claims: Record<string, any>;
    try {
      ({ payload: claims } = await jwtVerify(input.token, (await this.keys()).publicKey, {
        issuer: this.origin, audience: BOOTSTRAP_AUDIENCE, typ: 'khala-bootstrap+jwt', currentDate: new Date(this.now()), clockTolerance: 0,
      }));
    } catch (error) {
      return fail((error as { code?: string }).code === 'ERR_JWT_EXPIRED' ? 'token_expired' : 'invalid_token', 401);
    }
    await this.verifyProof(input.proof, 'POST', `${this.origin}/api/agent/bootstrap/redeem`, claims.cnf.jkt, input.token);
    if (!validSession(input.session) || !sameSession(input.session, claims.khala.session)) fail('session_generation_mismatch', 409);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(input.operationId)) fail('invalid_operation_id');
    const previous = this.redemptions.get(claims.jti);
    if (previous) {
      // Lost-response retry by the same key holder and operation; anything else is replay.
      if (previous.operationId === input.operationId && same(previous.jkt, claims.cnf.jkt)) return previous.result;
      fail('token_replayed', 401);
    }
    const ownerId: string = claims.sub;
    const roomId: string = claims.khala.room;
    const session: SessionClaim = claims.khala.session;
    this.assertNoConflict(ownerId, roomId, session);
    const agentUserId = await ensureAccount(this.accounts, `${ownerId}:agent`, 'agent', 'Agent');
    const key = JSON.stringify([ownerId, roomId]);
    const binding: Binding = this.bindings.get(key) ?? {
      bindingId: `bnd_${randomBytes(12).toString('hex')}`, ownerId, roomId, agentUserId, session, jkt: claims.cnf.jkt, operationId: input.operationId,
    };
    // Same session reconnecting with a new endpoint key keeps its binding identity but moves the key.
    binding.jkt = claims.cnf.jkt;
    this.bindings.set(key, binding);
    const iat = this.seconds();
    const adapterToken = await new SignJWT({ cnf: { jkt: binding.jkt }, scope: AGENT_CAPABILITIES.join(' '), khala: { binding: binding.bindingId, room: roomId, session } })
      .setProtectedHeader({ alg: 'ES256', typ: 'khala-adapter+jwt' }).setIssuer(this.origin).setAudience(ADAPTER_AUDIENCE)
      .setSubject(agentUserId).setIssuedAt(iat).setExpirationTime(iat + 3600).setJti(randomBytes(16).toString('hex'))
      .sign((await this.keys()).privateKey);
    const result = { binding: { ...binding }, adapterToken, deviceLogin: { loginToken: await this.deviceLogin.issue(agentUserId) } };
    this.redemptions.set(claims.jti, { operationId: input.operationId, jkt: claims.cnf.jkt, result });
    return result;
  }

  // Adapter-facing operations: token must be sender-constrained and the capability granted.
  async authorizeAgentAction(token: string | undefined, proof: string | undefined, action: string, url: string) {
    if (!token) fail('agent_token_required', 401);
    let claims: Record<string, any>;
    try {
      ({ payload: claims } = await jwtVerify(token!, (await this.keys()).publicKey, { issuer: this.origin, audience: ADAPTER_AUDIENCE, typ: 'khala-adapter+jwt', currentDate: new Date(this.now()) }));
    } catch { return fail('invalid_token', 401); }
    await this.verifyProof(proof, 'POST', url, claims.cnf.jkt, token);
    const binding = [...this.bindings.values()].find(entry => entry.bindingId === claims.khala.binding);
    if (!binding || !sameSession(binding.session, claims.khala.session)) fail('binding_superseded', 401);
    if (!String(claims.scope).split(' ').includes(action)) fail('capability_not_granted', 403);
    return { bindingId: binding!.bindingId, action };
  }

  // Human-only: callers must pass an owner authenticated by cookie + CSRF.
  approve(ownerId: string, bindingId: string) {
    const binding = [...this.bindings.values()].find(entry => entry.bindingId === bindingId);
    if (!binding || binding.ownerId !== ownerId) fail('not_owner', 403);
    return { approved: true, bindingId };
  }

  // Browser/control projection: identifiers and state only, never tokens or keys.
  projection(ownerId: string) {
    return {
      bindings: [...this.bindings.values()].filter(entry => entry.ownerId === ownerId).map(entry => ({
        bindingId: entry.bindingId, roomId: entry.roomId, agentUserId: entry.agentUserId,
        harness: entry.session.harness, sessionId: entry.session.id, generation: entry.session.generation, status: 'bound',
      })),
      chats: [...this.chats.values()].filter(chat => chat.ownerId === ownerId).map(chat => ({ roomId: chat.roomId, name: chat.name, shareUrl: this.shareUrl(chat) })),
    };
  }

  bindingCount(): number {
    return this.bindings.size;
  }
}
