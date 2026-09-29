import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ControlStore, JsonValue, OwnerId } from '@khala/contracts/messaging/index';

const TOKEN = /^pcl_([A-Za-z0-9_-]{43})\.([0-9]+)\.([A-Za-z0-9_-]{43})$/;
const LIFETIME_MS = 24 * 60 * 60 * 1_000;

type Session = Readonly<{ harness: 'codex' | 'claude'; sessionId: string; generation: number }>;
type RecordValue = Readonly<{
  v: 1; session: Session; generation: number; channelId: string;
  expiresAt: string; ownerId: OwnerId | null;
}>;
type Result = Readonly<{ kind: 'unavailable' | 'conflict' | 'expired' | 'invalid' }>;
type Started = Readonly<{ kind: 'provisional'; channelId: string; claimToken: string; expiresAt: string }>;
type AlreadyClaimed = Readonly<{ kind: 'already_claimed'; channelId: string }>;
type Claimed = Readonly<{ kind: 'claimed'; channelId: string; ownerId: OwnerId; repeated: boolean }>;

/**
 * One CAS record is the entire provisional authority boundary. The token locates
 * the session record and proves possession, but never gives room or agent power.
 * A new generation after expiry invalidates every earlier token. The caller's
 * verified native session identity must be supplied by its trusted adapter.
 */
export function createProvisionalChannelStore(input: Readonly<{
  store: ControlStore; secret: Uint8Array; clock: () => number;
}>) {
  if (input.secret.byteLength < 32) throw new TypeError('provisional secret must have 32 bytes');
  const mac = (purpose: string, value: string) => createHmac('sha256', input.secret)
    .update(`khala.provisional.${purpose}.v1\0`).update(value).digest('base64url');
  const slot = (session: Session) => mac('session', JSON.stringify([session.harness, session.sessionId, session.generation]));
  const key = (id: string) => `provisional-channel:${id}`;
  const token = (id: string, generation: number) => `pcl_${id}.${generation}.${mac('claim', `${id}.${generation}`)}`;
  const channelId = (id: string, generation: number) => `pc_${mac('channel', `${id}.${generation}`)}`;

  function decode(value: JsonValue, id: string): RecordValue | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const raw = value as Record<string, JsonValue>;
    if (Object.keys(raw).sort().join(',') !== 'channelId,expiresAt,generation,ownerId,session,v'
      || raw.v !== 1 || !Number.isSafeInteger(raw.generation) || (raw.generation as number) < 1
      || typeof raw.expiresAt !== 'string' || !Number.isFinite(Date.parse(raw.expiresAt))
      || (raw.ownerId !== null && typeof raw.ownerId !== 'string')) return null;
    const session = raw.session;
    if (typeof session !== 'object' || session === null || Array.isArray(session)) return null;
    const identity = session as Record<string, JsonValue>;
    if (Object.keys(identity).sort().join(',') !== 'generation,harness,sessionId'
      || (identity.harness !== 'codex' && identity.harness !== 'claude')
      || typeof identity.sessionId !== 'string' || !Number.isSafeInteger(identity.generation)
      || slot(identity as Session) !== id || raw.channelId !== channelId(id, raw.generation as number)) return null;
    return raw as RecordValue;
  }

  async function start(session: Session): Promise<Started | AlreadyClaimed | Result> {
    if (!['codex', 'claude'].includes(session.harness) || !session.sessionId || session.sessionId.length > 512
      || !Number.isSafeInteger(session.generation) || session.generation < 0) return { kind: 'invalid' };
    const id = slot(session);
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await input.store.read<RecordValue>(key(id));
      if (current.kind === 'unavailable') return { kind: 'unavailable' };
      const prior = current.kind === 'record' ? decode(current.record.value, id) : null;
      if (current.kind === 'record' && prior === null) return { kind: 'unavailable' };
      if (prior && prior.ownerId !== null) return { kind: 'already_claimed', channelId: prior.channelId };
      if (prior && input.clock() < Date.parse(prior.expiresAt)) {
        return { kind: 'provisional', channelId: prior.channelId,
          claimToken: token(id, prior.generation), expiresAt: prior.expiresAt };
      }
      const generation = (prior?.generation ?? 0) + 1;
      const next: RecordValue = { v: 1, session, generation, channelId: channelId(id, generation),
        expiresAt: new Date(input.clock() + LIFETIME_MS).toISOString(), ownerId: null };
      // Competing calls can choose different expiries a millisecond apart. They
      // must have distinct write IDs so the CAS loser can read the winner.
      const operationId = `provisional:start:${id}:${generation}:${mac('write', JSON.stringify(next))}`;
      const written = await input.store.compareAndSet({ key: key(id),
        expectedRevision: current.kind === 'record' ? current.record.revision : null,
        operationId, next: { value: next, expiresAt: null } });
      if (written.kind === 'applied') return { kind: 'provisional', channelId: next.channelId,
        claimToken: token(id, generation), expiresAt: next.expiresAt };
      if (written.kind === 'outcome_unknown') {
        const resolved = await input.store.resolve<RecordValue>({ key: key(id), operationId });
        if (resolved.kind === 'applied') continue;
        if (resolved.kind !== 'not_applied') return { kind: 'unavailable' };
      } else if (written.kind !== 'conflict') return { kind: 'unavailable' };
    }
    return { kind: 'unavailable' };
  }

  async function claim(claimToken: string, ownerId: OwnerId): Promise<Claimed | Result> {
    const match = TOKEN.exec(claimToken);
    if (!match || !ownerId) return { kind: 'invalid' };
    const [, id, generationText, signature] = match;
    const expected = Buffer.from(mac('claim', `${id}.${generationText}`), 'base64url');
    const received = Buffer.from(signature!, 'base64url');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return { kind: 'invalid' };
    const generation = Number(generationText);
    if (!Number.isSafeInteger(generation) || generation < 1) return { kind: 'invalid' };
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await input.store.read<RecordValue>(key(id!));
      if (current.kind === 'unavailable') return { kind: 'unavailable' };
      if (current.kind === 'absent') return { kind: 'invalid' };
      const prior = decode(current.record.value, id!);
      if (prior === null) return { kind: 'unavailable' };
      if (prior.generation !== generation) return { kind: 'expired' };
      if (prior.ownerId !== null) return prior.ownerId === ownerId
        ? { kind: 'claimed', channelId: prior.channelId, ownerId, repeated: true }
        : { kind: 'conflict' };
      if (input.clock() >= Date.parse(prior.expiresAt)) return { kind: 'expired' };
      const operationId = `provisional:claim:${id}:${generation}:${mac('owner', ownerId)}`;
      const written = await input.store.compareAndSet({ key: key(id!), expectedRevision: current.record.revision,
        operationId, next: { value: { ...prior, ownerId }, expiresAt: null } });
      if (written.kind === 'applied') return { kind: 'claimed', channelId: prior.channelId, ownerId, repeated: false };
      if (written.kind === 'outcome_unknown') {
        const resolved = await input.store.resolve<RecordValue>({ key: key(id!), operationId });
        if (resolved.kind === 'applied') continue;
        if (resolved.kind !== 'not_applied') return { kind: 'unavailable' };
      } else if (written.kind !== 'conflict') return { kind: 'unavailable' };
    }
    return { kind: 'unavailable' };
  }

  return Object.freeze({ start, claim });
}
