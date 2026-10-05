import { inviteRemovalState } from '../invitations/removals';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { decodeAgentCredentials, HARNESSES, validAgentSessionId, type AgentCredentials, type Harness } from '@khala/contracts/m1/agent-join';
import { nameKey } from '@khala/contracts/m1/names';
import { decodeNameReservation } from '@khala/contracts/m1/profile';
import { validateAgentName } from '@khala/contracts/messaging/agent-names';
import { type ControlStore, type JsonValue, type OwnerId, type RoomId } from '@khala/contracts/messaging/index';
import { safeEqual } from '../auth/csrf';
import { createDigests, safeRead, writeAndResolve } from '../invitations/internal';
import { inviteFromShareLink } from '../invitations/link';
import { readInviteRecord } from '../invitations/policy';

export const JOIN_TTL_MS = 600_000;
export const JOIN_RETENTION_MS = 86_400_000;
export const RATE_WINDOW_MS = 600_000;
export const RATE_LIMIT = 10;
export type JoinRecord = {
  joinId: string; pollSecretHash: string; roomId: string; channelName: string; label: string; harness: Harness;
  state: 'pending' | 'confirmed' | 'claimed' | 'ready' | 'expired'; createdAt: string; expiresAt: string;
  rejoinSecretHash?: string; rejoin?: true; sessionId?: string; ownerId?: string; agentUserId?: string; sealedCredentials?: string;
};
export const joinKey = (joinId: string): string => `agent-join/${joinId}`;
export const isJoinId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/u.test(value);
export const hashPollSecret = (secret: string): string => createHash('sha256').update(secret).digest('hex');
export const pollSecretMatches = (presented: string, hash: string): boolean => safeEqual(hashPollSecret(presented), hash);
export function effectiveState(record: JoinRecord, now: number): JoinRecord['state'] {
  return (record.state === 'pending' || record.state === 'confirmed') && now >= Date.parse(record.expiresAt) ? 'expired' : record.state;
}

export function decodeJoinRecord(value: unknown): JoinRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const required = ['joinId', 'pollSecretHash', 'roomId', 'channelName', 'label', 'harness', 'state', 'createdAt', 'expiresAt'];
  if (Object.hasOwn(r, 'sessionId') && !validAgentSessionId(r.sessionId)) return null;
  if (Object.hasOwn(r, 'rejoin') && r.rejoin !== true) return null;
  if (Object.hasOwn(r, 'rejoinSecretHash') && (typeof r.rejoinSecretHash !== 'string' || !/^[a-f0-9]{64}$/u.test(r.rejoinSecretHash))) return null;
  const optional = ['rejoinSecretHash', 'sessionId', 'ownerId', 'agentUserId', 'sealedCredentials'];
  if (Object.keys(r).some(key => !required.includes(key) && !optional.includes(key) && key !== 'rejoin')
    || required.some(key => typeof r[key] !== 'string')
    || optional.some(key => Object.hasOwn(r, key) && (typeof r[key] !== 'string' || !r[key]))) return null;
  if (!isJoinId(r.joinId) || !/^[a-f0-9]{64}$/u.test(r.pollSecretHash as string)
    || !r.roomId || !r.channelName || !(HARNESSES as readonly string[]).includes(r.harness as string)
    || !['pending', 'confirmed', 'claimed', 'ready', 'expired'].includes(r.state as string)) return null;
  const label = validateAgentName(r.label);
  if (!label.ok || label.name !== r.label || [...label.name].length > 40) return null;
  for (const key of ['createdAt', 'expiresAt']) {
    const date = r[key] as string;
    if (!Number.isFinite(Date.parse(date)) || new Date(date).toISOString() !== date) return null;
  }
  if (Date.parse(r.expiresAt as string) !== Date.parse(r.createdAt as string) + JOIN_TTL_MS) return null;
  if (r.state === 'confirmed' && !r.sealedCredentials
    || (r.state === 'claimed' || r.state === 'ready') && Object.hasOwn(r, 'sealedCredentials')) return null;
  return r as JoinRecord;
}
export function toStored(record: JoinRecord): JsonValue {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as JsonValue;
}
export type JoinStoreDeps = Readonly<{ store: ControlStore; clock: () => number; random: (bytes: number) => Uint8Array }>;
export function createJoinStore(deps: JoinStoreDeps) {
  const operationId = (joinId: string, transition: string) => `agent-join.${joinId}.${transition}.${Buffer.from(deps.random(8)).toString('hex')}`;
  async function read(joinId: string): Promise<{ kind: 'found'; record: JoinRecord; revision: string } | { kind: 'absent' | 'unavailable' }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await safeRead(deps.store, joinKey(joinId));
      if (result.kind !== 'record') return result;
      const record = decodeJoinRecord(result.record.value);
      if (!record || record.joinId !== joinId) return { kind: 'unavailable' };
      let revision = result.record.revision;
      if (record.state === 'pending' && record.agentUserId && effectiveState(record, deps.clock()) === 'expired') {
        // Win the pending-state CAS before cleanup; a concurrent confirmation keeps its permanent name.
        const expired = await replace(joinId, revision, { ...record, state: 'expired' }, 'expire');
        if (expired.kind === 'conflict') continue;
        if (expired.kind !== 'applied') return { kind: 'unavailable' };
        record.state = 'expired'; revision = expired.revision;
      }
      if (record.state === 'expired' && !record.rejoin && record.agentUserId && record.ownerId) {
        const reservation = await safeRead(deps.store, nameKey(record.label));
        if (reservation.kind === 'unavailable') return { kind: 'unavailable' };
        const decoded = reservation.kind === 'record' ? decodeNameReservation(reservation.record.value) : null;
        if (reservation.kind === 'record' && decoded?.ok && decoded.value.kind === 'agent'
          && decoded.value.matrixUserId === record.agentUserId && decoded.value.ownerId === record.ownerId) {
          const released = await writeAndResolve(deps.store, { key: reservation.record.key, expectedRevision: reservation.record.revision,
            operationId: operationId(joinId, 'release-name'), next: { value: reservation.record.value, expiresAt: new Date(deps.clock()).toISOString() } });
          if (released.kind !== 'applied' && released.kind !== 'conflict') return { kind: 'unavailable' };
        }
      }
      return { kind: 'found', record, revision };
    }
    return { kind: 'unavailable' };
  }
  async function replace(joinId: string, revision: string | null, next: JoinRecord, transition: string): Promise<
    { kind: 'applied'; revision: string } | { kind: 'conflict' | 'unknown' | 'unavailable' }> {
    const result = await writeAndResolve(deps.store, {
      key: joinKey(joinId), expectedRevision: revision, operationId: operationId(joinId, transition),
      next: { value: toStored(next), expiresAt: new Date(Date.parse(next.createdAt) + JOIN_RETENTION_MS).toISOString() },
    });
    if (result.kind === 'applied') return { kind: 'applied', revision: result.record.revision };
    if (result.kind === 'conflict') return { kind: 'conflict' };
    return { kind: result.kind === 'outcome_unknown' ? 'unknown' : 'unavailable' };
  }
  return { read, replace, async create(record: JoinRecord): Promise<'created' | 'unavailable'> {
    return (await replace(record.joinId, null, record, 'create')).kind === 'applied' ? 'created' : 'unavailable';
  } };
}

