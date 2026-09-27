import { createHash } from 'node:crypto';
import { decodeClosureRequest, type ClosureRequest, type ControlStore, type OwnerId } from '@khala/contracts/messaging/index';

type Document = Readonly<{ v: 1; ownerId: OwnerId; requests: readonly ClosureRequest[] }>;
const MAX_REQUESTS = 512;
const keyFor = (ownerId: OwnerId) => `channel-closure:cleanup:${createHash('sha256').update(ownerId).digest('hex')}`;

/** Owner-scoped metadata only. A request remains readable when a browser was offline at closure. */
export function createOwnerCleanupRequests(store: ControlStore, ownerId: OwnerId) {
  const key = keyFor(ownerId);
  function parse(value: unknown): Document | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    if (Object.keys(raw).sort().join(',') !== 'ownerId,requests,v' || raw.v !== 1 || raw.ownerId !== ownerId
      || !Array.isArray(raw.requests) || raw.requests.length > MAX_REQUESTS) return null;
    const rooms = new Set<string>();
    const operations = new Set<string>();
    const requests: ClosureRequest[] = [];
    for (const item of raw.requests) {
      const decoded = decodeClosureRequest(item);
      if (!decoded.ok || decoded.value.ownerId !== ownerId || decoded.value.expectedRoomRevision !== 0
        || rooms.has(decoded.value.roomId) || operations.has(decoded.value.operationId)) return null;
      rooms.add(decoded.value.roomId);
      operations.add(decoded.value.operationId);
      requests.push(decoded.value);
    }
    return { v: 1, ownerId, requests };
  }

  async function read() {
    const found = await store.read<Document>(key);
    if (found.kind === 'unavailable') return { kind: 'unavailable' as const };
    if (found.kind === 'absent') return { kind: 'ok' as const, document: { v: 1, ownerId, requests: [] } as Document, revision: null };
    const document = parse(found.record.value);
    return document ? { kind: 'ok' as const, document, revision: found.record.revision }
      : { kind: 'unavailable' as const };
  }

  return {
    async list(): Promise<Readonly<{ kind: 'ok'; requests: readonly ClosureRequest[] }> | Readonly<{ kind: 'unavailable' }>> {
      const current = await read();
      return current.kind === 'ok' ? { kind: 'ok', requests: current.document.requests } : current;
    },
    async record(request: ClosureRequest): Promise<'requested' | 'unavailable'> {
      const decoded = decodeClosureRequest(request);
      if (!decoded.ok || decoded.value.ownerId !== ownerId || decoded.value.expectedRoomRevision !== 0) return 'unavailable';
      for (let attempt = 0; attempt < 8; attempt++) {
        const current = await read();
        if (current.kind !== 'ok') return 'unavailable';
        const prior = current.document.requests.find(item => item.roomId === request.roomId || item.operationId === request.operationId);
        if (prior) return prior.roomId === request.roomId && prior.operationId === request.operationId
          && prior.expectedRoomRevision === request.expectedRoomRevision ? 'requested' : 'unavailable';
        if (current.document.requests.length >= MAX_REQUESTS) return 'unavailable';
        const next: Document = { ...current.document, requests: [...current.document.requests, decoded.value] };
        const operationId = `closure-cleanup:${createHash('sha256').update(JSON.stringify([key, current.revision, next])).digest('hex')}`;
        const written = await store.compareAndSet({ key, expectedRevision: current.revision, operationId,
          next: { value: next, expiresAt: null } });
        if (written.kind === 'applied') return 'requested';
        if (written.kind === 'unavailable' || written.kind === 'operation_mismatch') return 'unavailable';
        if (written.kind === 'outcome_unknown') {
          const observed = await read();
          return observed.kind === 'ok' && observed.document.requests.some(item => item.roomId === request.roomId
            && item.operationId === request.operationId && item.expectedRoomRevision === request.expectedRoomRevision)
            ? 'requested' : 'unavailable';
        }
      }
      return 'unavailable';
    },
  };
}
