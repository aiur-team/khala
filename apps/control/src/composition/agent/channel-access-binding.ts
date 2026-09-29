import { createHash, randomBytes } from 'node:crypto';
import type { ControlStore } from '@khala/contracts/messaging/index';
import type { ExchangeGrantBinding } from '@khala/messaging/channel-access/exchange/grants';
import type { AgentMatrixSession } from '../../agent-bootstrap/handler';

type IssuedBinding = Readonly<{ v: 1; bindingId: string; operation: ExchangeGrantBinding;
  matrixSession: AgentMatrixSession }>;

function key(operation: Pick<ExchangeGrantBinding, 'requester' | 'origin' | 'operationId'>): string {
  return `channel-access-operation-binding/${createHash('sha256')
    .update('khala.channel-access.operation-binding.v1\0')
    .update(JSON.stringify([operation.requester, operation.origin, operation.operationId])).digest('hex')}`;
}

/** Written before redeem returns a capability. A missing or conflicting mapping fails closed. */
export async function recordChannelAccessBinding(
  store: ControlStore, operation: ExchangeGrantBinding, bindingId: string,
  matrixSession: AgentMatrixSession, expiresAt: string,
): Promise<'applied' | 'replayed' | 'unavailable'> {
  if (matrixSession.deviceId !== operation.deviceId || !matrixSession.accessToken
    || !Number.isFinite(Date.parse(expiresAt))) return 'unavailable';
  const storeKey = key(operation);
  const operationId = `${storeKey}#${randomBytes(16).toString('base64url')}`;
  const result = await store.compareAndSet({ key: storeKey, expectedRevision: null, operationId,
    next: { value: { v: 1, bindingId, operation, matrixSession }, expiresAt } });
  if (result.kind === 'applied') return 'applied';
  if (result.kind === 'conflict' || result.kind === 'operation_mismatch') return 'replayed';
  if (result.kind !== 'outcome_unknown') return 'unavailable';
  const resolved = await store.resolve({ key: storeKey, operationId });
  return resolved.kind === 'applied' ? 'applied' : 'unavailable';
}

export async function findChannelAccessBinding(
  store: ControlStore, operation: Pick<ExchangeGrantBinding, 'requester' | 'origin' | 'operationId'>,
): Promise<Readonly<{ kind: 'found'; value: IssuedBinding }> | Readonly<{ kind: 'absent' | 'unavailable' }>> {
  const read = await store.read(key(operation));
  if (read.kind !== 'record') return { kind: read.kind };
  const value = read.record.value as unknown;
  if (!isIssuedBinding(value) || value.operation.requester !== operation.requester
    || value.operation.origin !== operation.origin || value.operation.operationId !== operation.operationId) {
    return { kind: 'unavailable' };
  }
  return { kind: 'found', value };
}

function isIssuedBinding(value: unknown): value is IssuedBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<IssuedBinding>;
  return Object.keys(value).sort().join(',') === 'bindingId,matrixSession,operation,v'
    && candidate.v === 1 && typeof candidate.bindingId === 'string' && /^bnd_[A-Za-z0-9_-]+$/.test(candidate.bindingId)
    && !!candidate.operation && typeof candidate.operation === 'object'
    && Object.keys(candidate.operation).sort().join(',') === 'channelRef,deviceId,operationId,origin,ownerId,proofKeyThumbprint,requester,sessionGeneration'
    && typeof candidate.operation.operationId === 'string' && typeof candidate.operation.requester === 'string'
    && typeof candidate.operation.origin === 'string' && Number.isSafeInteger(candidate.operation.sessionGeneration)
    && typeof candidate.operation.deviceId === 'string' && typeof candidate.operation.proofKeyThumbprint === 'string'
    && typeof candidate.operation.ownerId === 'string' && typeof candidate.operation.channelRef === 'string'
    && !!candidate.matrixSession && typeof candidate.matrixSession === 'object'
    && Object.keys(candidate.matrixSession).sort().join(',') === 'accessToken,baseUrl,deviceId,ownerParticipantId,ownerUserId,roomId,userId'
    && Object.values(candidate.matrixSession).every(item => typeof item === 'string' && item.length > 0)
    && candidate.matrixSession.deviceId === candidate.operation.deviceId;
}
