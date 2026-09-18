import { describe, expect, it, vi } from 'vitest';
import type { AuthPrincipal, DeviceId, OwnerId, RoomId } from '@khala/contracts/messaging/index';
import type { AuthService } from '../../auth/index';
import type { AdmissionService } from '../../invitations/index';
import { createGateway } from '../../runtime/handler';
import {
  ADMIT_PATH,
  INSPECT_PATH,
  LOGOUT_PATH,
  ME_PATH,
  SHARE_PATH,
  createHumanHandlers,
  registerHumanHandlers,
  type HumanHandlerServices,
} from './handlers';

const ORIGIN = 'https://khala.aiur.team';
const principal: AuthPrincipal = {
  v: 1,
  ownerId: 'owner_alice' as OwnerId,
  providerIssuer: 'https://issuer.example',
  providerSubject: 'alice',
  verifiedEmail: 'alice@example.test',
  sessionExpiresAt: '2030-01-01T00:00:00Z',
};

function services(overrides: {
  auth?: Partial<AuthService>;
  admission?: Partial<AdmissionService>;
} = {}): HumanHandlerServices {
  return {
    auth: {
      startSignIn: vi.fn(async () => ({ kind: 'unavailable' as const })),
      completeSignIn: vi.fn(async () => ({ kind: 'unavailable' as const, cookies: [] })),
      authenticateRequest: vi.fn(async () => ({ kind: 'authenticated' as const, context: { principal, csrfToken: 'csrf_1' } })),
      requireHumanMutation: vi.fn(async () => ({ kind: 'authorized' as const, context: { principal, csrfToken: 'csrf_1' } })),
      signOut: vi.fn(async () => ({ kind: 'signed_out' as const, cookies: [] })),
      messagingAccount: vi.fn(),
      identityFor: vi.fn(),
      ...overrides.auth,
    } as AuthService,
    admission: {
      share: vi.fn(async () => ({
        kind: 'ok' as const,
        value: { inviteRef: 'invite_1', shareUrl: `${ORIGIN}/join?invite=invite_1`, expiresAt: null },
      })),
      inspect: vi.fn(async () => 'eligible' as const),
      admit: vi.fn(async () => ({
        kind: 'ok' as const,
        value: {
          outcome: 'joined' as const,
          room: { roomId: 'room_1' as RoomId, title: null, membership: 'joined' as const, revision: '1' },
        },
      })),
      revoke: vi.fn(async () => ({ kind: 'ok' as const, value: null })),
      ...overrides.admission,
    } as AdmissionService,
  };
}

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
}

function route(
  registrations: ReturnType<typeof createHumanHandlers>,
  path: string,
) {
  const found = registrations.find(registration => registration.path === path);
  if (!found) throw new Error(`missing route ${path}`);
  return found;
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe('human handler registration', () => {
  it('publishes a literal, duplicate-free method shape without a catch-all route', () => {
    const registrations = registerHumanHandlers();
    const shape = registrations.map(({ path, methods }) => [path, methods]);

    expect(shape).toEqual([
      ['/api/human/auth/login', ['GET']],
      ['/api/human/auth/callback', ['GET']],
      [ME_PATH, ['GET']],
      [LOGOUT_PATH, ['POST']],
      [SHARE_PATH, ['POST']],
      [INSPECT_PATH, ['GET']],
      [ADMIT_PATH, ['POST']],
    ]);
    expect(new Set(shape.map(([path]) => path)).size).toBe(shape.length);
    expect(registrations.every(({ path }) => path.startsWith('/api/human/') && !path.includes('*'))).toBe(true);
    expect(registrations.every(({ methods }) => methods.length > 0 && new Set(methods).size === methods.length)).toBe(true);
  });

  it('does not swallow another reserved exact route', async () => {
    const gateway = createGateway({ registrations: registerHumanHandlers(), absentPrefixes: [], appOrigin: ORIGIN });
    const response = await gateway(request('/api/human/agent-bootstrap/authorize'));

    expect(response.status).toBe(404);
    expect(await body(response)).toMatchObject({ code: 'not_found' });
  });

  it('keeps the production registrations explicitly unavailable until a live loader is supplied', async () => {
    for (const registration of registerHumanHandlers()) {
      const response = await registration.handle(request(registration.path, {
        method: registration.methods[0]!,
        headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
      }));
      expect(response.status, registration.path).toBe(503);
      expect(response.headers.get('cache-control'), registration.path).toBe('no-store');
      expect(await body(response), registration.path).toEqual({ code: 'feature_unavailable' });
    }
  });

  it('loads request-scoped services only when a registered handler executes', async () => {
    const load = vi.fn(async (loadedRequest: Request) => {
      void loadedRequest;
      return services();
    });
    const registrations = createHumanHandlers(load);

    expect(load).not.toHaveBeenCalled();
    await route(registrations, ME_PATH).handle(request(ME_PATH));
    await route(registrations, ME_PATH).handle(request(ME_PATH));

    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls[0]?.[0]).toBeInstanceOf(Request);
  });
});