function sealKey(secret: string, joinId: string): Buffer {
  return createHmac('sha256', secret).update(`khala-agent-join-seal-v1\0${joinId}`).digest();
}
export function sealCredentials(secret: string, joinId: string, credentials: AgentCredentials): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealKey(secret, joinId), iv);
  cipher.setAAD(Buffer.from(joinId));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}
export function openCredentials(secret: string, joinId: string, sealed: string): AgentCredentials | null {
  try {
    const parts = sealed.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1' || parts.slice(1).some(part => !/^[A-Za-z0-9_-]+$/u.test(part))) return null;
    const iv = Buffer.from(parts[1]!, 'base64url'), ciphertext = Buffer.from(parts[2]!, 'base64url'), tag = Buffer.from(parts[3]!, 'base64url');
    if (iv.length !== 12 || tag.length !== 16) return null;
    const cipher = createDecipheriv('aes-256-gcm', sealKey(secret, joinId), iv);
    cipher.setAAD(Buffer.from(joinId)); cipher.setAuthTag(tag);
    const decoded = decodeAgentCredentials(JSON.parse(Buffer.concat([cipher.update(ciphertext), cipher.final()]).toString('utf8')));
    return decoded.ok ? decoded.value : null;
  } catch { return null; }
}

export async function consumeJoinBudget(deps: JoinStoreDeps, ip: string): Promise<'allowed' | 'limited'> {
  try {
    const window = Math.floor(deps.clock() / RATE_WINDOW_MS);
    const key = `agent-join-rate/${hashPollSecret(ip).slice(0, 32)}/${window}`;
    for (let attempt = 0; attempt < 4; attempt++) {
      const read = await safeRead(deps.store, key);
      if (read.kind === 'unavailable') return 'allowed';
      let count = 0;
      if (read.kind === 'record') {
        const value = read.record.value;
        if (typeof value !== 'object' || value === null || Array.isArray(value)
          || !('count' in value) || typeof value.count !== 'number' || !Number.isSafeInteger(value.count) || value.count < 0) return 'allowed';
        count = value.count;
      }
      if (count >= RATE_LIMIT) return 'limited';
      const result = await writeAndResolve(deps.store, { key,
        expectedRevision: read.kind === 'record' ? read.record.revision : null,
        operationId: `agent-join.rate-${window}.increment.${Buffer.from(deps.random(8)).toString('hex')}`,
        next: { value: { count: count + 1 }, expiresAt: new Date((window + 1) * RATE_WINDOW_MS + 60_000).toISOString() },
      });
      if (result.kind !== 'conflict') return 'allowed';
    }
    return 'allowed';
  } catch { return 'allowed'; }
}

export async function resolveJoinLink(input: Readonly<{ link: string; origin: string; store: ControlStore; secret: string; clock: () => number }>): Promise<
  { kind: 'ok'; roomId: RoomId; creatorOwnerId: OwnerId } | { kind: 'invalid_link' | 'link_unavailable' | 'unavailable' }> {
  let parsed: URL;
  try { parsed = new URL(input.link); } catch { return { kind: 'invalid_link' }; }
  const inviteRef = inviteFromShareLink(parsed, input.origin);
  if (inviteRef === null) return { kind: 'invalid_link' };
  const digests = createDigests(input.secret);
  const read = await safeRead(input.store, digests.inviteKey(inviteRef));
  if (read.kind === 'unavailable') return { kind: 'unavailable' };
  if (read.kind === 'absent') return { kind: 'link_unavailable' };
  const invite = readInviteRecord(read.record.value);
  if (!invite || invite.inviteRefDigest !== digests.inviteRef(inviteRef)) return { kind: 'unavailable' };
  if (invite.status === 'revoked' || invite.expiresAt !== null && input.clock() >= Date.parse(invite.expiresAt)) return { kind: 'link_unavailable' };
  const removal = await inviteRemovalState(input.store, invite);
  if (removal !== 'allowed') return { kind: removal === 'revoked' ? 'link_unavailable' : 'unavailable' };
  return { kind: 'ok', roomId: invite.roomId, creatorOwnerId: invite.creatorOwnerId };
}
