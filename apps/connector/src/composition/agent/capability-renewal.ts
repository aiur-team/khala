import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { AdapterCapability } from '@khala/connector/bootstrap/index';
import type { ProofSigner } from '@khala/connector/bootstrap/proof';
import { readBounded } from '@khala/connector/bootstrap/discovery';

const CHALLENGE_PATH = '/api/agent/bootstrap/refresh/challenge';
const REFRESH_PATH = '/api/agent/bootstrap/refresh';
const CAPABILITY_SCOPE = ['publish_own', 'receive_released', 'ack_delivery'] as const;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const ID = /^[A-Za-z0-9_-]{8,64}$/u;
const MAX_RESPONSE = 8192;

type RefreshPlan = Readonly<{
  v: 1; bindingId: string; generation: number; jkt: string;
  operationId: string; nonce: string; startedAt: number;
}>;

/** A one-file write is synced before its directory entry is reported durable. */
async function save(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
    const directory = await open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}

async function load(file: string): Promise<unknown | null> {
  try { return JSON.parse(await readFile(file, 'utf8')) as unknown; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function responseJson(response: Response): Promise<unknown | null> {
  if ((response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/json') return null;
  const bytes = await readBounded(response, MAX_RESPONSE);
  if (!bytes || bytes.length === 0) return null;
  try { return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)) as unknown; }
  catch { return null; }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function capability(value: unknown, binding: SessionBinding, now: number): AdapterCapability | null {
  if (!object(value) || !TOKEN.test(String(value.token)) || value.token_type !== 'DPoP'
    || value.binding_id !== binding.bindingId || value.generation !== binding.generation
    || !Number.isSafeInteger(value.expires_at) || (value.expires_at as number) <= now
    || !Array.isArray(value.scope) || value.scope.length !== CAPABILITY_SCOPE.length
    || !CAPABILITY_SCOPE.every(item => (value.scope as unknown[]).includes(item))) return null;
  return { token: value.token as string, scope: CAPABILITY_SCOPE, bindingId: binding.bindingId,
    generation: binding.generation, expiresAt: value.expires_at as number };
}

/**
 * Reopens the same proof-key-bound binding after a one-hour bearer expires. The
 * challenge and operation are durable locally, so a lost POST response retries
 * the same server plan and cannot mint a replacement token inadvertently.
 */
export function createCapabilityRenewal(input: Readonly<{
  stateDirectory: string; appOrigin: string; binding: SessionBinding; signer: ProofSigner;
  fetch?: typeof fetch; clock?: () => number;
}>) {
  if (new URL(input.appOrigin).protocol !== 'https:' || new URL(input.appOrigin).origin !== input.appOrigin)
    throw new Error('capability_origin_invalid');
  const transport = input.fetch ?? fetch;
  const clock = input.clock ?? Date.now;
  const planFile = path.join(input.stateDirectory, 'refresh-plan.json');
  const capabilityFile = path.join(input.stateDirectory, 'adapter-capability.json');
  const challengeUrl = `${input.appOrigin}${CHALLENGE_PATH}`;
  const refreshUrl = `${input.appOrigin}${REFRESH_PATH}`;
  let renewing: Promise<AdapterCapability | null> | null = null;

  async function persisted(): Promise<AdapterCapability | null> {
    const stored = await load(capabilityFile);
    if (!object(stored) || stored.v !== 1 || stored.bindingId !== input.binding.bindingId
      || stored.generation !== input.binding.generation || stored.jkt !== input.signer.jkt) return null;
    return capability(stored.capability, input.binding, clock());
  }

  async function challenge(): Promise<RefreshPlan | null> {
    const target = `${challengeUrl}?binding_id=${encodeURIComponent(input.binding.bindingId)}`;
    let response: Response;
    try { response = await transport(target, { method: 'GET', headers: { accept: 'application/json',
      dpop: input.signer.proof('GET', challengeUrl) }, redirect: 'error', credentials: 'omit',
    signal: AbortSignal.timeout(10_000) }); } catch { return null; }
    if (response.status !== 200) { await response.body?.cancel().catch(() => undefined); return null; }
    const body = await responseJson(response);
    if (!object(body) || body.v !== 1 || typeof body.nonce !== 'string' || !TOKEN.test(body.nonce)
      || !Number.isSafeInteger(body.expires_at) || (body.expires_at as number) <= clock()) return null;
    return { v: 1, bindingId: input.binding.bindingId, generation: input.binding.generation,
      jkt: input.signer.jkt, operationId: randomBytes(24).toString('base64url'), nonce: body.nonce, startedAt: clock() };
  }

  async function renew(): Promise<AdapterCapability | null> {
    await mkdir(input.stateDirectory, { recursive: true, mode: 0o700 });
    const saved = await load(planFile);
    let plan: RefreshPlan | null = null;
    if (saved !== null) {
      if (!object(saved) || saved.v !== 1 || saved.bindingId !== input.binding.bindingId
        || saved.generation !== input.binding.generation || saved.jkt !== input.signer.jkt
        || typeof saved.operationId !== 'string' || !ID.test(saved.operationId)
        || typeof saved.nonce !== 'string' || !TOKEN.test(saved.nonce)
        || !Number.isSafeInteger(saved.startedAt)) return null;
      plan = saved as RefreshPlan;
      if (clock() - plan.startedAt >= 3_600_000) {
        await rm(planFile, { force: true });
        plan = null;
      }
    }
    if (plan === null) {
      plan = await challenge();
      if (!plan) return null;
      await save(planFile, plan);
    }
    const body = JSON.stringify({ binding_id: input.binding.bindingId, owner_id: input.binding.ownerId,
      device_id: input.binding.deviceId, generation: input.binding.generation,
      nonce: plan.nonce, operation_id: plan.operationId });
    const bodyHash = createHash('sha256').update(body).digest('base64url');
    let response: Response;
    try { response = await transport(refreshUrl, { method: 'POST', headers: {
      accept: 'application/json', 'content-type': 'application/json', origin: input.appOrigin,
      dpop: input.signer.proof('POST', refreshUrl, undefined, { nonce: plan.nonce, bodyHash }),
    }, body, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(10_000) }); }
    catch { return null; }
    if (response.status === 403) {
      const error = await responseJson(response);
      // A challenge that expired before any server plan was created may be replaced.
      if (object(error) && error.code === 'invalid_challenge') await rm(planFile, { force: true });
      return null;
    }
    if (response.status !== 200) { await response.body?.cancel().catch(() => undefined); return null; }
    const answer = await responseJson(response);
    if (!object(answer) || answer.v !== 1 || !object(answer.binding)
      || answer.binding.bindingId !== input.binding.bindingId || answer.binding.ownerId !== input.binding.ownerId
      || answer.binding.deviceId !== input.binding.deviceId || answer.binding.generation !== input.binding.generation) return null;
    const accepted = capability(answer.adapter_capability, input.binding, clock());
    if (!accepted) return null;
    await save(capabilityFile, { v: 1, bindingId: input.binding.bindingId, generation: input.binding.generation,
      jkt: input.signer.jkt, capability: answer.adapter_capability });
    await rm(planFile, { force: true });
    return accepted;
  }

  return {
    async acceptInitial(value: AdapterCapability): Promise<void> {
      if (value.bindingId !== input.binding.bindingId || value.generation !== input.binding.generation
        || !TOKEN.test(value.token) || value.expiresAt <= clock()) throw new Error('capability_invalid');
      await mkdir(input.stateDirectory, { recursive: true, mode: 0o700 });
      await save(capabilityFile, { v: 1, bindingId: input.binding.bindingId, generation: input.binding.generation,
        jkt: input.signer.jkt, capability: { token: value.token, token_type: 'DPoP', scope: [...value.scope],
          binding_id: value.bindingId, generation: value.generation, expires_at: value.expiresAt } });
    },
    async ensure(): Promise<AdapterCapability | null> {
      const current = await persisted();
      if (current && current.expiresAt - clock() > 60_000) return current;
      if (!renewing) renewing = renew().finally(() => { renewing = null; });
      return renewing;
    },
  };
}