describe('auth route handlers', () => {
  it('maps login, callback and current-session results without caching secrets', async () => {
    const auth = services({
      auth: {
        startSignIn: vi.fn(async () => ({ kind: 'redirect' as const, location: 'https://issuer.example/authorize', cookies: ['login=opaque; Secure'] })),
        completeSignIn: vi.fn(async () => ({ kind: 'signed_in' as const, location: '/rooms/room_1', cookies: ['session=opaque; Secure'], principal })),
      },
    });
    const registrations = createHumanHandlers(async () => auth);

    const login = await route(registrations, '/api/human/auth/login').handle(request('/api/human/auth/login?return_to=%2Fjoin%3Finvite%3Dinvite_1'));
    expect(login.status).toBe(302);
    expect(login.headers.get('location')).toBe('https://issuer.example/authorize');
    expect(login.headers.get('cache-control')).toBe('no-store');

    const callbackRequest = request('/api/human/auth/callback?code=code_1&state=state_1');
    const callback = await route(registrations, '/api/human/auth/callback').handle(callbackRequest);
    expect(callback.status).toBe(303);
    expect(callback.headers.get('location')).toBe('/rooms/room_1');
    expect(auth.auth.completeSignIn).toHaveBeenCalledWith(callbackRequest);

    const me = await route(registrations, ME_PATH).handle(request(ME_PATH));
    expect(me.status).toBe(200);
    const projected = await body(me);
    expect(projected).toEqual({ principal, csrfToken: 'csrf_1' });
    expect(JSON.stringify(projected)).not.toContain('opaque');
  });

  it('keeps signed-out and unavailable identity distinct', async () => {
    const signedOut = createHumanHandlers(async () => services({ auth: { authenticateRequest: vi.fn(async () => ({ kind: 'signed_out' as const })) } }));
    const unavailable = createHumanHandlers(async () => services({ auth: { authenticateRequest: vi.fn(async () => ({ kind: 'unavailable' as const })) } }));

    const signedOutResponse = await route(signedOut, ME_PATH).handle(request(ME_PATH));
    expect(signedOutResponse.status).toBe(401);
    expect(await body(signedOutResponse)).toEqual({ code: 'authentication_required' });
    const unavailableResponse = await route(unavailable, ME_PATH).handle(request(ME_PATH));
    expect(unavailableResponse.status).toBe(503);
    expect(await body(unavailableResponse)).toEqual({ code: 'unavailable' });
  });
});

describe('admission route handlers', () => {
  it('authorizes a mutation before parsing JSON and rejects malformed or extra authority fields', async () => {
    const events: string[] = [];
    const state = services({
      auth: { requireHumanMutation: vi.fn(async () => { events.push('authorize'); return { kind: 'authorized' as const, context: { principal, csrfToken: 'csrf_1' } }; }) },
      admission: { share: vi.fn(async () => { events.push('share'); return { kind: 'unavailable' as const, retryable: true as const }; }) },
    });
    const registrations = createHumanHandlers(async () => state);
    const handler = route(registrations, SHARE_PATH);

    const malformed = await handler.handle(request(SHARE_PATH, { method: 'POST', body: '{' }));
    expect(malformed.status).toBe(400);
    expect(await body(malformed)).toEqual({ code: 'invalid_request' });
    expect(events).toEqual(['authorize']);

    const forged = await handler.handle(request(SHARE_PATH, {
      method: 'POST',
      body: JSON.stringify({ operationId: 'operation_1', roomId: 'room_1', ownerId: 'owner_eve' }),
    }));
    expect(forged.status).toBe(400);
    expect(await body(forged)).toEqual({ code: 'invalid_request' });
    expect(state.admission.share).not.toHaveBeenCalled();
    expect(state.auth.requireHumanMutation).toHaveBeenCalledTimes(2);
  });

  it('passes only validated share and admit inputs to the request-scoped admission service', async () => {
    const state = services();
    const registrations = createHumanHandlers(async () => state);

    const share = await route(registrations, SHARE_PATH).handle(request(SHARE_PATH, {
      method: 'POST', body: JSON.stringify({ operationId: 'operation_1', roomId: 'room_1' }),
    }));
    expect(share.status).toBe(200);
    expect(state.admission.share).toHaveBeenCalledWith({ operationId: 'operation_1', roomId: 'room_1' as RoomId });

    const admit = await route(registrations, ADMIT_PATH).handle(request(ADMIT_PATH, {
      method: 'POST', body: JSON.stringify({ operationId: 'operation_2', inviteRef: 'invite_1', deviceId: 'device_1' }),
    }));
    expect(admit.status).toBe(200);
    expect(state.admission.admit).toHaveBeenCalledWith({ operationId: 'operation_2', inviteRef: 'invite_1', deviceId: 'device_1' as DeviceId });
  });

  it('authenticates inspection and maps dependency failures to finite unavailable responses', async () => {
    const inspect = vi.fn(async () => 'unavailable' as const);
    const state = services({ admission: { inspect } });
    const registrations = createHumanHandlers(async () => state);

    const response = await route(registrations, INSPECT_PATH).handle(request(`${INSPECT_PATH}?invite=invite_1`));

    expect(state.auth.authenticateRequest).toHaveBeenCalledOnce();
    expect(inspect).toHaveBeenCalledWith('invite_1');
    expect(response.status).toBe(503);
    expect(await body(response)).toEqual({ code: 'unavailable' });
  });

  it('never invokes a mutation service when verified mutation authority is absent', async () => {
    const state = services({
      auth: { requireHumanMutation: vi.fn(async () => ({ kind: 'rejected' as const, code: 'signed_out' as const })) },
    });
    const registrations = createHumanHandlers(async () => state);
    const response = await route(registrations, ADMIT_PATH).handle(request(ADMIT_PATH, {
      method: 'POST', body: JSON.stringify({ operationId: 'operation_2', inviteRef: 'invite_1', deviceId: 'device_1' }),
    }));

    expect(response.status).toBe(401);
    expect(await body(response)).toEqual({ code: 'authentication_required' });
    expect(state.admission.admit).not.toHaveBeenCalled();
  });
});
